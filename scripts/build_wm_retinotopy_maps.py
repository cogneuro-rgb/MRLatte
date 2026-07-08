#!/usr/bin/env python3
"""Rasterize the brainlife "Retinotopic Connectivity Template" streamlines into
MNI white-matter retinotopy NIfTI maps that NeuroVue's existing lesion pipeline
can consume directly.

Why this exists
---------------
NeuroVue already predicts visual-field involvement for lesions in *visual cortex*
by intersecting a lesion mask with the Benson 2014 retinotopy atlas (polar angle
/ eccentricity) in MNI space (see frontend/src/lib/retinotopyAnalysis.js). A
lesion in *occipital white matter* can cause the same defect without touching
cortex. This script turns the population tractogram from

    Amorosino, Caron, ... Pestilli, "A retinotopic wiring principle of the human
    brain" — Retinotopic Connectivity Template, DOI 10.25663/brainlife.pub.67
    (CC-BY).

into the *same kind* of voxel-wise MNI maps the cortical pipeline already eats:

    wm_polar_angle.nii.gz   per-voxel polar angle 1..360 (0 = background)
    wm_eccentricity.nii.gz  per-voxel eccentricity  0..90 (0 = background)

Each white-matter voxel is labeled with the retinotopic coordinate of the cortical
endpoint of the fibers passing through it. This re-derives the retinotopic label
from the *already-present* Benson atlas rather than depending on the template's
internal labeling format (which is an open item until the dataset is downloaded —
see README / plan). It mirrors the paper's own method: streamlines are assigned
to retinotopic ROIs by *endpoint inclusion* in the Benson atlas in MNI space.

Polar-angle convention (must match the cortical maps so classifyHemifield works):
    LH cortex  -> 1..180   (patient's RIGHT visual hemifield)
    RH cortex  -> 181..360 (patient's LEFT  visual hemifield)
The merged 1..360 space is NOT circular across the 180/181 hemifield boundary, so
we compute the per-voxel polar value as a *within-hemifield linear mean* after a
per-voxel hemifield vote — never a circular mean across the boundary.

Output framing: this is an anatomical/illustrative population-template overlay,
NOT a validated clinical prediction.

Usage
-----
    python scripts/build_wm_retinotopy_maps.py \
        --tractogram /path/to/retinotopic_connectivity_template.tck \
        [--reference   frontend/public/atlases/benson14_polar_angle.nii.gz] \
        [--benson-polar frontend/public/atlases/benson14_polar_angle.nii.gz] \
        [--benson-eccen frontend/public/atlases/benson14_eccentricity.nii.gz] \
        [--out-dir      frontend/public/atlases] \
        [--min-support  1]

The template streamlines are assumed to live in MNI (RASMM world) space, matching
the Benson atlases. `.tck` files carry no affine of their own, so nibabel returns
them already in RASMM world coordinates; `.trk` files carry their own affine.
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import nibabel as nib

try:
    # Only used for robust, even densification of streamlines.
    from dipy.tracking.streamline import set_number_of_points
    _HAVE_DIPY = True
except Exception:  # pragma: no cover - dipy optional
    _HAVE_DIPY = False


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ATLAS_DIR = os.path.join(REPO_ROOT, "frontend", "public", "atlases")


def _default(*parts: str) -> str:
    return os.path.join(ATLAS_DIR, *parts)


def world_to_vox_affine(img: nib.Nifti1Image) -> np.ndarray:
    """Inverse of the voxel->world (RASMM) affine."""
    return np.linalg.inv(img.affine)


def sample_at_voxels(data: np.ndarray, vox: np.ndarray) -> np.ndarray:
    """Nearest-neighbour sample of `data` at integer voxel coords `vox` (N,3).
    Out-of-bounds samples return 0."""
    shape = data.shape
    v = np.rint(vox).astype(np.int64)
    inb = (
        (v[:, 0] >= 0) & (v[:, 0] < shape[0]) &
        (v[:, 1] >= 0) & (v[:, 1] < shape[1]) &
        (v[:, 2] >= 0) & (v[:, 2] < shape[2])
    )
    out = np.zeros(v.shape[0], dtype=data.dtype)
    vi = v[inb]
    out[inb] = data[vi[:, 0], vi[:, 1], vi[:, 2]]
    return out, inb


def nearest_nonzero_endpoint_value(scalar: np.ndarray, pts_vox: np.ndarray) -> float:
    """Return the scalar atlas value at the first point (scanning inward from the
    streamline tip) that lands on a nonzero (cortical) voxel. 0 if none."""
    shape = scalar.shape
    for p in pts_vox:
        i, j, k = int(round(p[0])), int(round(p[1])), int(round(p[2]))
        if 0 <= i < shape[0] and 0 <= j < shape[1] and 0 <= k < shape[2]:
            val = scalar[i, j, k]
            if val > 0:
                return float(val)
    return 0.0


def densify(points: np.ndarray, n: int) -> np.ndarray:
    """Resample a streamline (M,3) to n evenly spaced points."""
    if _HAVE_DIPY:
        return set_number_of_points(points.astype(np.float64), n)
    # Fallback: linear arc-length resampling.
    seg = np.linalg.norm(np.diff(points, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = cum[-1]
    if total == 0:
        return np.repeat(points[:1], n, axis=0)
    targets = np.linspace(0.0, total, n)
    out = np.empty((n, 3), dtype=np.float64)
    for d in range(3):
        out[:, d] = np.interp(targets, cum, points[:, d])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tractogram", required=True,
                    help="Template streamlines (.tck/.trk/.trk.gz) in MNI RASMM space.")
    ap.add_argument("--reference", default=_default("benson14_polar_angle.nii.gz"),
                    help="NIfTI defining the output grid+affine (default: Benson polar atlas).")
    ap.add_argument("--benson-polar", default=_default("benson14_polar_angle.nii.gz"))
    ap.add_argument("--benson-eccen", default=_default("benson14_eccentricity.nii.gz"))
    ap.add_argument("--out-dir", default=ATLAS_DIR)
    ap.add_argument("--min-support", type=int, default=1,
                    help="Keep a voxel only if at least this many streamline samples touch it.")
    ap.add_argument("--samples-per-vox", type=float, default=2.0,
                    help="Densification rate (points per voxel of streamline length).")
    args = ap.parse_args()

    ref = nib.load(args.reference)
    polar_img = nib.load(args.benson_polar)
    eccen_img = nib.load(args.benson_eccen)
    polar_data = np.asarray(polar_img.dataobj).astype(np.float32)
    eccen_data = np.asarray(eccen_img.dataobj).astype(np.float32)

    shape = ref.shape[:3]
    nvox = int(np.prod(shape))
    inv_ref = world_to_vox_affine(ref)
    # Endpoint sampling uses the Benson grids' own inverse affines.
    inv_polar = world_to_vox_affine(polar_img)
    inv_eccen = world_to_vox_affine(eccen_img)

    print(f"[load] tractogram: {args.tractogram}")
    tgm = nib.streamlines.load(args.tractogram)
    streamlines = tgm.streamlines  # RASMM world coordinates
    n_stream = len(streamlines)
    print(f"[load] {n_stream} streamlines; reference grid {shape}")

    # Per-voxel accumulators (flat).
    ecc_sum = np.zeros(nvox, dtype=np.float64)
    wt = np.zeros(nvox, dtype=np.float64)
    polar_sum_r = np.zeros(nvox, dtype=np.float64)   # 1..180  (right hemifield)
    cnt_r = np.zeros(nvox, dtype=np.float64)
    polar_sum_l = np.zeros(nvox, dtype=np.float64)   # 181..360 (left hemifield)
    cnt_l = np.zeros(nvox, dtype=np.float64)

    def world_to_idx(world_pts: np.ndarray, inv: np.ndarray) -> np.ndarray:
        h = np.c_[world_pts, np.ones(len(world_pts))]
        return (h @ inv.T)[:, :3]

    for s, sl in enumerate(streamlines):
        sl = np.asarray(sl, dtype=np.float64)
        if sl.shape[0] < 2:
            continue
        # Endpoint retinotopic labels from Benson (scan a few points inward).
        head = sl[:5]
        tail = sl[-5:][::-1]
        pA = nearest_nonzero_endpoint_value(polar_data, world_to_idx(head, inv_polar))
        pB = nearest_nonzero_endpoint_value(polar_data, world_to_idx(tail, inv_polar))
        eA = nearest_nonzero_endpoint_value(eccen_data, world_to_idx(head, inv_eccen))
        eB = nearest_nonzero_endpoint_value(eccen_data, world_to_idx(tail, inv_eccen))
        # A fiber must terminate in retinotopic cortex on at least one end.
        if pA <= 0 and pB <= 0:
            continue
        if pA <= 0:
            pA, eA = pB, eB
        if pB <= 0:
            pB, eB = pA, eA

        # Densify in reference-voxel space; first half -> endpoint A, second -> B.
        ref_vox = world_to_idx(sl, inv_ref)
        length_vox = np.sum(np.linalg.norm(np.diff(ref_vox, axis=0), axis=1))
        n = max(2, int(length_vox * args.samples_per_vox))
        dens = densify(ref_vox, n)
        half = n // 2
        polar_lbl = np.where(np.arange(n) < half, pA, pB)
        eccen_lbl = np.where(np.arange(n) < half, eA, eB)

        vi = np.rint(dens).astype(np.int64)
        inb = (
            (vi[:, 0] >= 0) & (vi[:, 0] < shape[0]) &
            (vi[:, 1] >= 0) & (vi[:, 1] < shape[1]) &
            (vi[:, 2] >= 0) & (vi[:, 2] < shape[2])
        )
        vi = vi[inb]
        polar_lbl = polar_lbl[inb]
        eccen_lbl = eccen_lbl[inb]
        if vi.shape[0] == 0:
            continue
        flat = (vi[:, 0] * shape[1] + vi[:, 1]) * shape[2] + vi[:, 2]
        # One vote per voxel per streamline (avoid over-counting dense samples).
        flat, uidx = np.unique(flat, return_index=True)
        polar_lbl = polar_lbl[uidx]
        eccen_lbl = eccen_lbl[uidx]

        np.add.at(ecc_sum, flat, eccen_lbl)
        np.add.at(wt, flat, 1.0)
        is_r = polar_lbl <= 180
        np.add.at(polar_sum_r, flat[is_r], polar_lbl[is_r])
        np.add.at(cnt_r, flat[is_r], 1.0)
        is_l = ~is_r
        np.add.at(polar_sum_l, flat[is_l], polar_lbl[is_l])
        np.add.at(cnt_l, flat[is_l], 1.0)

        if (s + 1) % 100000 == 0:
            print(f"[rasterize] {s + 1}/{n_stream} streamlines")

    keep = wt >= max(1, args.min_support)
    print(f"[reduce] {int(keep.sum())} white-matter voxels with support")

    # Per-voxel hemifield vote, then within-hemifield linear mean polar.
    polar_out = np.zeros(nvox, dtype=np.float32)
    pick_r = keep & (cnt_r >= cnt_l) & (cnt_r > 0)
    pick_l = keep & (cnt_l > cnt_r) & (cnt_l > 0)
    polar_out[pick_r] = np.clip(np.rint(polar_sum_r[pick_r] / cnt_r[pick_r]), 1, 180)
    polar_out[pick_l] = np.clip(np.rint(polar_sum_l[pick_l] / cnt_l[pick_l]), 181, 360)

    eccen_out = np.zeros(nvox, dtype=np.float32)
    ec_keep = keep & (wt > 0) & (polar_out > 0)
    eccen_out[ec_keep] = np.clip(ecc_sum[ec_keep] / wt[ec_keep], 0, 90)
    # Drop polar where eccentricity was unresolved so the two maps stay aligned.
    polar_out[~ec_keep] = 0

    polar_vol = polar_out.reshape(shape)
    eccen_vol = eccen_out.reshape(shape)

    os.makedirs(args.out_dir, exist_ok=True)
    polar_path = os.path.join(args.out_dir, "wm_polar_angle.nii.gz")
    eccen_path = os.path.join(args.out_dir, "wm_eccentricity.nii.gz")
    nib.save(nib.Nifti1Image(polar_vol, ref.affine, ref.header), polar_path)
    nib.save(nib.Nifti1Image(eccen_vol, ref.affine, ref.header), eccen_path)

    nz = polar_vol[polar_vol > 0]
    print(f"[write] {polar_path}")
    print(f"[write] {eccen_path}")
    if nz.size:
        print(f"[stats] polar nonzero voxels={nz.size} range=[{nz.min():.0f},{nz.max():.0f}] "
              f"right={int((nz<=180).sum())} left={int((nz>=181).sum())}")
        ez = eccen_vol[eccen_vol > 0]
        print(f"[stats] eccen range=[{ez.min():.1f},{ez.max():.1f}] deg")
    else:
        print("[warn] no nonzero voxels — check that the tractogram is in MNI/RASMM "
              "and that the Benson atlases share that space.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
