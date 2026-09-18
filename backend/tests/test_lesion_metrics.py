"""Tests for the lqtpy-backed lesion-metrics engine (backend/lesion_metrics.py)
and its HTTP surface (backend/routers/lesion_metrics.py).

Synthetic lesions and a synthetic MRLatte-style atlas only — no real patient
data, no dependency on the real (large, gitignored) data/modules/atlases
payload. The synthetic atlas is built the same way
tests/test_atlas_registry.py's `make_atlas` builds one, so atlas_registry
discovers it exactly like it would a real installed atlas.
"""
import concurrent.futures
import io
import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import atlas_labels  # noqa: E402
import atlas_registry  # noqa: E402
import lesion_metrics  # noqa: E402
from server import app  # noqa: E402

client = TestClient(app)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

@pytest.fixture(autouse=True)
def _reset_bridge_state():
    """Every test gets a clean lqtpy-atlas-bridge cache so one test's
    registrations can never leak into another's (e.g. via a coincidentally
    matching mtime signature)."""
    lesion_metrics._bridge_state.clear()
    yield
    lesion_metrics._bridge_state.clear()


def _make_atlas(root: Path, atlas_id: str, *, shape=(8, 8, 8)):
    """A minimal but real MRLatte atlas folder: two labelled cubes on an
    identity-affine grid. Region 1 ("Alpha") occupies voxels [1:4, 1:4, 1:4]
    (27 voxels); region 2 ("Beta") occupies [5:7, 5:7, 5:7] (8 voxels)."""
    folder = root / atlas_id
    folder.mkdir(parents=True, exist_ok=True)
    data = np.zeros(shape, dtype=np.int16)
    data[1:4, 1:4, 1:4] = 1
    data[5:7, 5:7, 5:7] = 2
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(folder / f"{atlas_id}.nii.gz"))
    atlas_labels.write_labels(
        folder / f"{atlas_id}.labels.json",
        [{"value": 1, "name": "Alpha", "hemi": "Left", "color": None, "centroidMM": None},
         {"value": 2, "name": "Beta", "hemi": "Right", "color": None, "centroidMM": None}],
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
    """Point deps.ATLAS_DIR (and therefore atlas_registry) at a scratch
    directory holding one synthetic atlas, same pattern as
    test_atlas_registry.py's `atlas_root` fixture."""
    import deps
    root = tmp_path / "atlases"
    root.mkdir()
    monkeypatch.setattr(deps, "ATLAS_DIR", root)
    _make_atlas(root, "synth_parcellation")
    return root


def _nifti_bytes(data: np.ndarray, affine=None) -> bytes:
    img = nib.Nifti1Image(data.astype(np.float32), affine if affine is not None else np.eye(4))
    buf = io.BytesIO()
    file_map = img.make_file_map()
    file_map["image"].fileobj = buf
    img.to_file_map(file_map)
    return buf.getvalue()


def _upload(data: np.ndarray, affine=None, filename="lesion.nii") -> str:
    body = _nifti_bytes(data, affine)
    r = client.post("/api/lesion/upload", files={"file": (filename, body, "application/octet-stream")})
    assert r.status_code == 200, r.text
    return r.json()["lesion_id"]


def _cube_lesion(shape=(8, 8, 8)) -> np.ndarray:
    """Exactly overlaps region 1 of `_make_atlas` (27 voxels, value 1)."""
    data = np.zeros(shape, dtype=np.float32)
    data[1:4, 1:4, 1:4] = 1.0
    return data


# --------------------------------------------------------------------------- #
# Upload
# --------------------------------------------------------------------------- #

def test_upload_then_metrics_round_trip(synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/metrics", json={
        "lesion_id": lesion_id, "atlas_ids": ["synth_parcellation"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["lesion_stats"]["n_voxels"] == 27
    assert body["provenance"]["engine"] == "lqtpy"
    assert body["provenance"]["threshold"] == 0.5
    overlap = body["atlas_overlap"]["synth_parcellation"]
    alpha = next(r for r in overlap if r["RegionName"] == "Alpha")
    assert alpha["LesionVoxels"] == 27
    assert alpha["PercentDamage"] == 100.0
    assert alpha["PercentOfLesion"] == 100.0


def test_identical_bytes_return_same_lesion_id(synthetic_atlas):
    data = _cube_lesion()
    id1 = _upload(data)
    id2 = _upload(data)
    assert id1 == id2


def test_malformed_lesion_id_is_4xx():
    r = client.post("/api/lesion/metrics", json={
        "lesion_id": "not-a-sha256", "atlas_ids": [],
    })
    assert 400 <= r.status_code < 500, r.text


def test_unknown_lesion_id_is_404():
    r = client.post("/api/lesion/metrics", json={
        "lesion_id": "0" * 64, "atlas_ids": [],
    })
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# lqtpy-absent path
# --------------------------------------------------------------------------- #

def test_lqtpy_unavailable_is_503(monkeypatch, synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    monkeypatch.setattr(lesion_metrics, "lqtpy", None)
    r = client.post("/api/lesion/metrics", json={
        "lesion_id": lesion_id, "atlas_ids": [],
    })
    assert r.status_code == 503, r.text


def test_capabilities_reports_unavailable_when_lqtpy_absent(monkeypatch):
    monkeypatch.setattr(lesion_metrics, "lqtpy", None)
    r = client.get("/api/lesion/capabilities")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert body["atlas_ids"] == []
    assert body["disconnection_index_available"] is False


# --------------------------------------------------------------------------- #
# Caller error -> 4xx, not 500
# --------------------------------------------------------------------------- #

def test_empty_lesion_is_4xx_not_500(synthetic_atlas):
    lesion_id = _upload(np.zeros((8, 8, 8), dtype=np.float32))
    r = client.post("/api/lesion/metrics", json={
        "lesion_id": lesion_id, "atlas_ids": [],
    })
    assert 400 <= r.status_code < 500, r.text


def test_unknown_atlas_id_is_4xx_not_500(synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/metrics", json={
        "lesion_id": lesion_id, "atlas_ids": ["does_not_exist"],
    })
    assert 400 <= r.status_code < 500, r.text


# --------------------------------------------------------------------------- #
# Capabilities shape
# --------------------------------------------------------------------------- #

def test_capabilities_shape(synthetic_atlas):
    r = client.get("/api/lesion/capabilities")
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) >= {"available", "version", "disconnection_index_available", "atlas_ids"}
    assert isinstance(body["available"], bool)
    assert isinstance(body["atlas_ids"], list)
    if body["available"]:
        assert "synth_parcellation" in body["atlas_ids"]


# --------------------------------------------------------------------------- #
# Atlas bridging: synthetic MRLatte atlas -> lqtpy computes the SAME numbers
# whether reached through the bridge (compute_metrics) or lqtpy directly.
# --------------------------------------------------------------------------- #

def test_bridged_atlas_matches_lqtpy_direct_call(synthetic_atlas):
    lesion = _cube_lesion()
    lesion_id = _upload(lesion)

    r = client.post("/api/lesion/metrics", json={
        "lesion_id": lesion_id, "atlas_ids": ["synth_parcellation"],
    })
    assert r.status_code == 200, r.text
    via_bridge = r.json()["atlas_overlap"]["synth_parcellation"]

    # Same lesion array/affine, called straight through lqtpy.api using the
    # atlas the bridge just registered under the MRLatte id.
    lqtpy = pytest.importorskip("lqtpy")
    direct = lqtpy.atlas_overlap((lesion, np.eye(4)), "synth_parcellation", threshold=0.5)

    assert via_bridge == direct


# --------------------------------------------------------------------------- #
# Concurrency
# --------------------------------------------------------------------------- #

def test_concurrent_metrics_calls_agree(synthetic_atlas):
    lesion_id = _upload(_cube_lesion())

    def call():
        r = client.post("/api/lesion/metrics", json={
            "lesion_id": lesion_id, "atlas_ids": ["synth_parcellation"],
        })
        assert r.status_code == 200
        return r.json()

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: call(), range(16)))

    first = results[0]
    for other in results[1:]:
        assert other == first


# --------------------------------------------------------------------------- #
# overlap_model mapping (backend/lesion_metrics.py::build_overlap_model /
# _row_from_record) -- pins the record->row mapping the One-Click Summary job
# (deps.py's _summary_overlap_stage) relies on, so it can't silently drift
# from frontend/src/lib/lesionReport.js's resolveLesionAtlasMetrics, which
# this mirrors field-for-field (LesionVoxels->voxelCount, PercentDamage->
# percentOfRegion, PercentOfLesion->percentOfLesion).
# --------------------------------------------------------------------------- #

def test_row_from_record_matches_js_field_mapping():
    record = {
        "LabelID": 3, "RegionName": "Alpha", "Group": "Left",
        "RegionVoxels": 100, "LesionVoxels": 25,
        "PercentDamage": 25.0, "PercentOfLesion": 62.5,
    }
    row = lesion_metrics._row_from_record(record)
    assert row == {
        "label": 3, "regionName": "Alpha", "group": "Left",
        "voxelCount": 25, "regionVoxelCount": 100,
        "percentOfLesion": 62.5, "percentOfRegion": 25.0,
    }


def test_build_overlap_model_shape_and_sort_order():
    # Two atlases; "beta" region has more voxels than "alpha" so the sort
    # (descending by voxelCount) must reorder it first.
    result = {
        "lesion_stats": {
            "n_voxels": 40, "volume_mm3": 320.0, "volume_cc": 0.32,
            "center_of_mass_mm": [1.0, 2.0, 3.0],
        },
        "atlas_overlap": {
            "atlasA": [
                {"LabelID": 1, "RegionName": "alpha", "Group": "L",
                 "RegionVoxels": 50, "LesionVoxels": 10,
                 "PercentDamage": 20.0, "PercentOfLesion": 25.0},
                {"LabelID": 2, "RegionName": "beta", "Group": "R",
                 "RegionVoxels": 80, "LesionVoxels": 30,
                 "PercentDamage": 37.5, "PercentOfLesion": 75.0},
            ],
        },
        "provenance": {"engine": "lqtpy", "version": "0.3.0", "threshold": 0.5,
                       "resampling": "lesion→atlas grid"},
    }
    model = lesion_metrics.build_overlap_model(result, {"atlasA": "Atlas A"})

    assert model["volume"] == {
        "voxelCount": 40, "mm3": 320.0, "cm3": 0.32, "centroidMM": [1.0, 2.0, 3.0],
    }
    assert len(model["atlasBreakdowns"]) == 1
    b = model["atlasBreakdowns"][0]
    assert b["atlasId"] == "atlasA"
    assert b["atlasName"] == "Atlas A"
    assert b["voxelGrid"] == "atlas"
    assert [r["regionName"] for r in b["rows"]] == ["beta", "alpha"]  # sorted desc

    assert model["excludedAtlases"] == []  # caller fills this in, not this function
    assert model["provenance"] == {
        "engine": "lqtpy", "version": "0.3.0", "threshold": 0.5,
        "resampling": "atlas-grid", "fallback": False, "fallbackReason": None,
    }


def test_build_overlap_model_unknown_atlas_name_falls_back_to_id():
    result = {"lesion_stats": {}, "atlas_overlap": {"unnamed_id": []}}
    model = lesion_metrics.build_overlap_model(result, {})
    assert model["atlasBreakdowns"][0]["atlasName"] == "unnamed_id"
    assert model["atlasBreakdowns"][0]["rows"] == []


def test_build_overlap_model_empty_lesion_stats_defaults_volume_to_zero():
    model = lesion_metrics.build_overlap_model({}, {})
    assert model["volume"] == {"voxelCount": 0, "mm3": 0, "cm3": 0, "centroidMM": None}
    assert model["atlasBreakdowns"] == []


# --------------------------------------------------------------------------- #
# POST /api/lesion/report-fragments (backend/lesion_metrics.py::build_report_fragments)
# --------------------------------------------------------------------------- #

def _make_networked_atlas(root: Path, atlas_id: str, *, shape=(8, 8, 8)):
    """Like `_make_atlas`, but its two regions carry DIFFERENT `hemi` values
    ("Left"/"Right") -- i.e. >=2 distinct non-empty Group values, which is
    exactly what network_rollup_eligible() requires to consider an atlas
    eligible for a network rollup."""
    return _make_atlas(root, atlas_id, shape=shape)  # _make_atlas already uses Left/Right


def _make_ungrouped_atlas(root: Path, atlas_id: str, *, shape=(8, 8, 8)):
    """Two regions, both with `hemi: null` -- mirrors every real MRLatte atlas
    today (see data/modules/atlases/*/*.labels.json): no per-region group
    assignment, so network_rollup_eligible() must report False."""
    folder = root / atlas_id
    folder.mkdir(parents=True, exist_ok=True)
    data = np.zeros(shape, dtype=np.int16)
    data[1:4, 1:4, 1:4] = 1
    data[5:7, 5:7, 5:7] = 2
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(folder / f"{atlas_id}.nii.gz"))
    atlas_labels.write_labels(
        folder / f"{atlas_id}.labels.json",
        [{"value": 1, "name": "Alpha", "hemi": None, "color": None, "centroidMM": None},
         {"value": 2, "name": "Beta", "hemi": None, "color": None, "centroidMM": None}],
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
def synthetic_atlas_pair(tmp_path, monkeypatch):
    """One networked (Left/Right) and one ungrouped (hemi=null) synthetic
    atlas, both bridged, for network-rollup-availability tests."""
    import deps
    root = tmp_path / "atlases"
    root.mkdir()
    monkeypatch.setattr(deps, "ATLAS_DIR", root)
    _make_networked_atlas(root, "synth_networked")
    _make_ungrouped_atlas(root, "synth_ungrouped")
    return root


def _report_fragments_request(**overrides):
    body = {"lesion_id": "0" * 64, "atlas_ids": [], "sections": ["morphometry"]}
    body.update(overrides)
    return body


def test_report_fragments_unknown_section_is_4xx(synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": ["not_a_real_section"],
    })
    assert 400 <= r.status_code < 500, r.text


def test_report_fragments_valid_sections_allowlist(synthetic_atlas):
    lqtpy = pytest.importorskip("lqtpy")
    from lqtpy.report.style import VALID_SECTIONS
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": list(VALID_SECTIONS),
    })
    # Every valid id is accepted (200) even though some end up in `unavailable`
    # (parcel_damage/network_rollup need atlas_ids, disconnection needs an
    # index) -- only an id OUTSIDE VALID_SECTIONS should ever 4xx.
    assert r.status_code == 200, r.text


def test_report_fragments_lqtpy_unavailable_is_503(monkeypatch, synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    monkeypatch.setattr(lesion_metrics, "lqtpy", None)
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": ["morphometry"],
    })
    assert r.status_code == 503, r.text


def test_report_fragments_disconnection_unavailable_has_reason_never_proxy(monkeypatch, synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    monkeypatch.setattr(lesion_metrics, "disconnection_index_available", lambda: False)
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": ["disconnection"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert "disconnection" not in body["fragments"]
    assert "disconnection" in body["unavailable"]
    reason = body["unavailable"]["disconnection"]
    assert "build_discon_index" in reason  # actionable, not a bare "unavailable"
    # Never silently substitute the voxel-overlap proxy for real disconnection.
    assert "disconnection" not in body["fragments"]
    assert "tract_proxy" not in body["fragments"]


def test_report_fragments_disconnection_available_renders_real_fragment(monkeypatch, synthetic_atlas):
    lqtpy = pytest.importorskip("lqtpy")
    lesion_id = _upload(_cube_lesion())
    monkeypatch.setattr(lesion_metrics, "disconnection_index_available", lambda: True)
    fake_records = [
        {"tract": "AF_L", "name": "Arcuate Fasciculus (L)", "n_streamlines": 1000,
         "n_disconnected": 250, "percent_disconnected": 25.0},
    ]
    monkeypatch.setattr(lqtpy, "tract_disconnection", lambda *a, **k: fake_records)
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": ["disconnection"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert "disconnection" not in body["unavailable"]
    html = body["fragments"]["disconnection"]
    assert "Streamline disconnection" in html
    assert "25.0%" in html
    assert "NOT disconnection" not in html  # that badge belongs to tract_proxy only


def test_report_fragments_network_rollup_availability_per_atlas(synthetic_atlas_pair):
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id,
        "atlas_ids": ["synth_networked", "synth_ungrouped"],
        "sections": ["network_rollup"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    # At least one atlas (synth_networked) is eligible -> a fragment renders.
    assert "network_rollup" in body["fragments"]
    html = body["fragments"]["network_rollup"]
    # Assert on what MRLatte controls -- that the fragment rendered and carries
    # this atlas's groups -- not on lqtpy's heading text. lqtpy titles that
    # section from the data (Yeo-7 only when the groups really are the seven
    # Yeo networks), so pinning the wording here breaks on an upstream bump
    # while nothing is actually wrong. This fixture groups by hemisphere.
    assert "lqt-network-rollup" in html
    # Only DAMAGED groups get a row: this cube lesion lies entirely inside the
    # atlas's "Left" region, so "Right" is legitimately absent.
    assert "Left" in html
    assert "Yeo-7" not in html


def test_report_fragments_network_rollup_all_ineligible_is_unavailable(synthetic_atlas_pair):
    # synth_parcellation-style atlases (hemi: null for every region, i.e.
    # every real MRLatte atlas today) have no group to roll up by.
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": ["synth_ungrouped"], "sections": ["network_rollup"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert "network_rollup" not in body["fragments"]
    assert "network_rollup" in body["unavailable"]
    assert "synth_ungrouped" in body["unavailable"]["network_rollup"]


def test_network_rollup_eligible_function_directly(synthetic_atlas_pair):
    eligible, reason = lesion_metrics.network_rollup_eligible("synth_networked")
    assert eligible is True
    assert reason is None
    eligible, reason = lesion_metrics.network_rollup_eligible("synth_ungrouped")
    assert eligible is False
    assert "synth_ungrouped" in reason


def test_report_fragments_theme_colour_applied_in_stylesheet(synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": ["morphometry"],
        "theme": {"accent": "#123456"},
    })
    assert r.status_code == 200, r.text
    css = r.json()["stylesheet"]
    assert "--lqt-accent: #123456" in css


def test_report_fragments_default_theme_uses_mrlatte_colours(synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": ["morphometry"],
    })
    assert r.status_code == 200, r.text
    css = r.json()["stylesheet"]
    for value in lesion_metrics.MRLATTE_REPORT_THEME.values():
        assert value in css


def test_report_fragments_invalid_theme_colour_is_4xx(synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": ["morphometry"],
        "theme": {"accent": "not a colour; </style><script>x</script>"},
    })
    assert 400 <= r.status_code < 500, r.text


def test_report_fragments_unknown_theme_key_is_4xx(synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": ["morphometry"],
        "theme": {"totally_not_a_real_key": "#123456"},
    })
    assert 400 <= r.status_code < 500, r.text


def test_report_fragments_no_unescaped_request_echo(synthetic_atlas):
    """Neither an unknown section id nor an unknown atlas id -- both
    attacker-controlled strings in the request -- is ever reflected into any
    HTML this endpoint produces (`fragments`/`stylesheet`). Both are rejected
    outright (4xx) before any fragment is built; the invalid value only ever
    appears inside the JSON error `detail` string (a plain-text message the
    frontend surfaces via toast, never inserted as HTML), which this test
    does not treat as the thing being guarded against."""
    lesion_id = _upload(_cube_lesion())
    payload_str = '<img src=x onerror=alert(1)>'

    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": [payload_str],
    })
    assert 400 <= r.status_code < 500, r.text
    # No fragment/stylesheet HTML was ever built for a rejected request.
    assert "fragments" not in r.json() or payload_str not in json.dumps(r.json())

    r2 = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [payload_str], "sections": ["morphometry"],
    })
    assert 400 <= r2.status_code < 500, r2.text

    # A VALID, accepted request never echoes an (also-sent, but unused by any
    # rendered section) attacker string into fragment/stylesheet HTML either.
    r3 = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": ["morphometry"],
        "theme": {"accent": "#2563eb"},
    })
    assert r3.status_code == 200, r3.text
    body3 = r3.json()
    assert payload_str not in body3["stylesheet"]
    assert payload_str not in json.dumps(body3["fragments"])


def test_report_fragments_response_shape(synthetic_atlas):
    lesion_id = _upload(_cube_lesion())
    r = client.post("/api/lesion/report-fragments", json={
        "lesion_id": lesion_id, "atlas_ids": [], "sections": ["morphometry"],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) == {"stylesheet", "fragments", "unavailable", "provenance"}
    assert body["provenance"]["engine"] == "lqtpy"
    assert isinstance(body["provenance"]["disconnectionIndexAvailable"], bool)
    assert "<style" not in body["stylesheet"]  # stylesheet() returns bare CSS, no wrapper tag
    assert ".lqt-root" in body["stylesheet"]
