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

# load_tractogram has no progress hook, so its stage is driven by a
# time-based estimate (monitored_stage) rather than real progress. Calibrated
# against the real bundled global tract file (tracts/S35_1mm.trk, 673 MB,
# 479,457 streamlines): ~52-61s to load on the dev machine this was measured
# on, i.e. roughly 13 MB/s. Scales with file size so a smaller/larger
# tractogram gets a proportional estimate; only shapes the asymptotic curve
# mid-flight (see monitored_stage), never caps the actual load time.
_LOAD_BYTES_PER_SEC = 13 * 1024 * 1024
# The lesion resample targets the tractogram's OWN grid (fixed regardless of
# the input lesion), so its cost is roughly constant — measured ~3.6s on the
# same real file/grid.
_RESAMPLE_EXPECTED_S = 4.0


def main():
    # DIPY/nibabel/nilearn emit log + warning lines to stdout. The parent
    # process parses this worker's stdout with json.loads(), so reserve stdout
    # for the single JSON result line and route all other output to stderr.
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

    lesion_path       = Path(cfg["lesion_path"])
    result_id         = cfg["result_id"]
    global_tract_file = Path(cfg["global_tract_file"])
    tract_results_dir = Path(cfg["tract_results_dir"])
    atlas_dir         = Path(cfg["atlas_dir"])
    # Optional live-progress channel (job mode). When present, we overwrite this
    # status file at each stage boundary so the parent's /status endpoint can
    # report a progress bar. Absent for the synchronous endpoint and for the
    # One-Click Summary orchestrator, in which case set_status is a no-op — so
    # the compute path is byte-identical either way.
    set_status = _make_set_status(cfg.get("status_path"))
    # Atlases driving the region-overlap breakdown. Each spec = {key, nii,
    # labels}. Defaults to Harvard-Oxford cortical (legacy key ho_cort) when
    # the caller does not specify one.
    atlas_specs = cfg.get("atlas_specs") or DEFAULT_ATLAS_SPECS

    import numpy as np
    import nibabel as nib
    from dipy.io.streamline import load_tractogram, save_tractogram
    from dipy.io.stateful_tractogram import Space, StatefulTractogram
    from dipy.tracking.utils import density_map
    from dipy.tracking.streamline import Streamlines
    from worker_common import resample_to_img

    # ── Load global tractogram ────────────────────────────────────────────────
    # Load + filter are the two slowest phases (confirmed on the real
    # bundle: ~55s load, ~41s filter, vs ~3.6s resample and a few seconds for
    # rasterize+atlas combined) — they now own 0.00-0.85 of the bar instead of
    # the previous static jumps (0.10 -> 0.62), which sat frozen through both
    # multi-second calls.
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
    ref_img = nib.Nifti1Image(np.zeros(ref_dims, dtype=np.int16), ref_affine)
    with _monitored_stage(set_status, "resample", 0.25, 0.30,
                          "Resampling lesion onto tractogram grid…", _RESAMPLE_EXPECTED_S):
        # force_resample=True is REQUIRED for correctness. The FOV mismatch
        # described above is exactly nilearn's broken case: when source and
        # target share voxel sizes and differ only by translation, False takes a
        # "padding optimization" shortcut that mis-places the mask (80.2% of
        # voxels wrong on a measured 1 mm same-zoom pair). A mis-placed lesion
        # mask selects the wrong streamlines. nilearn 0.13 defaults this to True.
        lesion_on_ref = resample_to_img(limg, ref_img, interpolation='nearest',
                                        copy_header=False, force_resample=True)
    lmask_ref = np.asarray(lesion_on_ref.dataobj) > 0

    # ── Select whole streamlines passing through lesion ───────────────────────
    # any streamline with ≥1 point inside the mask is kept in full. Chunked
    # so the bar advances with REAL progress through this — the
    # other slow phase alongside load — instead of sitting at one static value.
    n_input = len(streamlines)
    selected = _target_filtered_with_progress(
        streamlines, ref_affine, lmask_ref, set_status, "filter",
        0.30, 0.90, "Selecting streamlines through lesion",
    )
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
    set_status("rasterize", 0.90, "Rasterizing & saving tract…")
    dm = density_map(selected, ref_affine, ref_dims)

    # ── Persist outputs ───────────────────────────────────────────────────────
    result_dir = tract_results_dir / result_id
    result_dir.mkdir(parents=True, exist_ok=True)
    nii_path = result_dir / "affected_tracts.nii.gz"
    trk_path = result_dir / "affected_tracts.trk"

    nib.save(nib.Nifti1Image(dm.astype("int16"), ref_affine), str(nii_path))
    sft_f = StatefulTractogram(Streamlines(selected), reference=sft, space=Space.RASMM)
    save_tractogram(sft_f, str(trk_path), bbox_valid_check=False)

    # ── Atlas overlap (Harvard-Oxford-style + 4D tractography, worker_common.py) ──
    set_status("atlas", 0.95, "Computing atlas overlap…")
    dm_img  = nib.load(str(nii_path))
    dm_data = np.asarray(dm_img.dataobj, dtype=int)

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
