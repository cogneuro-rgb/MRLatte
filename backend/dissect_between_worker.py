#!/usr/bin/env python
"""Isolated worker: find streamlines that connect two lesion masks.

DIPY target() pre-filter keeps streamlines touching both masks, then an
endpoint-aware pass applies each ROI's mode:
  "through" — any point inside the mask (pre-filter already guarantees this)
  "end"     — an endpoint inside the mask; if both ROIs are "end", the two
              satisfying endpoints must differ (genuine A↔B connections)

Usage: python dissect_between_worker.py <config_json_path>
Config JSON keys: lesion_path_a, lesion_path_b, result_id,
                  global_tract_file, tract_results_dir, atlas_dir,
                  mode_a, mode_b ("through" | "end", optional; default "through")
Output: one JSON line on stdout; traceback to stderr on failure.
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
    _real_stdout = sys.stdout
    sys.stdout = sys.stderr

    config_path = Path(sys.argv[1])
    cfg = json.loads(config_path.read_text())

    lesion_path_a     = Path(cfg["lesion_path_a"])
    lesion_path_b     = Path(cfg["lesion_path_b"])
    result_id         = cfg["result_id"]
    global_tract_file = Path(cfg["global_tract_file"])
    tract_results_dir = Path(cfg["tract_results_dir"])
    atlas_dir         = Path(cfg["atlas_dir"])
    # Per-ROI selection mode: "through" (any point inside) or "end" (an endpoint
    # inside). Streamlines are undirected, so "starts at"/"terminates at" both
    # map to "end" upstream; directionality comes from the both-"end" rule below.
    mode_a            = cfg.get("mode_a", "through")
    mode_b            = cfg.get("mode_b", "through")
    # Atlases driving the region-overlap breakdown (see dissect_worker.py).
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
    n_input     = len(streamlines)

    # ── Helper: load + binarize + MNI-check + resample onto tractogram grid ──
    def _load_and_resample(lesion_path, label):
        limg  = nib.load(str(lesion_path))
        ldata = np.asarray(limg.dataobj)
        lmask = (ldata > 0)
        world_coords = nib.affines.apply_affine(limg.affine, np.array(np.where(lmask)).T)
        if world_coords.size > 0 and np.abs(world_coords).max() > 250:
            return None, (
                f"Lesion {label} is far outside MNI space (>250 mm from origin). "
                "Ensure it is registered to MNI152."
            )
        ref_img = nib.Nifti1Image(np.zeros(ref_dims, dtype=np.int16), ref_affine)
        on_ref  = resample_to_img(limg, ref_img, interpolation='nearest',
                                  copy_header=False, force_resample=False)
        return np.asarray(on_ref.dataobj) > 0, None

    lmask_a, err_a = _load_and_resample(lesion_path_a, "A")
    if err_a:
        print(json.dumps({"id": result_id, "error": err_a}), file=_real_stdout, flush=True)
        sys.exit(1)

    lmask_b, err_b = _load_and_resample(lesion_path_b, "B")
    if err_b:
        print(json.dumps({"id": result_id, "error": err_b}), file=_real_stdout, flush=True)
        sys.exit(1)

    # ── Filtering ─────────────────────────────────────────────────────────────
    # Cheap pre-filter: streamlines touching BOTH masks (any point inside). This
    # narrows the set before the per-endpoint tests below.
    selected_a = list(target(streamlines, ref_affine, lmask_a, include=True))

    if len(selected_a) == 0:
        print(json.dumps({
            "id": result_id,
            "n_input_streamlines":    n_input,
            "n_selected_streamlines": 0,
            "affected_voxels": 0,
            "density_max":     0,
            "tract_volume_cm3": 0.0,
            "message": "No streamlines pass through Lesion A.",
            "files":   None,
            "atlas_overlap": {spec["key"]: [] for spec in atlas_specs},
        }), file=_real_stdout, flush=True)
        sys.exit(0)

    candidates = list(target(selected_a, ref_affine, lmask_b, include=True))

    # Endpoint-aware selection. For "through" the pre-filter already guarantees a
    # point inside the mask, so no extra test is needed. For "end" we require an
    # endpoint inside the mask; when BOTH ROIs are "end" we additionally require
    # the two satisfying endpoints to differ → genuine A↔B endpoint connections.
    if mode_a == "end" or mode_b == "end":
        inv_affine = np.linalg.inv(ref_affine)
        dims = np.array(ref_dims)

        def _in_mask(point, mask):
            v = inv_affine.dot(np.array([point[0], point[1], point[2], 1.0]))[:3]
            ijk = np.rint(v).astype(int)
            if np.any(ijk < 0) or np.any(ijk >= dims):
                return False
            return bool(mask[ijk[0], ijk[1], ijk[2]])

        selected_ab = []
        for sl in candidates:
            s, e = sl[0], sl[-1]
            aS = _in_mask(s, lmask_a); aE = _in_mask(e, lmask_a)
            bS = _in_mask(s, lmask_b); bE = _in_mask(e, lmask_b)
            a_ok = (aS or aE) if mode_a == "end" else True
            b_ok = (bS or bE) if mode_b == "end" else True
            if not (a_ok and b_ok):
                continue
            if mode_a == "end" and mode_b == "end":
                # endpoints satisfying A and B must be different ends
                if not ((aS and bE) or (aE and bS)):
                    continue
            selected_ab.append(sl)
    else:
        selected_ab = candidates

    n_selected = len(selected_ab)

    if n_selected == 0:
        print(json.dumps({
            "id": result_id,
            "n_input_streamlines":    n_input,
            "n_selected_streamlines": 0,
            "affected_voxels": 0,
            "density_max":     0,
            "tract_volume_cm3": 0.0,
            "message": "No streamlines match the selected endpoint criteria.",
            "files":   None,
            "atlas_overlap": {spec["key"]: [] for spec in atlas_specs},
        }), file=_real_stdout, flush=True)
        sys.exit(0)

    # ── Rasterize and persist ─────────────────────────────────────────────────
    dm = density_map(selected_ab, ref_affine, ref_dims)
    result_dir = tract_results_dir / result_id
    result_dir.mkdir(parents=True, exist_ok=True)
    nii_path = result_dir / "connecting_tracts.nii.gz"
    trk_path = result_dir / "connecting_tracts.trk"

    nib.save(nib.Nifti1Image(dm.astype("int16"), ref_affine), str(nii_path))
    sft_f = StatefulTractogram(Streamlines(selected_ab), reference=sft, space=Space.RASMM)
    save_tractogram(sft_f, str(trk_path), bbox_valid_check=False)

    # ── Harvard-Oxford atlas overlap (identical helper to dissect_worker.py) ──
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
                "label":              label_id,
                "name":               region_name,
                "region_voxels":      region_voxels,
                "hit_voxels":         hit_voxels,
                "pct_region":         round(100 * hit_voxels / max(region_voxels, 1), 1),
                "streamline_density": int(dm_data[region_mask].sum()),
            })
        rows.sort(key=lambda r: r["hit_voxels"], reverse=True)
        return rows

    # ── 4D tractography-atlas overlap (e.g. HCP842) — identical helper to
    #    dissect_worker.py. Reports every overlapping tract from a 4D stack of
    #    per-tract binary masks (a voxel may count toward multiple tracts). ──
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

    dm_img    = nib.load(str(nii_path))
    dm_data   = np.asarray(dm_img.dataobj, dtype=int)
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
            "nifti": f"/api/tracts/dissect/result/{result_id}/connecting_tracts.nii.gz",
            "trk":   f"/api/tracts/dissect/result/{result_id}/connecting_tracts.trk",
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
