"""Tests for the One-Click Summary artifact manifest + selective download
routes (replaces the old zip-everything summary.zip).

Covers:
  * summary_render_worker._build_manifest / _artifact: manifest shape (six
    keys per entry, unique `rel`, uploaded lesion + status.json never listed),
    and that a declared-but-missing file is silently dropped rather than
    producing a manifest entry the download route can't serve.
  * routers.summary: GET /api/summary/artifacts/{job_id} and
    GET /api/summary/download/{job_id} — single-file passthrough, multi-file
    zip, unknown `p` -> 404, zero `p` -> 400.

No nilearn/matplotlib and no subprocess: the worker's manifest builder is a
pure function of (out_dir, ctx), and the routes are exercised against a
synthetic job directory with a hand-written status.json, exactly the shape
deps._run_summary_job persists from the worker's real JSON result (see
deps.py's `files={"artifacts": info.get("artifacts"), ...}`).
"""
import io
import json
import shutil
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import deps
import summary_render_worker as srw
from server import app

client = TestClient(app)


def _touch(p: Path, content: bytes = b"x"):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)


# === _build_manifest / _artifact ==============================================

def test_manifest_shape_excludes_lesion_and_status(tmp_path):
    out_dir = tmp_path / "job"
    out_dir.mkdir()

    # Artifacts the worker would have produced.
    _touch(out_dir / "brainsprite_lesion.html")
    _touch(out_dir / "brainsprite_tracts.html")
    _touch(out_dir / "images" / "retinotopy_disc.png")
    _touch(out_dir / "maps" / "affected_tracts.nii.gz")
    _touch(out_dir / "maps" / "affected_tracts.trk")
    _touch(out_dir / "data" / "atlas_overlap.csv")

    # Files that sit right next to the real artifacts in out_dir but must
    # NEVER appear in the manifest.
    _touch(out_dir / "lesion.nii.gz")
    _touch(out_dir / "status.json")

    ctx = {
        "brainsprite_file": "brainsprite_lesion.html",
        "dissect_brainsprite": "brainsprite_tracts.html",
        "retino_disc": "images/retinotopy_disc.png",
        # lnm_bs_pos/neg deliberately absent -> those stages were skipped.
    }

    artifacts = srw._build_manifest(out_dir, ctx)

    assert artifacts, "expected at least one artifact"
    required_keys = {"rel", "label", "kind", "bytes", "group", "default"}
    for a in artifacts:
        assert set(a.keys()) == required_keys
        assert isinstance(a["bytes"], int) and a["bytes"] > 0
        assert a["kind"] in {"html", "image", "map", "data"}
        assert a["group"] in {"Viewers", "Images", "Maps", "Data"}
        assert isinstance(a["default"], bool)

    rels = [a["rel"] for a in artifacts]
    assert len(rels) == len(set(rels)), "rel values must be unique"
    assert "lesion.nii.gz" not in rels
    assert "status.json" not in rels

    assert set(rels) == {
        "brainsprite_lesion.html", "brainsprite_tracts.html",
        "images/retinotopy_disc.png", "maps/affected_tracts.nii.gz",
        "maps/affected_tracts.trk", "data/atlas_overlap.csv",
    }


def test_manifest_drops_declared_but_missing_files(tmp_path):
    """A ctx rel that doesn't actually exist on disk (e.g. a brainsprite
    render that failed) must not produce a manifest entry."""
    out_dir = tmp_path / "job"
    out_dir.mkdir()
    ctx = {"brainsprite_file": "brainsprite_lesion.html"}  # never written
    assert srw._build_manifest(out_dir, ctx) == []


def test_write_overlap_csv_includes_provenance_comment_line(tmp_path):
    """Leading `# engine: ...` line — safe because nothing in the repo parses
    this file strictly (see _write_overlap_csv's docstring, and
    tests/test_summary_overlap.py for the full-job version of this check)."""
    overlap_model = {
        "atlasBreakdowns": [{
            "atlasName": "Atlas A",
            "rows": [{"regionName": "Alpha", "voxelCount": 27,
                     "percentOfLesion": 100.0, "percentOfRegion": 100.0}],
        }],
        "provenance": {"engine": "lqtpy", "version": "0.3.0", "threshold": 0.5,
                       "resampling": "atlas-grid"},
    }
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    wrote = srw._write_overlap_csv(data_dir, overlap_model)
    assert wrote is True

    lines = (data_dir / "atlas_overlap.csv").read_text().splitlines()
    assert lines[0] == "# engine: lqtpy 0.3.0 · threshold > 0.5 · atlas-grid"
    assert lines[1] == "atlas,region,voxels,pct_of_lesion,pct_of_region"
    assert lines[2] == "Atlas A,Alpha,27,100.0,100.0"


def test_write_overlap_csv_no_breakdowns_writes_nothing(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    assert srw._write_overlap_csv(data_dir, None) is False
    assert srw._write_overlap_csv(data_dir, {"atlasBreakdowns": []}) is False
    assert not (data_dir / "atlas_overlap.csv").exists()


def test_artifact_helper_reports_real_size(tmp_path):
    _touch(tmp_path / "images" / "retinotopy_disc.png", b"0123456789")
    entry = srw._artifact(tmp_path, "images/retinotopy_disc.png", "label",
                          "image", "Images", True)
    assert entry["bytes"] == 10


# === routes ====================================================================

ARTIFACTS = [
    {"rel": "brainsprite_lesion.html", "label": "Lesion viewer (interactive)",
     "kind": "html", "bytes": 1, "group": "Viewers", "default": True},
    {"rel": "maps/affected_tracts.nii.gz", "label": "Affected tracts (NIfTI)",
     "kind": "map", "bytes": 1, "group": "Maps", "default": False},
    {"rel": "data/atlas_overlap.csv", "label": "Atlas overlap table (CSV)",
     "kind": "data", "bytes": 1, "group": "Data", "default": True},
]

JOB_ID = "11111111-1111-4111-8111-111111111111"


def _make_job(job_id, artifacts, extra_files=()):
    """Write a synthetic job dir + status.json shaped exactly like
    deps._run_summary_job persists it, so the routes are exercised against
    the real on-disk contract rather than a mock."""
    job_dir = deps.SUMMARY_RESULTS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    for a in artifacts:
        _touch(job_dir / a["rel"], f"content-of-{a['rel']}".encode())
    for rel, content in extra_files:
        _touch(job_dir / rel, content)
    status = {
        "stage": "done", "message": "Summary ready.", "progress": 1.0,
        "done": True, "error": None,
        "files": {"artifacts": artifacts, "lesion_name": "lesion.nii.gz"},
    }
    (job_dir / "status.json").write_text(json.dumps(status))
    return job_dir


@pytest.fixture
def job():
    job_dir = _make_job(JOB_ID, ARTIFACTS,
                        extra_files=[("lesion.nii.gz", b"raw-lesion")])
    yield job_dir
    shutil.rmtree(job_dir, ignore_errors=True)


def test_artifacts_route_returns_manifest(job):
    r = client.get(f"/api/summary/artifacts/{JOB_ID}")
    assert r.status_code == 200
    body = r.json()
    assert body["job_id"] == JOB_ID
    rels = {a["rel"] for a in body["artifacts"]}
    assert rels == {a["rel"] for a in ARTIFACTS}
    assert "lesion.nii.gz" not in rels  # uploaded input never listed


def test_download_single_file_streams_raw_bytes(job):
    r = client.get(f"/api/summary/download/{JOB_ID}",
                   params={"p": "data/atlas_overlap.csv"})
    assert r.status_code == 200
    assert r.content == b"content-of-data/atlas_overlap.csv"
    assert "attachment" in r.headers.get("content-disposition", "")


def test_download_multi_file_returns_zip_with_exact_entries(job):
    r = client.get(f"/api/summary/download/{JOB_ID}",
                   params=[("p", "brainsprite_lesion.html"),
                           ("p", "maps/affected_tracts.nii.gz")])
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert set(zf.namelist()) == {"brainsprite_lesion.html",
                                  "maps/affected_tracts.nii.gz"}


def test_download_unknown_artifact_is_404(job):
    r = client.get(f"/api/summary/download/{JOB_ID}",
                   params={"p": "../etc/passwd"})
    assert r.status_code == 404


def test_download_unlisted_real_file_is_404(job):
    """lesion.nii.gz genuinely exists in job_dir but was never declared in
    the manifest -- the manifest check must reject it, not merely a
    traversal check (this is stronger than that)."""
    r = client.get(f"/api/summary/download/{JOB_ID}",
                   params={"p": "lesion.nii.gz"})
    assert r.status_code == 404


def test_download_zero_files_is_400(job):
    r = client.get(f"/api/summary/download/{JOB_ID}")
    assert r.status_code == 400


def test_artifacts_route_unknown_job_is_404():
    r = client.get("/api/summary/artifacts/99999999-9999-4999-8999-999999999999")
    assert r.status_code == 404


def test_download_invalid_job_id_is_400():
    r = client.get("/api/summary/download/not-a-uuid", params={"p": "x"})
    assert r.status_code == 400
