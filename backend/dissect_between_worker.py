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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker_common import (  # noqa: E402
    make_set_status as _make_set_status,
    DEFAULT_ATLAS_SPECS,
    overlap_for as _overlap_for,
    dissection_metrics as _dissection_metrics,
    monitored_stage as _monitored_stage,
    target_filtered_with_progress as _target_filtered_with_progress,
)

# See dissect_worker.py for the measurement this is calibrated
# against (same global tract file, same load_tractogram call).
_LOAD_BYTES_PER_SEC = 13 * 1024 * 1024
# Two masks resampled onto the same fixed tractogram grid — roughly double
# dissect_worker.py's single-mask ~3.6s.
_RESAMPLE_EXPECTED_S = 7.0


def main():
    _real_stdout = sys.stdout
    sys.stdout = sys.stderr

    config_path = Path(sys.argv[1])
    cfg = json.loads(config_path.read_text())

    # Extra sys.path entries from the parent (optional Python stacks like
    # python-reports/python-validation in a full packaged build — see
    # worker_common.extra_sys_path_for_worker for why PYTHONPATH can't carry
    # these across the subprocess boundary). Must run before any import that
    # might need them.
    for _p in cfg.get("sys_path") or []:
        if _p not in sys.path:
            sys.path.insert(0, _p)

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
    # Optional live-progress channel (job mode); no-op when absent (sync/summary).
    set_status        = _make_set_status(cfg.get("status_path"))
    # Atlases driving the region-overlap breakdown (see dissect_worker.py).
    atlas_specs = cfg.get("atlas_specs") or DEFAULT_ATLAS_SPECS

    import numpy as np
    import nibabel as nib
    from dipy.io.streamline import load_tractogram, save_tractogram
    from dipy.io.stateful_tractogram import Space, StatefulTractogram
    from dipy.tracking.utils import density_map
    from dipy.tracking.streamline import Streamlines
    from worker_common import resample_to_img

    # ── Load global tractogram ────────────────────────────────────────────────
    # Same load+filter reweighting as dissect_worker.py, adapted for
    # this worker's extra second target() pass (mask B, over the already-
    # narrowed mask-A selection) and optional endpoint refinement.
    try:
        load_expected_s = max(4.0, global_tract_file.stat().st_size / _LOAD_BYTES_PER_SEC)
    except OSError:
        load_expected_s = 30.0
    with _monitored_stage(set_status, "load", 0.00, 0.25, "Loading tractogram…", load_expected_s):
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
        # force_resample=True is REQUIRED for correctness — see dissect_worker.py
        # for the measurement. False mis-places the mask on same-zoom grids.
        on_ref  = resample_to_img(limg, ref_img, interpolation='nearest',
                                  copy_header=False, force_resample=True)
        return np.asarray(on_ref.dataobj) > 0, None

    with _monitored_stage(set_status, "resample", 0.25, 0.30,
                          "Resampling lesion masks…", _RESAMPLE_EXPECTED_S):
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
    # narrows the set before the per-endpoint tests below. Chunked for
    # real progress — mask A runs over the full bundle (the expensive pass);
    # mask B runs over the already-narrowed selected_a (much smaller/faster).
    selected_a = _target_filtered_with_progress(
        streamlines, ref_affine, lmask_a, set_status, "filter",
        0.30, 0.65, "Selecting streamlines through Lesion A",
    )

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

    candidates = _target_filtered_with_progress(
        selected_a, ref_affine, lmask_b, set_status, "filter",
        0.65, 0.90, "Selecting streamlines through Lesion B",
    )

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
    set_status("rasterize", 0.90, "Rasterizing & saving tract…")
    dm = density_map(selected_ab, ref_affine, ref_dims)
    result_dir = tract_results_dir / result_id
    result_dir.mkdir(parents=True, exist_ok=True)
    nii_path = result_dir / "connecting_tracts.nii.gz"
    trk_path = result_dir / "connecting_tracts.trk"

    nib.save(nib.Nifti1Image(dm.astype("int16"), ref_affine), str(nii_path))
    sft_f = StatefulTractogram(Streamlines(selected_ab), reference=sft, space=Space.RASMM)
    save_tractogram(sft_f, str(trk_path), bbox_valid_check=False)

    # ── Atlas overlap (Harvard-Oxford-style + 4D tractography, worker_common.py) ──
    set_status("atlas", 0.95, "Computing atlas overlap…")
    dm_img    = nib.load(str(nii_path))
    dm_data   = np.asarray(dm_img.dataobj, dtype=int)
    atlas_overlap = {
        spec["key"]: _overlap_for(atlas_dir, spec, dm_img, dm_data)
        for spec in atlas_specs
    }

    # ── Metrics (worker_common.py) ───────────────────────────────────────────
    affected_voxels, density_max, tract_vol_cm3 = _dissection_metrics(dm, ref_affine)

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
