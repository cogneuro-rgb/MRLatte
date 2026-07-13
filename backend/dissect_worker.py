#!/usr/bin/env python
"""Isolated DIPY tract-dissection worker.

Called by server.py via asyncio.create_subprocess_exec — any crash here
(segfault, OOM, DIPY C-extension error) exits this subprocess and returns
HTTP 500 to the client; uvicorn is never affected.

Usage: python dissect_worker.py <config_json_path>
  Config JSON keys: lesion_path, result_id, global_tract_file,
                    tract_results_dir, atlas_dir
Output: JSON written to stdout on success; traceback to stderr on failure.
"""
import json
import os
import sys
from pathlib import Path

# Ensure this worker's own directory is importable when spawned under the isolated
# embeddable Python (safe_path=True) used by the offline bundle, which does not
# auto-add the script directory to sys.path. Defensive: keeps any sibling-module
# import working the same as under a normal dev interpreter.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    # DIPY/nibabel/nilearn emit log + warning lines to stdout. The parent
    # process parses this worker's stdout with json.loads(), so reserve stdout
    # for the single JSON result line and route all other output to stderr.
    _real_stdout = sys.stdout
    sys.stdout = sys.stderr

    config_path = Path(sys.argv[1])
    cfg = json.loads(config_path.read_text())

    lesion_path       = Path(cfg["lesion_path"])
    result_id         = cfg["result_id"]
    global_tract_file = Path(cfg["global_tract_file"])
    tract_results_dir = Path(cfg["tract_results_dir"])
    atlas_dir         = Path(cfg["atlas_dir"])
    # Atlases driving the region-overlap breakdown. Each spec = {key, nii,
    # labels}. Defaults to Harvard-Oxford cortical (legacy key ho_cort) when
    # the caller does not specify one.
    atlas_specs = cfg.get("atlas_specs") or [
        {"key": "ho_cort", "nii": "harvard_oxford_cort.nii.gz",
         "labels": "harvard_oxford_cort_labels.json"},
    ]

    import numpy as np
    import nibabel as nib
    from dipy.io.streamline import load_tractogram, save_tractogram
    from dipy.io.stateful_tractogram import Space, StatefulTractogram
    from dipy.tracking.utils import target, density_map
    from dipy.tracking.streamline import Streamlines
    from nilearn.image import resample_to_img

    # ── Load global tractogram ────────────────────────────────────────────────
    sft = load_tractogram(str(global_tract_file), reference='same',
                          to_space=Space.RASMM, bbox_valid_check=False)
    ref_affine  = sft.affine
    ref_dims    = tuple(sft.dimensions)
    streamlines = sft.streamlines

    # ── Load and binarize lesion ──────────────────────────────────────────────
    limg  = nib.load(str(lesion_path))
    ldata = np.asarray(limg.dataobj)
    lmask = (ldata > 0)

    # Sanity check: lesion world-space centroid must be plausibly inside MNI
    world_coords = nib.affines.apply_affine(limg.affine, np.array(np.where(lmask)).T)
    if world_coords.size > 0 and np.abs(world_coords).max() > 250:
        print(json.dumps({
            "id": result_id,
            "error": (
                "Lesion is far outside MNI space (>250 mm from origin). "
                "Ensure the lesion is registered to MNI152."
            ),
        }), file=_real_stdout, flush=True)
        sys.exit(1)

    # ── Resample lesion onto the tractogram's reference grid ──────────────────
    # The lesion may live on a different grid/FOV than the tractogram (e.g. a
    # 153×190×159 native grid vs the tractogram's 182×218×182 MNI grid). target()
    # maps every RASMM streamline point into the mask via inv(affine); any point
    # outside the mask's FOV raises IndexError ("streamlines points are outside
    # of target_mask"). Resampling the mask onto the tractogram grid (nearest-
    # neighbour) puts both in the same RASMM space and guarantees every
    # streamline point is in-bounds.
    ref_img       = nib.Nifti1Image(np.zeros(ref_dims, dtype=np.int16), ref_affine)
    lesion_on_ref = resample_to_img(limg, ref_img, interpolation='nearest',
                                    copy_header=False, force_resample=False)
    lmask_ref     = np.asarray(lesion_on_ref.dataobj) > 0

    # ── Select whole streamlines passing through lesion ───────────────────────
    # any streamline with ≥1 point inside the mask is kept in full.
    selected  = list(target(streamlines, ref_affine, lmask_ref, include=True))
    n_input   = len(streamlines)
    n_selected = len(selected)

    if n_selected == 0:
        print(json.dumps({
            "id": result_id,
            "n_input_streamlines": n_input,
            "n_selected_streamlines": 0,
            "affected_voxels": 0,
            "density_max": 0,
            "tract_volume_cm3": 0.0,
            "message": "No streamlines pass through this lesion.",
            "files": None,
            "atlas_overlap": {spec["key"]: [] for spec in atlas_specs},
        }), file=_real_stdout, flush=True)
        sys.exit(0)

    # ── Rasterize on TRK's full 182³ grid ────────────────────────────────────
    dm = density_map(selected, ref_affine, ref_dims)

    # ── Persist outputs ───────────────────────────────────────────────────────
    result_dir = tract_results_dir / result_id
    result_dir.mkdir(parents=True, exist_ok=True)
    nii_path = result_dir / "affected_tracts.nii.gz"
    trk_path = result_dir / "affected_tracts.trk"

    nib.save(nib.Nifti1Image(dm.astype("int16"), ref_affine), str(nii_path))
    sft_f = StatefulTractogram(Streamlines(selected), reference=sft, space=Space.RASMM)
    save_tractogram(sft_f, str(trk_path), bbox_valid_check=False)

    # ── Harvard-Oxford atlas overlap ──────────────────────────────────────────
    def _ho_overlap(dm_img, dm_data, atlas_nii_name, atlas_labels_name):
        atlas_path  = atlas_dir / atlas_nii_name
        labels_path = atlas_dir / atlas_labels_name
        if not atlas_path.exists() or not labels_path.exists():
            return []

        atlas_img = nib.load(str(atlas_path))
        atlas_r   = resample_to_img(atlas_img, dm_img, interpolation='nearest',
                                    copy_header=False, force_resample=False)
        a = np.asarray(atlas_r.dataobj, dtype=int)

        with open(labels_path) as f:
            raw_labels = json.load(f)
        if isinstance(raw_labels, list):
            labels = {str(entry["index"]): entry["name"] for entry in raw_labels}
        else:
            labels = {str(k): v for k, v in raw_labels.items()}

        rows = []
        dm_nonzero = dm_data > 0
        for label_str, region_name in labels.items():
            label_id = int(label_str)
            if label_id == 0:
                continue
            region_mask = (a == label_id)
            hit_voxels  = int(np.sum(region_mask & dm_nonzero))
            if hit_voxels == 0:
                continue
            region_voxels = int(np.sum(region_mask))
            rows.append({
                "label":             label_id,
                "name":              region_name,
                "region_voxels":     region_voxels,
                "hit_voxels":        hit_voxels,
                "pct_region":        round(100 * hit_voxels / max(region_voxels, 1), 1),
                "streamline_density": int(dm_data[region_mask].sum()),
            })
        rows.sort(key=lambda r: r["hit_voxels"], reverse=True)
        return rows

    # ── 4D tractography-atlas overlap (e.g. HCP842) ───────────────────────────
    # The atlas is a 4D stack of per-tract BINARY masks (one frame per tract),
    # which overlap heavily. Instead of a single winner-take-all label, report
    # EVERY tract the affected streamlines pass through: resample the density map
    # into the atlas grid once, then AND it against each frame. A voxel may count
    # toward multiple tracts (intended).
    def _tracts4d_overlap(dm_img, dm_data, atlas_nii_name, atlas_labels_name):
        atlas_path  = atlas_dir / atlas_nii_name
        labels_path = atlas_dir / atlas_labels_name
        if not atlas_path.exists() or not labels_path.exists():
            return []
        atlas_img = nib.load(str(atlas_path))
        if atlas_img.ndim != 4:
            return []
        X, Y, Z, T = atlas_img.shape
        ref3d = nib.Nifti1Image(np.zeros((X, Y, Z), dtype=np.int16), atlas_img.affine)
        dens_img = resample_to_img(dm_img, ref3d, interpolation='nearest',
                                   copy_header=False, force_resample=False)
        dens = np.asarray(dens_img.dataobj, dtype=int)
        dm_nonzero = dens > 0

        with open(labels_path) as f:
            raw_labels = json.load(f)
        if isinstance(raw_labels, list):
            labels = {int(entry["index"]): entry["name"] for entry in raw_labels}
        else:
            labels = {int(k): v for k, v in raw_labels.items()}

        dataobj = atlas_img.dataobj
        rows = []
        for t in range(T):
            mask_t     = np.asanyarray(dataobj[..., t]) > 0
            hit        = mask_t & dm_nonzero
            hit_voxels = int(hit.sum())
            if hit_voxels == 0:
                continue
            region_voxels = int(mask_t.sum())
            label_id      = t + 1
            rows.append({
                "label":              label_id,
                "name":               labels.get(label_id, f"Tract {label_id}"),
                "region_voxels":      region_voxels,
                "hit_voxels":         hit_voxels,
                "pct_region":         round(100 * hit_voxels / max(region_voxels, 1), 1),
                "streamline_density": int(dens[hit].sum()),
            })
        rows.sort(key=lambda r: r["hit_voxels"], reverse=True)
        return rows

    def _overlap_for(spec, dm_img, dm_data):
        if spec.get("mode") == "tracts4d":
            return _tracts4d_overlap(dm_img, dm_data, spec["nii"], spec["labels"])
        return _ho_overlap(dm_img, dm_data, spec["nii"], spec["labels"])

    dm_img  = nib.load(str(nii_path))
    dm_data = np.asarray(dm_img.dataobj, dtype=int)

    atlas_overlap = {
        spec["key"]: _overlap_for(spec, dm_img, dm_data)
        for spec in atlas_specs
    }

    # ── Metrics ───────────────────────────────────────────────────────────────
    affected_voxels = int(np.sum(dm > 0))
    density_max     = int(dm.max())
    voxel_vol_mm3   = float(np.prod(np.abs(np.diag(ref_affine[:3, :3]))))
    tract_vol_cm3   = round(affected_voxels * voxel_vol_mm3 / 1000, 3)

    print(json.dumps({
        "id":                     result_id,
        "n_input_streamlines":    n_input,
        "n_selected_streamlines": n_selected,
        "affected_voxels":        affected_voxels,
        "density_max":            density_max,
        "tract_volume_cm3":       tract_vol_cm3,
        "files": {
            "nifti": f"/api/tracts/dissect/result/{result_id}/affected_tracts.nii.gz",
            "trk":   f"/api/tracts/dissect/result/{result_id}/affected_tracts.trk",
        },
        "atlas_overlap": atlas_overlap,
    }), file=_real_stdout, flush=True)
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
