#!/usr/bin/env python3
"""
lnm_backend.py  --  runtime.

Volumetric, degree-corrected lesion network mapping from the compact bundle built
by prepare_connectome.py. Seed-to-voxel connectivity is a rank-D (= ICA
dimensionality) reconstruction: it keeps per-subject variance, so the output is a
genuine one-sample t-map across the connectome subjects (threshold it like a
classic LNM map), and the normative-connectome degree is regressed out.

Programmatic use:
    from lnm_backend import Connectome
    c = Connectome("lnm_bundle_d100.npz")          # load once (reuse across calls)
    res = c.compute("lesion_MNI.nii.gz", out_path="lnm_tmap.nii.gz")
    print(res["degree_corr_before"], res["degree_corr_after"])

CLI:
    python lnm_backend.py --bundle lnm_bundle_d100.npz --lesion lesion.nii.gz --out tmap.nii.gz

Dependencies:  numpy, nibabel, nilearn   (pip install numpy nibabel nilearn)
"""
import numpy as np
import nibabel as nib
from nilearn.image import resample_to_img

# --- EDIT THESE if you just want to press Run (no command-line needed) ------- #
DEFAULT_BUNDLE = r"Z:\HCP unzipped\HCP1200_Parcellation_Timeseries_Netmats\HCP_PTN1200\lnm_bundle_d100.npz"
DEFAULT_LESION = r"Z:\Global Workspace\DaLnm\Therasa_294069P.nii"
DEFAULT_OUT    = r"Z:\Global Workspace\DaLnm\Therasa_lnm_tmap.nii.gz"
DEFAULT_MASK   = r"Z:\Global Workspace\DaLnm\Therasa_network_mask.nii.gz"
DEFAULT_THRESHOLD = 7.0
# ---------------------------------------------------------------------------- #


class Connectome:
    def __init__(self, bundle_path):
        z = np.load(bundle_path)
        self.A = z["A"]                 # V x D : component maps at brain voxels
        self.mask = z["mask"]           # X,Y,Z bool
        self.affine = z["affine"]
        self.grid = tuple(int(g) for g in z["grid"])
        self.covs = z["covs"]           # N x D x D : per-subject covariance
        self.G = z["G"]                 # D x D     : group covariance
        self.D = int(z["dim"])
        self.N = self.covs.shape[0]
        self.ref = nib.Nifti1Image(self.mask.astype(np.float32), self.affine)
        # seed-independent weighted degree of the low-rank connectome C = A G A^T
        self._degree = self.A @ (self.G @ self.A.sum(0))     # V,

    # -- lesion -> boolean index within the brain mask --------------------------
    def _load_lesion(self, lesion_path):
        les = resample_to_img(nib.load(lesion_path), self.ref,
                              interpolation="nearest",
                              force_resample=True, copy_header=True)
        m = np.asarray(les.get_fdata()) > 0.5
        idx = m[self.mask]
        if idx.sum() == 0:
            raise ValueError(
                "Lesion does not overlap the connectome brain mask after "
                "resampling. Check the lesion is in MNI152 space and correctly "
                "oriented.")
        return idx

    # -- main entry -------------------------------------------------------------
    def compute(self, lesion_path, out_path=None, tmap=True):
        les_idx = self._load_lesion(lesion_path)
        w = self.A[les_idx].mean(0)                     # D, seed loading vector
        # (alternative seed: least-squares spatial regression of the lesion mask
        #  onto A; mean-overlap is used here for robustness to small lesions.)

        # per-subject seed->node correlation from covariance algebra only
        wS = np.einsum("d,ndc->nc", w, self.covs)       # N x D : w^T Sigma_i
        var_seed = np.einsum("nc,c->n", wS, w)          # N,    : w^T Sigma_i w
        var_node = np.einsum("ndd->nd", self.covs)      # N x D : diag(Sigma_i)
        denom = np.sqrt(np.clip(var_seed[:, None] * var_node, 1e-12, None))
        r = wS / denom                                  # N x D
        zc = np.arctanh(np.clip(r, -0.999999, 0.999999))  # Fisher-z, N x D

        # voxelwise across-subject stats via low-rank identities (no N x V array):
        #   per-subject map_i(v) = A(v,:) . z_i
        #   mean_v  = A . mean_z ;  var_v = diag(A Cz A^T)
        mean_z = zc.mean(0)                              # D,
        Cz = np.cov(zc, rowvar=False)                    # D x D (ddof=1)
        mean_map = self.A @ mean_z                       # V,
        var_map = ((self.A @ Cz) * self.A).sum(1)        # V,
        stat = (mean_map / (np.sqrt(var_map / self.N) + 1e-12)
                if tmap else mean_map)                   # t-map or mean Fisher-z

        # degree correction: residualize the map on [1, degree]
        deg = self._degree
        r_before = float(np.corrcoef(stat, deg)[0, 1])
        Xd = np.column_stack([np.ones_like(deg),
                              (deg - deg.mean()) / (deg.std() + 1e-12)])
        beta, *_ = np.linalg.lstsq(Xd, stat, rcond=None)
        stat_corr = stat - Xd @ beta
        r_after = float(np.corrcoef(stat_corr, deg)[0, 1])

        vol = np.zeros(self.grid, np.float32)
        vol[self.mask] = stat_corr.astype(np.float32)
        img = nib.Nifti1Image(vol, self.affine)
        if out_path:
            nib.save(img, out_path)
        return {"img": img,
                "n_lesion_voxels": int(les_idx.sum()),
                "degree_corr_before": r_before,
                "degree_corr_after": r_after,
                "raw_stat": stat, "corrected_stat": stat_corr}


# --------------------------------------------------------------------------- #
#  Network summary: threshold -> signed mask + atlas labelling
#  (atlases are fetched by nilearn on first use and cached in ~/nilearn_data;
#   needs internet once. Use use_atlases=False / --no-atlas to skip downloads.)
# --------------------------------------------------------------------------- #
def _as_img(x):
    return nib.load(x) if isinstance(x, str) else x


def _resample_labels(atlas_img, ref_img):
    a = resample_to_img(_as_img(atlas_img), ref_img, interpolation="nearest",
                        force_resample=True, copy_header=True)
    d = np.asarray(a.get_fdata())
    return (d[..., 0] if d.ndim == 4 else d).astype(int)


def _harvard_oxford(ref_img):
    """Combined cortical+subcortical HO labels on ref grid -> (vol, {idx:name})."""
    from nilearn import datasets
    cort = datasets.fetch_atlas_harvard_oxford("cort-maxprob-thr25-2mm")
    sub = datasets.fetch_atlas_harvard_oxford("sub-maxprob-thr25-2mm")
    c, s = _resample_labels(cort.maps, ref_img), _resample_labels(sub.maps, ref_img)
    names, vol = {}, np.zeros(c.shape, int)
    for i, l in enumerate(cort.labels):
        if i:
            names[i] = l
    vol[c > 0] = c[c > 0]
    off = len(cort.labels)
    skip = ("Cerebral Cortex", "White Matter", "Lateral Ventric")   # non-specific
    for i, l in enumerate(sub.labels):
        if i and not any(k in l for k in skip):
            names[off + i] = l
    fill = (vol == 0) & (s > 0)
    vol[fill] = off + s[fill]
    return vol, names


def _yeo7(ref_img):
    from nilearn import datasets
    y = datasets.fetch_atlas_yeo_2011()
    img = getattr(y, "thick_7", None) or (y["thick_7"] if "thick_7" in y else y.maps)
    names = {1: "Visual", 2: "Somatomotor", 3: "DorsalAttention",
             4: "VentralAttention", 5: "Limbic", 6: "Frontoparietal", 7: "Default"}
    return _resample_labels(img, ref_img), names


def _table(label_vol, names, tail_mask, tmap, top):
    vals, tv = label_vol[tail_mask], tmap[tail_mask]
    total = max(int(tail_mask.sum()), 1)
    rows = []
    for idx in np.unique(vals):
        if idx <= 0 or idx not in names:
            continue
        sel = vals == idx
        rows.append((names[idx], int(sel.sum()),
                     100.0 * int(sel.sum()) / total, float(tv[sel].mean())))
    rows.sort(key=lambda r: -r[1])
    return rows[:top]


def summarize_network(tmap, threshold=7.0, mask_out=None, top=10,
                      use_atlases=True, verbose=True):
    """Threshold a t-map, optionally save a signed (+1/-1) binary mask, and label
    the positive (coupled) and negative (anticorrelated) networks by atlas region.
    Returns a dict; prints a readable summary when verbose."""
    timg = _as_img(tmap)
    t = np.asarray(timg.get_fdata())
    pos, neg = t >= threshold, t <= -threshold

    if mask_out:
        sm = np.zeros(t.shape, np.int8)
        sm[pos], sm[neg] = 1, -1
        nib.save(nib.Nifti1Image(sm, timg.affine), mask_out)

    out = {"threshold": float(threshold), "n_pos": int(pos.sum()),
           "n_neg": int(neg.sum()), "mask_out": mask_out}
    if verbose:
        print(f"\n=== network summary @ |t| >= {threshold} ===")
        print(f"positive (coupled) voxels : {out['n_pos']:>7}")
        print(f"negative (anticorr) voxels: {out['n_neg']:>7}")
        if mask_out:
            print(f"signed mask saved         : {mask_out}")

    if not use_atlases:
        return out

    def run(loader, label, cols, ntop):
        try:
            vol, names = loader(timg)
        except Exception as e:
            print(f"  [atlas] {label} skipped: {e}")
            return
        for tail, m in (("positive", pos), ("negative", neg)):
            if not m.any():
                continue
            tbl = _table(vol, names, m, t, ntop)
            out[f"{label.lower().replace('-', '')}_{tail}"] = tbl
            if verbose:
                print(f"\n  {label} - {tail} network  ({cols}):")
                for nm, n, pct, mt in tbl:
                    print(f"    {nm[:38]:38s} {n:6d}  {pct:5.1f}%  {mt:+.2f}")

    run(_harvard_oxford, "Harvard-Oxford", "region | voxels | % | mean t", top)
    run(_yeo7, "Yeo-7", "network | voxels | % | mean t", 7)
    return out


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=DEFAULT_BUNDLE)
    ap.add_argument("--lesion", default=DEFAULT_LESION)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--mean", action="store_true",
                    help="output mean Fisher-z instead of the t-map")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                    help="|t| threshold for the network summary / mask")
    ap.add_argument("--mask-out", default=DEFAULT_MASK,
                    help="save a signed binary network mask (+1 coupled / -1 anti)")
    ap.add_argument("--top", type=int, default=10, help="regions listed per tail")
    ap.add_argument("--no-atlas", action="store_true",
                    help="skip atlas labelling (avoids first-run downloads)")
    a = ap.parse_args()

    res = Connectome(a.bundle).compute(a.lesion, a.out, tmap=not a.mean)
    print(f"lesion voxels           : {res['n_lesion_voxels']}")
    print(f"degree r before -> after: "
          f"{res['degree_corr_before']:.3f} -> {res['degree_corr_after']:.3f}")
    print(f"saved                   : {a.out}")

    if not a.mean:      # atlas summary is meaningful for the t-map
        summarize_network(res["img"], threshold=a.threshold,
                          mask_out=a.mask_out, top=a.top,
                          use_atlases=not a.no_atlas)
