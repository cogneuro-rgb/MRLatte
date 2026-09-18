"""Tests for the One-Click Summary job's in-process lqtpy overlap computation
(backend/deps.py::_summary_overlap_stage, wired into _run_summary_job).

Covers the task's fail-soft matrix:
  * lqtpy available -> overlap computed in-process, persisted into the job's
    final status.json, and a deprecated client-sent `overlapModel` is ignored
    (and logged as ignored).
  * lqtpy unavailable + a client `overlapModel` provided -> fallback to it,
    marked with JS/fallback provenance, reason recorded.
  * lqtpy unavailable + no client model -> job completes with no overlap
    section; reason recorded.
  * An empty lesion (a real lqtpy 4xx caller error) -> that stage fails
    clearly (raises / job status becomes "error"), never silently falls back.
  * overlap stage disabled -> skipped without ever touching lqtpy.

No subprocess/nilearn: `deps._run_worker_json` (the one seam every worker
call in _run_summary_job goes through) is monkeypatched to a stub that just
echoes back what it was given, the same "no subprocess" spirit as
test_summary_artifacts.py. GLOBAL_TRACT_FILE/LNM_BUNDLE don't exist under the
test scratch module root (see conftest.py), so the dissect/LNM stages are
already skipped without any stubbing.
"""
import asyncio
import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import deps  # noqa: E402
import lesion_metrics  # noqa: E402
import summary_render_worker as srw  # noqa: E402


# --------------------------------------------------------------------------- #
# Fixtures (mirrors tests/test_lesion_metrics.py's synthetic-atlas pattern)
# --------------------------------------------------------------------------- #

@pytest.fixture(autouse=True)
def _reset_bridge_state():
    lesion_metrics._bridge_state.clear()
    yield
    lesion_metrics._bridge_state.clear()


def _make_atlas(root: Path, atlas_id: str, *, shape=(8, 8, 8)):
    folder = root / atlas_id
    folder.mkdir(parents=True, exist_ok=True)
    data = np.zeros(shape, dtype=np.int16)
    data[1:4, 1:4, 1:4] = 1
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(folder / f"{atlas_id}.nii.gz"))
    import atlas_labels
    atlas_labels.write_labels(
        folder / f"{atlas_id}.labels.json",
        [{"value": 1, "name": "Alpha", "hemi": "Left", "color": None, "centroidMM": None}],
    )
    desc = {
        "schemaVersion": 1, "id": atlas_id, "aliases": [],
        "name": f"Synthetic {atlas_id}", "short": atlas_id, "description": "",
        "kind": "parcellation", "space": "MNI152",
        "volume": f"{atlas_id}.nii.gz", "labels": f"{atlas_id}.labels.json",
        "colormap": "random", "opacity": 0.55, "ignoreZeroVoxels": True,
        "origin": {"kind": "builtin"}, "license": {},
    }
    (folder / "atlas.json").write_text(json.dumps(desc), encoding="utf-8")
    return folder


@pytest.fixture
def synthetic_atlas(tmp_path, monkeypatch):
    root = tmp_path / "atlases"
    root.mkdir()
    monkeypatch.setattr(deps, "ATLAS_DIR", root)
    _make_atlas(root, "synth_parcellation")
    return root


def _cube_lesion_path(tmp_path, shape=(8, 8, 8)) -> Path:
    data = np.zeros(shape, dtype=np.float32)
    data[1:4, 1:4, 1:4] = 1.0  # exactly region 1 of _make_atlas: 27 voxels
    p = tmp_path / "lesion.nii.gz"
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(p))
    return p


def _empty_lesion_path(tmp_path, shape=(8, 8, 8)) -> Path:
    p = tmp_path / "empty_lesion.nii.gz"
    nib.save(nib.Nifti1Image(np.zeros(shape, dtype=np.float32), np.eye(4)), str(p))
    return p


def _noop_status(*a, **k):
    pass


def _noop_check_cancelled():
    pass


# --------------------------------------------------------------------------- #
# _summary_overlap_stage — direct tests (no full job run)
# --------------------------------------------------------------------------- #

def test_overlap_computed_in_process_when_lqtpy_available(tmp_path, synthetic_atlas):
    lesion_path = _cube_lesion_path(tmp_path)
    payload = {"atlas_ids": ["synth_parcellation"]}
    stages = {"overlap": True}

    model, reason = asyncio.run(deps._summary_overlap_stage(
        lesion_path, payload, stages, _noop_status, _noop_check_cancelled))

    assert reason is None
    assert model["provenance"]["engine"] == "lqtpy"
    assert model["provenance"]["fallback"] is False
    assert model["volume"]["voxelCount"] == 27
    assert len(model["atlasBreakdowns"]) == 1
    b = model["atlasBreakdowns"][0]
    assert b["atlasId"] == "synth_parcellation"
    assert b["rows"][0]["regionName"] == "Alpha"
    assert b["rows"][0]["voxelCount"] == 27
    assert model["excludedAtlases"] == []


def test_unbridged_atlas_id_is_excluded_not_a_hard_error(tmp_path, synthetic_atlas):
    lesion_path = _cube_lesion_path(tmp_path)
    payload = {"atlas_ids": ["synth_parcellation", "does_not_exist"]}
    stages = {"overlap": True}

    model, reason = asyncio.run(deps._summary_overlap_stage(
        lesion_path, payload, stages, _noop_status, _noop_check_cancelled))

    assert reason is None
    assert len(model["atlasBreakdowns"]) == 1  # only the bridged one
    assert model["excludedAtlases"] == [
        {"id": "does_not_exist", "name": "does_not_exist",
         "reason": "not supported by the lqtpy engine (atlas kind can't be bridged)"},
    ]


def test_client_overlap_model_ignored_when_lqtpy_available(tmp_path, synthetic_atlas, caplog):
    lesion_path = _cube_lesion_path(tmp_path)
    client_model = {"atlasBreakdowns": [{"atlasId": "js-only", "rows": []}],
                    "provenance": {"engine": "js", "fallback": True}}
    payload = {"atlas_ids": ["synth_parcellation"], "overlapModel": client_model}
    stages = {"overlap": True}

    with caplog.at_level("INFO"):
        model, reason = asyncio.run(deps._summary_overlap_stage(
            lesion_path, payload, stages, _noop_status, _noop_check_cancelled))

    assert reason is None
    assert model["provenance"]["engine"] == "lqtpy"  # NOT the client's "js" model
    assert all(b["atlasId"] != "js-only" for b in model["atlasBreakdowns"])
    assert any("ignoring deprecated" in r.message for r in caplog.records)


def test_lqtpy_unavailable_falls_back_to_client_model(tmp_path, synthetic_atlas, monkeypatch):
    monkeypatch.setattr(lesion_metrics, "lqtpy", None)
    lesion_path = _cube_lesion_path(tmp_path)
    client_model = {"atlasBreakdowns": [{"atlasId": "synth_parcellation", "rows": []}],
                    "provenance": {"engine": "js", "fallback": True, "fallbackReason": "dev"}}
    payload = {"atlas_ids": ["synth_parcellation"], "overlapModel": client_model}
    stages = {"overlap": True}

    model, reason = asyncio.run(deps._summary_overlap_stage(
        lesion_path, payload, stages, _noop_status, _noop_check_cancelled))

    assert reason  # a human-readable explanation
    assert model["provenance"]["engine"] == "js"
    assert model["provenance"]["fallback"] is True


def test_lqtpy_unavailable_no_client_model_runs_without_overlap(tmp_path, synthetic_atlas, monkeypatch):
    monkeypatch.setattr(lesion_metrics, "lqtpy", None)
    lesion_path = _cube_lesion_path(tmp_path)
    payload = {"atlas_ids": ["synth_parcellation"]}  # no overlapModel sent
    stages = {"overlap": True}

    model, reason = asyncio.run(deps._summary_overlap_stage(
        lesion_path, payload, stages, _noop_status, _noop_check_cancelled))

    assert model is None
    assert reason  # explains why overlap is missing


def test_overlap_stage_disabled_skips_without_touching_lqtpy(tmp_path, synthetic_atlas, monkeypatch):
    # If this reached lqtpy it would raise (lesion_path doesn't exist) -- the
    # absence of an error IS the assertion that lqtpy was never called.
    lesion_path = tmp_path / "does_not_exist.nii.gz"
    payload = {"atlas_ids": ["synth_parcellation"]}
    stages = {"overlap": False}

    model, reason = asyncio.run(deps._summary_overlap_stage(
        lesion_path, payload, stages, _noop_status, _noop_check_cancelled))

    assert model is None
    assert reason == "overlap stage disabled"


def test_empty_lesion_raises_instead_of_silently_falling_back(tmp_path, synthetic_atlas):
    """A 4xx-class lqtpy caller error (empty lesion) must propagate so the
    job fails that stage clearly -- never a silent fallback, even though a
    client overlapModel is available and could have masked it."""
    lesion_path = _empty_lesion_path(tmp_path)
    payload = {"atlas_ids": ["synth_parcellation"],
              "overlapModel": {"atlasBreakdowns": [], "provenance": {}}}
    stages = {"overlap": True}

    with pytest.raises(Exception) as excinfo:
        asyncio.run(deps._summary_overlap_stage(
            lesion_path, payload, stages, _noop_status, _noop_check_cancelled))
    # Confirm it's genuinely a 4xx-class error, not some unrelated bug.
    assert lesion_metrics.status_code_for(excinfo.value) in (400,)


# --------------------------------------------------------------------------- #
# Full job orchestration: overlap_model flows through to the persisted job
# status (deps._run_summary_job). Worker subprocess calls are stubbed (no
# subprocess/nilearn) -- see module docstring.
# --------------------------------------------------------------------------- #

def _fake_run_worker_json(script, config, workdir, timeout, job_id=None):
    name = Path(script).name
    if name == "summary_render_worker.py":
        # Reproduce the one side effect this test cares about (the CSV, with
        # its provenance comment line) via the SAME helper the real worker
        # calls (summary_render_worker._write_overlap_csv) -- everything
        # else about the real worker (brainsprite/nilearn) is out of scope
        # here and would need real rendering deps / network access.
        out_dir = Path(config["output_dir"])
        data_dir = out_dir / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        srw._write_overlap_csv(data_dir, config.get("overlap_model"))
        return {
            "ok": True, "artifacts": [], "lesion_name": config.get("lesion_name"),
            "retino": None, "dissect_info": None, "lnm_info": None,
            "overlap_model": config.get("overlap_model"), "assets": {},
        }
    # dissect_worker.py / lnm_worker.py: GLOBAL_TRACT_FILE/LNM_BUNDLE don't
    # exist under the test scratch module root, so these stages are already
    # skipped before ever calling this -- this branch shouldn't run, but
    # fails soft (matching real worker behaviour) rather than crashing the
    # test if it ever does.
    return {"error": "stubbed out for test"}


def test_overlap_persisted_in_final_job_status_and_csv(tmp_path, synthetic_atlas, monkeypatch):
    monkeypatch.setattr(deps, "_run_worker_json", _fake_run_worker_json)
    lesion_path = _cube_lesion_path(tmp_path)
    job_id = "test-job-overlap-persist"
    payload = {"stages": {"overlap": True, "dissect": True, "lnm": True, "retino": False},
              "atlas_ids": ["synth_parcellation"], "name": "test lesion"}
    # summary_run (routers/summary.py) normally creates this before kicking
    # off the background task -- do the same here since we call the
    # orchestration function directly.
    (deps.SUMMARY_RESULTS_DIR / job_id).mkdir(parents=True, exist_ok=True)

    asyncio.run(deps._run_summary_job(job_id, lesion_path, payload))

    job_dir = deps.SUMMARY_RESULTS_DIR / job_id
    status = json.loads((job_dir / "status.json").read_text())
    assert status["stage"] == "done"
    assert status["done"] is True
    files = status["files"]
    assert files["overlap_reason"] is None
    om = files["overlap_model"]
    assert om["provenance"]["engine"] == "lqtpy"
    assert om["atlasBreakdowns"][0]["rows"][0]["regionName"] == "Alpha"

    csv_path = job_dir / "data" / "atlas_overlap.csv"
    assert csv_path.exists()
    text = csv_path.read_text()
    lines = text.splitlines()
    assert lines[0].startswith("# engine: lqtpy")
    assert lines[1] == "atlas,region,voxels,pct_of_lesion,pct_of_region"
    assert "Alpha" in text


def test_empty_lesion_fails_job_clearly(tmp_path, synthetic_atlas, monkeypatch):
    monkeypatch.setattr(deps, "_run_worker_json", _fake_run_worker_json)
    lesion_path = _empty_lesion_path(tmp_path)
    job_id = "test-job-empty-lesion"
    payload = {"stages": {"overlap": True, "dissect": False, "lnm": False, "retino": False},
              "atlas_ids": ["synth_parcellation"], "name": "empty lesion"}
    (deps.SUMMARY_RESULTS_DIR / job_id).mkdir(parents=True, exist_ok=True)

    asyncio.run(deps._run_summary_job(job_id, lesion_path, payload))

    job_dir = deps.SUMMARY_RESULTS_DIR / job_id
    status = json.loads((job_dir / "status.json").read_text())
    assert status["stage"] == "error"
    assert status["done"] is True
    assert status["error"]  # a real, non-empty message -- not silently swallowed
