#!/usr/bin/env python3
"""
Batch tract dissection — pure Python, no server/backend required.

For every lesion NIfTI in LESIONS_DIR, dissects TRACT_FILE (a whole-brain
tractogram, e.g. S35_1mm.trk) against that lesion mask and writes:

  <OUTPUT_DIR>/raw/<lesion>_density.nii.gz
        streamline density map (int16 voxel-wise streamline counts)
  <OUTPUT_DIR>/raw/<lesion>_streamlines.trk
        the whole streamlines that pass through the lesion mask

  <OUTPUT_DIR>/thresholded/<lesion>_binarized.nii.gz
        the density map thresholded at THRESHOLD_PCT of THIS lesion's own
        peak density, then binarized to 0/1 — a disconnectome-style mask
        (same convention as BCBtoolkit/Tractotron-style lesion-network
        mapping tools). No .trk here — it would be an exact duplicate of
        raw/<lesion>_streamlines.trk (streamline SELECTION is unaffected
        by the threshold; only the density-map voxel values are).

Plus one summary row per lesion in <OUTPUT_DIR>/summary.csv.

Usage: edit the LESIONS_DIR / TRACT_FILE / OUTPUT_DIR / THRESHOLD_PCT
constants at the bottom of this file, then run it (e.g. from your IDE).

Dependencies (already in backend/requirements.txt):
    pip install numpy nibabel dipy nilearn

Adapted from the single-lesion worker behind the app's Tract Dissection
panel (backend/dissect_worker.py) — same selection/rasterization algorithm,
but the tractogram is loaded ONCE for the whole batch instead of per lesion
(that file is often 500MB-1GB+, so this matters for anything more than a
couple of lesions).
"""

import csv
import sys
import warnings
from pathlib import Path

import numpy as np
import nibabel as nib

warnings.filterwarnings("ignore")


# ─── helpers ─────────────────────────────────────────────────────────────────

def _stem(path):
    name = path.name
    for ext in (".nii.gz", ".nii"):
        if name.endswith(ext):
            return name[: -len(ext)]
    return path.stem


def _looks_like_mni(lesion_img, lmask):
    """Reject lesions whose world-space centroid is implausibly far from the
    MNI origin (mirrors dissect_worker.py's >250mm check) — catches lesions
    that were never registered to MNI space. An empty mask is left for the
    caller to handle (not a space problem)."""
    if not lmask.any():
        return True
    coords = nib.affines.apply_affine(lesion_img.affine, np.array(np.where(lmask)).T)
    return bool(np.abs(coords).max() <= 250)


# ─── per-lesion dissection ───────────────────────────────────────────────────

def dissect_one(lesion_path, sft, threshold_pct, raw_dir, thresholded_dir):
    """Dissect one lesion against an already-loaded tractogram (`sft`, a
    dipy StatefulTractogram). Returns a summary dict. Raises on unrecoverable
    errors — callers should catch per-lesion so one bad file doesn't abort
    the batch.
    """
    from dipy.io.stateful_tractogram import Space, StatefulTractogram
    from dipy.io.streamline import save_tractogram
    from dipy.tracking.streamline import Streamlines
    from dipy.tracking.utils import target, density_map
    from nilearn.image import resample_to_img

    ref_affine = sft.affine
    ref_dims = tuple(sft.dimensions)
    streamlines = sft.streamlines

    stem = _stem(lesion_path)

    limg = nib.load(str(lesion_path))
    ldata = np.asarray(limg.dataobj)
    lmask = ldata > 0

    if not _looks_like_mni(limg, lmask):
        raise ValueError(
            "Lesion is far outside MNI space (>250mm from origin) - "
            "ensure it is registered to MNI152."
        )

    # Resample onto the tractogram's grid so every streamline point is
    # guaranteed in-bounds for target() (the lesion may live on a different
    # grid/FOV than the tractogram).
    ref_img = nib.Nifti1Image(np.zeros(ref_dims, dtype=np.int16), ref_affine)
    lesion_on_ref = resample_to_img(limg, ref_img, interpolation="nearest",
                                     copy_header=False, force_resample=False)
    lmask_ref = np.asarray(lesion_on_ref.dataobj) > 0

    n_input = len(streamlines)
    selected = list(target(streamlines, ref_affine, lmask_ref, include=True))
    n_selected = len(selected)

    raw_dir.mkdir(parents=True, exist_ok=True)
    thresholded_dir.mkdir(parents=True, exist_ok=True)

    voxel_vol_mm3 = float(np.prod(np.abs(np.diag(ref_affine[:3, :3]))))

    if n_selected == 0:
        empty = np.zeros(ref_dims, dtype="int16")
        nib.save(nib.Nifti1Image(empty, ref_affine),
                  str(raw_dir / f"{stem}_density.nii.gz"))
        nib.save(nib.Nifti1Image(empty.astype("uint8"), ref_affine),
                  str(thresholded_dir / f"{stem}_binarized.nii.gz"))
        return {
            "lesion": stem, "status": "no_streamlines",
            "n_input_streamlines": n_input, "n_selected_streamlines": 0,
            "affected_voxels": 0, "density_max": 0,
            "threshold_cutoff": 0, "thresholded_voxels": 0,
            "tract_volume_cm3": 0.0,
        }

    dm = density_map(selected, ref_affine, ref_dims)

    nib.save(nib.Nifti1Image(dm.astype("int16"), ref_affine),
              str(raw_dir / f"{stem}_density.nii.gz"))

    sft_selected = StatefulTractogram(Streamlines(selected), reference=sft,
                                       space=Space.RASMM)
    save_tractogram(sft_selected, str(raw_dir / f"{stem}_streamlines.trk"),
                     bbox_valid_check=False)

    density_max = int(dm.max())
    threshold_cutoff = threshold_pct * density_max
    binarized = (dm >= threshold_cutoff).astype("uint8")
    nib.save(nib.Nifti1Image(binarized, ref_affine),
              str(thresholded_dir / f"{stem}_binarized.nii.gz"))

    affected_voxels = int(np.sum(dm > 0))
    return {
        "lesion": stem, "status": "ok",
        "n_input_streamlines": n_input, "n_selected_streamlines": n_selected,
        "affected_voxels": affected_voxels, "density_max": density_max,
        "threshold_cutoff": round(threshold_cutoff, 3),
        "thresholded_voxels": int(binarized.sum()),
        "tract_volume_cm3": round(affected_voxels * voxel_vol_mm3 / 1000, 3),
    }


# ─── batch driver ─────────────────────────────────────────────────────────────

def run_batch(lesions_dir, tract_file, output_dir, threshold_pct):
    from dipy.io.streamline import load_tractogram
    from dipy.io.stateful_tractogram import Space

    lesions_dir = Path(lesions_dir)
    tract_file = Path(tract_file)
    output_dir = Path(output_dir)
    raw_dir = output_dir / "raw"
    thresholded_dir = output_dir / "thresholded"

    if not lesions_dir.is_dir():
        print(f"Lesions directory not found: {lesions_dir}")
        sys.exit(1)
    if not tract_file.exists():
        print(f"Tract file not found: {tract_file}")
        sys.exit(1)

    lesion_files = sorted(lesions_dir.glob("*.nii.gz")) + sorted(lesions_dir.glob("*.nii"))
    if not lesion_files:
        print(f"No lesion files (.nii/.nii.gz) found in {lesions_dir}")
        sys.exit(1)

    print(f"Loading tractogram: {tract_file} (this can take a while for large files)")
    sft = load_tractogram(str(tract_file), reference="same",
                           to_space=Space.RASMM, bbox_valid_check=False)
    print(f"  {len(sft.streamlines)} streamlines, grid {tuple(sft.dimensions)}")

    print(f"Found {len(lesion_files)} lesion files -> {output_dir}")
    print(f"Threshold: {threshold_pct:.0%} of each lesion's own peak density\n")

    records = []
    failed = []

    for idx, lesion_path in enumerate(lesion_files, 1):
        print(f"[{idx:3d}/{len(lesion_files)}] {lesion_path.name}")
        try:
            record = dissect_one(lesion_path, sft, threshold_pct, raw_dir, thresholded_dir)
        except Exception as e:
            print(f"    FAILED: {e}")
            failed.append({"lesion": lesion_path.name, "error": str(e)})
            continue

        records.append(record)
        if record["status"] == "no_streamlines":
            print("    no streamlines pass through this lesion")
        else:
            print(f"    {record['n_selected_streamlines']} streamlines selected, "
                  f"{record['affected_voxels']} raw voxels, "
                  f"{record['thresholded_voxels']} thresholded voxels")

    # ── summary CSV ────────────────────────────────────────────────────────
    output_dir.mkdir(parents=True, exist_ok=True)
    summary_path = output_dir / "summary.csv"
    fieldnames = ["lesion", "status", "n_input_streamlines", "n_selected_streamlines",
                  "affected_voxels", "density_max", "threshold_cutoff",
                  "thresholded_voxels", "tract_volume_cm3"]
    with open(summary_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(records)
        for fail in failed:
            writer.writerow({"lesion": fail["lesion"], "status": f"FAILED: {fail['error']}"})

    print(f"\nDone. {len(records)} succeeded, {len(failed)} failed.")
    print(f"Summary: {summary_path}")
    if failed:
        print("Failed lesions:")
        for fail in failed:
            print(f"  {fail['lesion']}: {fail['error']}")


if __name__ == "__main__":
    # ── edit these before running ─────────────────────────────────────────
    LESIONS_DIR = r"path\to\lesions"
    TRACT_FILE = r"path\to\S35_1mm.trk"
    OUTPUT_DIR = r"path\to\output"
    THRESHOLD_PCT = 0.10  # 10% of each lesion's own peak streamline density

    run_batch(LESIONS_DIR, TRACT_FILE, OUTPUT_DIR, THRESHOLD_PCT)
