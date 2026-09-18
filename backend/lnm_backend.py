#!/usr/bin/env python3
"""lnm_backend.py -- Degree-Adjusted Lesion Network Mapping (DA-LNM) engine.

Volumetric, degree-corrected lesion network mapping from the compact HCP-PTN
bundle built by prepare_connectome.py. Seed-to-voxel connectivity is a rank-D
(= ICA dimensionality) reconstruction: it keeps per-subject variance, so the
output is a genuine one-sample t-map across the connectome subjects (or a
group-average Fisher-z effect-size map), and the normative-connectome degree
is regressed out.

This module holds the Connectome class (compute) and the figure builders. It is
a pure importable module -- no CLI, no module-level defaults. Orchestration
(output file naming, thresholds, the JSON result contract) lives in
lnm_worker.py.

Adapted from DaLnm/DaLn_mapper.v.2.1.py.

Dependencies
------------
COMPUTE path (core install): numpy, nibabel, scipy. Nothing else. The MNI152
brain mask that bounds every output is read from the shipped
`ATLAS_DIR/mni152/mni152_brain_mask.nii.gz` (mni152-template module) rather
than fetched through `nilearn.datasets`.

FIGURE path (optional `reports-figures` module): nilearn + matplotlib. Every
entry point that needs them goes through `_plotting()`, which degrades with an
actionable message instead of raising ImportError -- see `routers/summary.py`
for the matching availability probe the UI uses.
"""
import io
import base64
import json
from pathlib import Path
import numpy as np
import nibabel as nib
from worker_common import resample_to_img


# --------------------------------------------------------------------------- #
#  Optional reports stack
# --------------------------------------------------------------------------- #
REPORTS_HINT = (
    "the report figure renderer is not installed. Install the "
    "'reports-figures' module (pip install -r backend/requirements-reports.txt) "
    "to enable nilearn/matplotlib figures.")


def _plotting():
    """`nilearn.plotting`, with matplotlib pinned to the Agg backend.

    Raises RuntimeError carrying REPORTS_HINT when the optional reports stack is
    absent, so callers surface a message a user can act on rather than an
    unhandled ImportError from deep inside a worker subprocess."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        from nilearn import plotting
    except ImportError as e:
        raise RuntimeError(f"Missing dependency: {e} — {REPORTS_HINT}") from e
    return plotting


def t_threshold(pval, df):
    """Derive a |t| threshold from an uncorrected two-tailed p-value."""
    from scipy.stats import t as _t
    return float(_t.isf(pval / 2.0, df))


def fdr_bh(pvals, alpha):
    """Benjamini-Hochberg FDR: returns a boolean mask of which p-values pass."""
    p = np.asarray(pvals)
    if p.size == 0:
        return np.zeros(0, bool)
    order = np.argsort(p)
    ranked = p[order] * p.size / (np.arange(p.size) + 1)
    passed = ranked <= alpha
    thresh = p[order][passed].max() if passed.any() else -1.0
    return p <= thresh


MNI152_BRAIN_MASK_REL = "mni152/mni152_brain_mask.nii.gz"

# Label atlases backing the LNM region tables, by registry id. Each is an
# independently installable atlas now, so either can be absent on its own and
# the table for it degrades to a message while the other still renders.
# `_missing_atlas_msg` names the specific one, because "install the core
# atlases module" stopped being actionable once atlases became individually
# removable.
LNM_LABEL_ATLASES = {
    "ho": "harvard_oxford_cort",
    "yeo": "yeo7",
}


def atlas_dir_path():
    """Absolute path to the installed atlas root (deps.ATLAS_DIR).

    `deps` is imported lazily: it pulls in FastAPI, which a compute worker has
    no other reason to load."""
    import deps
    return Path(deps.ATLAS_DIR)


def mni152_brain_mask_path():
    """Absolute path to the shipped MNI152 2 mm brain mask.

    Resolved through `deps.ATLAS_DIR`, so the env override / MODULE_ROOT /
    legacy-checkout tiers of `deps.module_path()` all apply and the file travels
    with the `mni152-template` module. `deps` is imported lazily: it pulls in
    FastAPI, which a compute worker has no other reason to load."""
    return atlas_dir_path() / MNI152_BRAIN_MASK_REL


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
        # normative degree = row-sum of the low-rank CORRELATION connectome
        dvar = np.clip(((self.A @ self.G) * self.A).sum(1), 1e-12, None)
        An = self.A / np.sqrt(dvar)[:, None]
        self._degree = An @ (self.G @ An.sum(0))
        self.coords = np.argwhere(self.mask).astype(np.float32)
        self._var_node = np.einsum("ndd->nd", self.covs)
        # MNI152 brain mask (intersected with the bundle mask) to bound outputs.
        #
        # This is on the COMPUTE path: `self.brain` bounds every LNM output, and
        # the fallback below silently widens the result to the whole bundle
        # mask. It used to come from `nilearn.datasets.load_mni152_brain_mask
        # (resolution=2)`; that exact image is now shipped as a file (identical
        # dtype/affine, byte-for-byte round trip), so the mask is unchanged —
        # verified by rebuilding `self.brain` both ways against the real
        # lnm_bundle_d100.npz: 235374/282299 voxels, np.array_equal == True.
        # Do NOT substitute a threshold of the MNI152 *template* here; that
        # would shift every LNM result without failing.
        self.brain = np.ones(self.A.shape[0], bool)
        try:
            bm = nib.load(str(mni152_brain_mask_path()))
            bm = resample_to_img(bm, self.ref, interpolation="nearest",
                                 force_resample=True, copy_header=True)
            self.brain = (np.asarray(bm.get_fdata()) > 0.5)[self.mask]
        except Exception as e:
            print(f"[warn] MNI brain mask unavailable, using full bundle mask: {e}")

    def _mask_brain(self, vec):
        return np.where(self.brain, np.asarray(vec), 0.0)

    # -- lesion -> boolean index within the brain mask --------------------------
    def _lesion_by_voxel_centres(self, img):
        """Forward-map every non-zero lesion voxel CENTRE into the connectome
        grid and mark the voxel it lands in.

        `resample_to_img(..., interpolation="nearest")` samples the other way
        round — for each 2 mm target voxel it asks "what is the source value at
        my centre?" — so a lesion thinner than the 2 mm target spacing can fall
        entirely between sample points and vanish. That is not hypothetical:
        a single-slice lesion drawn on this app's 0.74 mm MNI152 template
        (2100 voxels, centred well inside the brain) resampled to EXACTLY ZERO
        voxels, and LNM then rejected it as "not in MNI152 space".

        Forward mapping cannot lose a lesion that way: every source voxel
        contributes. Used only as a fallback (see _load_lesion), so lesions
        that already resample fine keep their existing, unchanged result.
        """
        data = np.asarray(img.dataobj)
        ijk = np.argwhere(data > 0)
        out = np.zeros(self.grid, bool)
        if ijk.size == 0:
            return out[self.mask]
        world = nib.affines.apply_affine(img.affine, ijk)
        inv = np.linalg.inv(self.affine)
        tgt = np.rint(nib.affines.apply_affine(inv, world)).astype(int)
        shape = np.array(self.grid)
        keep = np.all((tgt >= 0) & (tgt < shape), axis=1)
        tgt = tgt[keep]
        if len(tgt):
            out[tgt[:, 0], tgt[:, 1], tgt[:, 2]] = True
        return out[self.mask]

    def _load_lesion(self, lesion_path):
        img = nib.load(lesion_path)
        les = resample_to_img(img, self.ref,
                              interpolation="nearest",
                              force_resample=True, copy_header=True)
        idx = (np.asarray(les.get_fdata()) > 0.5)[self.mask]
        if idx.sum() == 0:
            # Thin/small lesions can be missed entirely by nearest-neighbour
            # downsampling — retry by forward-mapping voxel centres before
            # concluding the lesion is misplaced.
            idx = self._lesion_by_voxel_centres(img)
        if idx.sum() == 0:
            raise ValueError(
                "Lesion does not overlap the connectome brain mask after "
                "resampling. Check the lesion is in MNI152 space and correctly "
                "oriented.")
        return idx

    def _to_img(self, stat_vec):
        vol = np.zeros(self.grid, np.float32)
        vol[self.mask] = np.asarray(stat_vec, np.float32)
        return nib.Nifti1Image(vol, self.affine)

    def _maps_from_w(self, w):
        """Return (t_map, z_map): one-sample t and group-average Fisher-z (effect
        size) seed-to-voxel maps for seed loading vector w."""
        wS = np.einsum("d,ndc->nc", w, self.covs)
        var_seed = np.einsum("nc,c->n", wS, w)
        denom = np.sqrt(np.clip(var_seed[:, None] * self._var_node, 1e-12, None))
        zc = np.arctanh(np.clip(wS / denom, -0.999999, 0.999999))
        mean_z = zc.mean(0); Cz = np.cov(zc, rowvar=False)
        z_map = self.A @ mean_z                              # group-average Fisher-z
        var_map = ((self.A @ Cz) * self.A).sum(1)
        t_map = z_map / (np.sqrt(var_map / self.N) + 1e-12)  # one-sample t
        return t_map, z_map

    def _adjust(self, stat):
        deg = self._degree
        r_before = float(np.corrcoef(stat, deg)[0, 1])
        Xd = np.column_stack([np.ones_like(deg),
                              (deg - deg.mean()) / (deg.std() + 1e-12)])
        beta, *_ = np.linalg.lstsq(Xd, stat, rcond=None)
        corr = stat - Xd @ beta
        r_after = float(np.corrcoef(corr, deg)[0, 1])
        return corr, r_before, r_after

    def metric_from_w(self, w, degree_adjust, metric):
        t_map, z_map = self._maps_from_w(w)
        base = z_map if metric == "z" else t_map
        return self._adjust(base)[0] if degree_adjust else base

    def stat_for_indices(self, les_idx, degree_adjust, metric):
        w = self.A[les_idx].mean(0)
        t_map, z_map = self._maps_from_w(w)
        base = z_map if metric == "z" else t_map
        if degree_adjust:
            corr, rb, ra = self._adjust(base)
            return corr, base, rb, ra
        return base, base, float(np.corrcoef(base, self._degree)[0, 1]), None

    def random_lesion(self, vvox, pool_idx, rng):
        ci = pool_idx[rng.integers(pool_idx.size)]
        d2 = ((self.coords[pool_idx] - self.coords[ci]) ** 2).sum(1)
        k = min(vvox, pool_idx.size)
        take = pool_idx[np.argpartition(d2, k - 1)[:k]]
        m = np.zeros(self.A.shape[0], bool); m[take] = True
        return m

    def specificity(self, real_stat, vvox, degree_adjust, metric, tc, nperm,
                    pool_idx, alpha, use_fdr, rng, chunk=8, progress_cb=None):
        """Randomized-lesion permutation null. Volume-matched random lesions are
        drawn from pool_idx and their (optionally degree-adjusted) metric map is
        computed; the observed map is z-scored against this null, and voxels are
        retained if they both pass the raw threshold and beat the null at alpha
        (optionally BH-FDR corrected).

        Permutations are processed in chunks so each metric_from_w batch stays a
        single large BLAS call (float32 throughout) rather than nperm tiny ones.

        `progress_cb(done, total)` — optional; called once per chunk boundary
        with the number of permutations completed so a caller can report a live
        percentage. Purely a reporting hook: it does NOT touch the RNG draw
        order or the null accumulation, so results stay byte-identical whether
        or not it is supplied.
        """
        V = self.A.shape[0]
        null = np.empty((nperm, V), np.float32)
        for start in range(0, nperm, chunk):
            end = min(start + chunk, nperm)
            for i in range(start, end):
                m = self.random_lesion(vvox, pool_idx, rng)
                null[i] = self.metric_from_w(self.A[m].mean(0), degree_adjust, metric)
            if progress_cb is not None:
                try:
                    progress_cb(end, nperm)
                except Exception:  # noqa: BLE001 — reporting must never break compute
                    pass
        mean = null.mean(0); std = null.std(0) + 1e-12
        zmap = (real_stat - mean) / std
        p_pos = (1 + (null >= real_stat).sum(0)) / (nperm + 1)
        p_neg = (1 + (null <= real_stat).sum(0)) / (nperm + 1)
        supra_pos = real_stat >= tc; supra_neg = real_stat <= -tc
        if use_fdr:
            sig_pos = np.zeros(V, bool); sig_neg = np.zeros(V, bool)
            sig_pos[supra_pos] = fdr_bh(p_pos[supra_pos], alpha)
            sig_neg[supra_neg] = fdr_bh(p_neg[supra_neg], alpha)
        else:
            sig_pos = supra_pos & (p_pos < alpha)
            sig_neg = supra_neg & (p_neg < alpha)
        sig_pos &= self.brain; sig_neg &= self.brain
        return {"z": self._mask_brain(zmap), "sig_pos": sig_pos, "sig_neg": sig_neg,
                "n_sig_pos": int(sig_pos.sum()), "n_sig_neg": int(sig_neg.sum())}


def pool_indices(conn, sampling_mask_path=""):
    """Voxel-index pool from which random lesions are drawn (whole brain unless a
    sampling mask is supplied)."""
    if not sampling_mask_path:
        return np.flatnonzero(conn.brain)
    sm = resample_to_img(nib.load(sampling_mask_path), conn.ref,
                         interpolation="nearest", force_resample=True, copy_header=True)
    keep = ((np.asarray(sm.get_fdata()) > 0.5)[conn.mask]) & conn.brain
    idx = np.flatnonzero(keep)
    if idx.size == 0:
        raise ValueError("Sampling mask does not overlap the connectome brain mask.")
    return idx


# --------------------------------------------------------------------------- #
#  Atlas labelling
# --------------------------------------------------------------------------- #
def _as_img(x):
    return nib.load(x) if isinstance(x, str) else x


# Region labelling now reads the SHIPPED atlases (see LNM_LABEL_ATLASES above)
# instead of nilearn's `fetch_atlas_harvard_oxford` / `fetch_atlas_yeo_2011`
# downloaders. Those needed network access, so on an offline or packaged
# install they always failed and every LNM report showed the placeholder
# string below with no tables at all. The `<key>_err` contract the frontend
# renders (DaLnMapperPanel.jsx, lib/report/sections.js) is retained for the
# case where an atlas file is genuinely absent — e.g. the atlas module was
# never installed — so a missing atlas still degrades to a message rather
# than an exception.
def _missing_atlas_msg(key, atlas_id):
    return (f"region labelling unavailable: the '{atlas_id}' atlas is not "
            f"installed. Add it from the Atlas Manager to get the {key} table.")


def _load_label_atlas(spec_key):
    """((img, {label_int: name}), atlas_id) for a label atlas, or (None, id)."""
    import atlas_registry
    import atlas_labels

    atlas_id = LNM_LABEL_ATLASES[spec_key]
    d = atlas_registry.resolve(atlas_id)
    if d is None or not Path(d["volumePath"]).exists():
        return None, atlas_id
    names = atlas_labels.name_map(atlas_labels.read_labels_or_empty(d["labelsPath"]))
    if not names:
        return None, atlas_id
    return (nib.load(d["volumePath"]), names), atlas_id


def _label_table(img_names, ref_img, tail_mask, vmap, top):
    """Per-region rows for one tail: (name, voxels, % of tail, mean stat).

    The atlas is resampled ONTO the stat map's grid with nearest-neighbour, so
    label integers stay intact — the same convention worker_common.ho_overlap
    uses for the dissection reports."""
    img, names = img_names
    atlas_r = resample_to_img(img, ref_img, interpolation="nearest",
                              force_resample=True, copy_header=False)
    lab = np.asarray(atlas_r.dataobj).astype(int)
    if lab.ndim == 4:            # some atlases ship a singleton 4th dim
        lab = lab[..., 0]
    total = int(tail_mask.sum())
    rows = []
    for lid, name in sorted(names.items()):
        sel = tail_mask & (lab == lid)
        n = int(sel.sum())
        if n == 0:
            continue
        rows.append((name, n, 100.0 * n / max(total, 1), float(vmap[sel].mean())))
    rows.sort(key=lambda r: r[1], reverse=True)
    return rows[:top]


def region_tables(vmap_img, tc, top=10, use_atlases=True):
    """Positive/negative tail voxel counts of a (already thresholded/filtered)
    map, plus per-region Harvard-Oxford and Yeo-7 breakdowns.

    Rows are (name, voxels, % of tail, mean stat) — the shape lnm_worker.py's
    `_rows()` and the HTML/report builders already expect."""
    timg = _as_img(vmap_img)
    t = np.asarray(timg.get_fdata())
    pos, neg = t >= tc, t <= -tc
    tables = {"n_pos": int(pos.sum()), "n_neg": int(neg.sum())}
    if not use_atlases:
        return tables

    for key in ("ho", "yeo"):
        try:
            loaded, atlas_id = _load_label_atlas(key)
            if loaded is None:
                tables[f"{key}_err"] = _missing_atlas_msg(key, atlas_id)
                continue
            tables[f"{key}_pos"] = _label_table(loaded, timg, pos, t, top)
            tables[f"{key}_neg"] = _label_table(loaded, timg, neg, t, top)
        except Exception as e:  # noqa: BLE001 — labelling must never fail the run
            tables[f"{key}_err"] = f"region labelling failed: {e}"
    return tables


# --------------------------------------------------------------------------- #
#  MNI overlay -> base64 PNG
# --------------------------------------------------------------------------- #
def _mni_bg():
    """Glass-brain background. FIGURE-ONLY — never on the compute path, so it
    may keep using nilearn's template loader. Callers reach it only from inside
    the try blocks below, which turn a missing reports stack into an error
    string rather than an exception."""
    from nilearn.datasets import load_mni152_template
    try:
        return load_mni152_template(resolution=2)
    except TypeError:
        return load_mni152_template()


def _cut(lesion_path):
    try:
        plotting = _plotting()
        return plotting.find_xyz_cut_coords(nib.load(lesion_path)) if lesion_path else None
    except Exception:
        return None


def static_png(net_img, tc, title, lesion_path=None):
    """Static overlay: light background, sub-threshold voxels transparent."""
    try:
        plotting = _plotting()
        d = plotting.plot_stat_map(net_img, bg_img=_mni_bg(), threshold=tc,
                                   cut_coords=_cut(lesion_path), colorbar=True,
                                   draw_cross=False, black_bg=False, cmap="cold_hot",
                                   title=title)
        if lesion_path:
            try:
                d.add_contours(nib.load(lesion_path), levels=[0.5],
                               colors="lime", linewidths=1.5)
            except Exception:
                pass
        buf = io.BytesIO(); d.savefig(buf, dpi=120); d.close()
        return base64.b64encode(buf.getvalue()).decode(), None
    except Exception as e:
        return None, str(e)


def mosaic_png(net_img, tc, lesion_path=None, dpi=145):
    """Light multi-slice mosaic (all three planes) -- fallback if the viewer fails."""
    try:
        plotting = _plotting()
        d = plotting.plot_stat_map(net_img, bg_img=_mni_bg(), threshold=tc,
                                   display_mode="mosaic", colorbar=True,
                                   black_bg=False, cmap="cold_hot")
        if lesion_path:
            try:
                d.add_contours(nib.load(lesion_path), levels=[0.5],
                               colors="lime", linewidths=1.2)
            except Exception:
                pass
        buf = io.BytesIO(); d.savefig(buf, dpi=dpi); d.close()
        return base64.b64encode(buf.getvalue()).decode(), None
    except Exception as e:
        return None, str(e)


def interactive_html(net_img, tc, lesion_path=None):
    """Interactive, scrollable MNI viewer (scroll slices, drag, hover values)."""
    try:
        plotting = _plotting()
        view = plotting.view_img(net_img, bg_img=_mni_bg(), threshold=float(tc),
                                 cmap="cold_hot", symmetric_cmap=True, colorbar=True,
                                 black_bg=False, opacity=0.9, cut_coords=_cut(lesion_path))
        return view.get_iframe(), None
    except Exception as e:
        return None, str(e)
