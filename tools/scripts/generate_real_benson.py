"""
Generate MNI152-volume retinotopic atlases from fsaverage SURFACE files.
v2 — KD-tree gray-matter-constrained fill so the cortical ribbon is dense
and non-patchy.

Pipeline:
  1. Sample each fsaverage vertex at 11 depths (white → pial) and add 3
     barycentric samples per face (random within each triangle, then
     interpolate depths). This expands ~163k verts → ~3M point samples per
     hemisphere.
  2. Build a gray-matter mask from MNI152 (intensity ~30-100 ≈ GM range).
  3. For every GM-mask voxel, find the K nearest point samples within
     RADIUS_MM. Aggregate:
       continuous (angle, eccen) : weighted mean (1/dist) over K neighbours
       categorical (varea, wang) : majority vote
     If no samples are within radius, voxel stays 0.

Result: every cortical voxel inside the GM mask that has any source vertex
within ~3 mm gets filled, eliminating the patchy 1-voxel-deep look.
"""

import os
import json
import numpy as np
import nibabel as nib
from scipy.spatial import cKDTree
from nilearn.datasets import fetch_surf_fsaverage

ATLAS_DIR = "data/modules/atlases"
MNI_PATH = os.path.join(ATLAS_DIR, "mni152", "mni152.nii.gz")
REPORT_PATH = "/app/scripts/benson_validation_report.txt"

# Sampling controls
N_DEPTH = 11                  # samples along WM→pial line per vertex
N_FACE_SUBSAMPLES = 3         # extra barycentric samples per face
GM_INTENSITY_LO = 25          # MNI152 GM intensity window (template is 0..100ish)
GM_INTENSITY_HI = 95
RADIUS_MM = 3.0               # KD-tree neighbour radius
N_NEIGHBOURS_CONTINUOUS = 4   # max points per voxel when averaging
N_NEIGHBOURS_CATEGORICAL = 8  # max points per voxel for majority vote

# Wang 2015 ROI lookup (Kastner Lab maxprob)
WANG_LABELS = {
    1: "V1v", 2: "V1d", 3: "V2v", 4: "V2d", 5: "V3v", 6: "V3d",
    7: "hV4", 8: "VO1", 9: "VO2", 10: "PHC1", 11: "PHC2",
    12: "TO2", 13: "TO1", 14: "LO2", 15: "LO1",
    16: "V3B", 17: "V3A", 18: "IPS0", 19: "IPS1", 20: "IPS2",
    21: "IPS3", 22: "IPS4", 23: "IPS5", 24: "SPL1", 25: "FEF",
}


def load_surface(path):
    g = nib.load(path)
    verts = g.darrays[0].data.astype(np.float32)
    faces = g.darrays[1].data.astype(np.int32) if len(g.darrays) > 1 else None
    return verts, faces


def load_mgz_scalars(path):
    img = nib.load(path)
    return np.asarray(img.dataobj).squeeze().astype(np.float32)


def build_dense_point_cloud(white_mm, pial_mm, faces, values,
                            n_depth=N_DEPTH, n_face=N_FACE_SUBSAMPLES,
                            categorical=False):
    """Return (points Nx3 mm, values N,) sampled densely across cortical ribbon.

    For each face triangle, sample n_face random barycentric points and
    interpolate vertex coordinates + values. For each such point, expand
    to n_depth points along WM→pial line.
    """
    rng = np.random.default_rng(42)
    # Vertex-only samples (anchor points)
    nv = white_mm.shape[0]
    depth_ts = np.linspace(0.0, 1.0, n_depth, dtype=np.float32)
    points_v = []
    values_v = []
    for t in depth_ts:
        p = white_mm + t * (pial_mm - white_mm)
        points_v.append(p)
        values_v.append(values)
    points_v = np.concatenate(points_v, axis=0)
    values_v = np.concatenate(values_v, axis=0)

    # Face barycentric subsamples
    if faces is not None and n_face > 0:
        # n_face random barycentric weights per face (shape: n_face × 3)
        w = rng.dirichlet([1, 1, 1], size=(n_face, faces.shape[0])).astype(np.float32)
        # w[k, f, 0..2] sums to 1
        v0 = faces[:, 0]
        v1 = faces[:, 1]
        v2 = faces[:, 2]
        # Interpolate WM and pial separately
        points_f = []
        values_f = []
        for k in range(n_face):
            wk = w[k]              # (F, 3)
            wm_f = (wk[:, [0]] * white_mm[v0] +
                    wk[:, [1]] * white_mm[v1] +
                    wk[:, [2]] * white_mm[v2])
            pl_f = (wk[:, [0]] * pial_mm[v0] +
                    wk[:, [1]] * pial_mm[v1] +
                    wk[:, [2]] * pial_mm[v2])
            if categorical:
                # majority of the three vertex labels at this barycentric point
                v_stack = np.stack([values[v0], values[v1], values[v2]], axis=-1)
                # pick max-weight vertex (largest barycentric coord)
                amax = wk.argmax(axis=-1)
                val_f = v_stack[np.arange(v_stack.shape[0]), amax]
            else:
                val_f = (wk[:, 0] * values[v0] +
                         wk[:, 1] * values[v1] +
                         wk[:, 2] * values[v2])
            for t in depth_ts:
                points_f.append(wm_f + t * (pl_f - wm_f))
                values_f.append(val_f)
        if points_f:
            points_f = np.concatenate(points_f, axis=0)
            values_f = np.concatenate(values_f, axis=0)
            points_v = np.concatenate([points_v, points_f], axis=0)
            values_v = np.concatenate([values_v, values_f], axis=0)

    # Drop samples with zero / NaN values (Benson uses 0 for non-visual cortex)
    if categorical:
        valid = (values_v > 0)
    else:
        valid = np.isfinite(values_v) & (values_v != 0)
    return points_v[valid].astype(np.float32), values_v[valid]


def build_gm_mask(mni_data, lo=GM_INTENSITY_LO, hi=GM_INTENSITY_HI):
    """MNI152 GM mask from intensity window + light morphology."""
    from scipy.ndimage import binary_opening, binary_closing
    m = (mni_data >= lo) & (mni_data <= hi)
    m = binary_opening(m, iterations=1)
    m = binary_closing(m, iterations=2)
    return m


def voxel_centres_mm(mask, affine):
    """Return (N, 3) mm positions of every True voxel."""
    ii, jj, kk = np.where(mask)
    ijk = np.stack([ii, jj, kk, np.ones_like(ii)], axis=-1).astype(np.float32)
    mm = ijk @ affine.T
    return mm[:, :3], ii, jj, kk


def project_via_kdtree(points_mm, values, mask, affine, mni_shape,
                       *, categorical=False, radius=RADIUS_MM):
    """Fill GM-mask voxels using KD-tree nearest-neighbour lookup."""
    mm, ii, jj, kk = voxel_centres_mm(mask, affine)
    tree = cKDTree(points_mm)
    out = np.zeros(mni_shape, dtype=(np.int16 if categorical else np.float32))
    K = N_NEIGHBOURS_CATEGORICAL if categorical else N_NEIGHBOURS_CONTINUOUS
    dists, idxs = tree.query(mm, k=K, distance_upper_bound=radius, workers=-1)
    if K == 1:
        dists = dists[:, None]
        idxs = idxs[:, None]
    # For voxels with no neighbour within radius, dist is inf and idx is len(points)
    n_pts = len(points_mm)
    valid_any = (dists[:, 0] < np.inf)
    print(f"    {valid_any.sum():,} / {len(mm):,} GM voxels have ≥1 sample within {radius} mm")
    if categorical:
        # Majority vote among neighbours within radius
        for r in np.where(valid_any)[0]:
            d = dists[r]
            i = idxs[r]
            mask_r = (d < np.inf) & (i < n_pts)
            if not mask_r.any():
                continue
            cands = values[i[mask_r]].astype(np.int32)
            uniq, counts = np.unique(cands, return_counts=True)
            out[ii[r], jj[r], kk[r]] = uniq[counts.argmax()]
    else:
        # Inverse-distance weighted mean
        d = dists.copy()
        i = idxs.copy()
        m = (d < np.inf) & (i < n_pts)
        d_safe = np.where(m, d, 1.0)
        w = np.where(m, 1.0 / np.maximum(d_safe, 1e-3), 0.0)
        v = np.where(m, values[np.where(m, i, 0)], 0.0).astype(np.float32)
        wsum = w.sum(axis=1)
        vsum = (w * v).sum(axis=1)
        with np.errstate(invalid="ignore", divide="ignore"):
            agg = np.where(wsum > 0, vsum / wsum, 0.0).astype(np.float32)
        out[ii, jj, kk] = agg
    return out


def merge_hemispheres(vol_lh, vol_rh, categorical):
    if categorical:
        combined = vol_lh.copy()
        m = (combined == 0) & (vol_rh != 0)
        combined[m] = vol_rh[m]
        return combined
    sum_v = vol_lh.astype(np.float64) + vol_rh.astype(np.float64)
    cnt = (vol_lh != 0).astype(np.int32) + (vol_rh != 0).astype(np.int32)
    out = np.zeros_like(vol_lh)
    nz = cnt > 0
    out[nz] = (sum_v[nz] / cnt[nz]).astype(np.float32)
    return out


def save_nifti(arr, affine, path, dtype=None):
    if dtype is not None:
        arr = arr.astype(dtype)
    nib.save(nib.Nifti1Image(arr, affine), path)


def main():
    print("Loading MNI152 grid…")
    mni = nib.load(MNI_PATH)
    aff = mni.affine
    shape = mni.shape
    mni_data = mni.get_fdata().astype(np.float32)
    print(f"  shape={shape}  voxel={np.abs(np.diag(aff))[:3]}  intensity range={mni_data.min():.1f}..{mni_data.max():.1f}")

    print("\nBuilding MNI152 gray-matter mask…")
    gm = build_gm_mask(mni_data)
    print(f"  GM voxels: {int(gm.sum()):,}")

    print("\nFetching fsaverage surfaces…")
    fs = fetch_surf_fsaverage("fsaverage")
    pial_lh, faces_lh = load_surface(fs.pial_left)
    pial_rh, faces_rh = load_surface(fs.pial_right)
    white_lh, _ = load_surface(fs.white_left)
    white_rh, _ = load_surface(fs.white_right)
    print(f"  LH: {len(pial_lh):,} verts, {len(faces_lh):,} faces · RH: {len(pial_rh):,} verts, {len(faces_rh):,} faces")

    report = ["MRLatte Benson/Wang 2015 atlas regeneration — v2 KD-tree fill",
              "================================================================",
              f"Sampling: {N_DEPTH} depths × ({1 + N_FACE_SUBSAMPLES}× face-barycentric expansion)",
              f"GM mask: MNI152 intensity {GM_INTENSITY_LO}–{GM_INTENSITY_HI}, opened+closed",
              f"KD-tree radius: {RADIUS_MM} mm",
              ""]

    def do_one(label_kind, family, name_in, fname_out, categorical, expected_desc,
               expected_check=None):
        # `family` is the atlas-family subfolder under ATLAS_DIR that holds both
        # the lh./rh. surface sources and the projected volume.
        print(f"\n== {family}/{fname_out} ==")
        os.makedirs(f"{ATLAS_DIR}/{family}", exist_ok=True)
        lh = load_mgz_scalars(f"{ATLAS_DIR}/{family}/lh.{name_in}.mgz")
        rh = load_mgz_scalars(f"{ATLAS_DIR}/{family}/rh.{name_in}.mgz")
        print(f"  source LH non-zero: {int((lh != 0).sum()):,}  RH non-zero: {int((rh != 0).sum()):,}")
        print("  building dense LH point cloud…")
        pts_lh, val_lh = build_dense_point_cloud(white_lh, pial_lh, faces_lh, lh, categorical=categorical)
        print(f"    {len(pts_lh):,} samples")
        print("  KD-tree fill LH…")
        v_lh = project_via_kdtree(pts_lh, val_lh, gm, aff, shape, categorical=categorical)
        print("  building dense RH point cloud…")
        pts_rh, val_rh = build_dense_point_cloud(white_rh, pial_rh, faces_rh, rh, categorical=categorical)
        print(f"    {len(pts_rh):,} samples")
        print("  KD-tree fill RH…")
        v_rh = project_via_kdtree(pts_rh, val_rh, gm, aff, shape, categorical=categorical)
        out = merge_hemispheres(v_lh, v_rh, categorical=categorical)
        save_nifti(out, aff, f"{ATLAS_DIR}/{family}/{fname_out}",
                   dtype=(np.int16 if categorical else np.float32))

        nz = out[out != 0]
        if categorical:
            uniq, counts = np.unique(out, return_counts=True)
            d = {int(u): int(c) for u, c in zip(uniq, counts) if u > 0}
            report.append(f"{fname_out}:")
            report.append(f"  expected: {expected_desc}")
            report.append(f"  produced labels (n=voxels): {d}")
            report.append(f"  total non-zero voxels: {sum(d.values()):,}")
        else:
            report.append(f"{fname_out}:")
            report.append(f"  expected: {expected_desc}")
            if nz.size:
                report.append(f"  produced range: {nz.min():.2f}–{nz.max():.2f}")
                report.append(f"  produced mean: {nz.mean():.2f}")
                report.append(f"  non-zero voxels: {nz.size:,}")
            else:
                report.append("  produced: EMPTY (!)")
        report.append("")

    # Continuous maps
    do_one("polar_angle", "benson14", "benson14_angle.v4_0", "benson14_polar_angle.nii.gz",
           categorical=False, expected_desc="0–180° per hemisphere (Benson 2014)")
    do_one("eccentricity", "benson14", "benson14_eccen.v4_0", "benson14_eccentricity.nii.gz",
           categorical=False, expected_desc="0–90° visual angle (Benson 2014)")
    # Categorical maps
    do_one("visual_areas", "benson14", "benson14_varea.v4_0", "benson14_visual_areas.nii.gz",
           categorical=True,
           expected_desc="12 labels: 1..12 = V1/V2/V3/hV4/VO1/VO2/LO1/LO2/TO1/TO2/V3b/V3a (Benson 2014)")
    do_one("wang2015", "wang2015", "wang15_mplbl.v1_0", "wang2015_maxprob.nii.gz",
           categorical=True,
           expected_desc="25 labels (Kastner Lab Wang 2015 max-prob)")

    # Soft prob = 6-mm gaussian on Wang binary mask
    print("\n== wang2015/wang2015_prob.nii.gz (smoothed binary surrogate) ==")
    from scipy.ndimage import gaussian_filter
    wp = nib.load(f"{ATLAS_DIR}/wang2015/wang2015_maxprob.nii.gz").get_fdata()
    prob = gaussian_filter((wp != 0).astype(np.float32), sigma=2.0)
    save_nifti(prob, aff, f"{ATLAS_DIR}/wang2015/wang2015_prob.nii.gz", dtype=np.float32)
    report.append("wang2015_prob.nii.gz: gaussian-smoothed binary mask of Wang max-prob")

    # Labels JSON
    with open(os.path.join(ATLAS_DIR, "wang2015", "wang2015_labels.json"), "w") as f:
        json.dump({str(k): v for k, v in WANG_LABELS.items()}, f, indent=2)

    with open(REPORT_PATH, "w") as f:
        f.write("\n".join(report))
    print(f"\nValidation report → {REPORT_PATH}")


if __name__ == "__main__":
    main()
