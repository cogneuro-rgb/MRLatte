"""Backend smoke + static atlas asset tests for MRLatte (iter 3).

These are LIVE-SERVER integration tests: they need a backend already running and
REACT_APP_BACKEND_URL pointing at it. Without that there is nothing to talk to,
so the whole module skips — at collection time, before any import-time work.

Reading the variable with os.environ[...] at module scope used to raise KeyError
during collection, which aborted the ENTIRE backend suite (`pytest
backend/tests/` never got as far as running a single test). A missing optional
integration target must skip, not break collection for everyone else.
"""
import os
import json
import pytest

requests = pytest.importorskip("requests")

_BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not _BASE_URL:
    pytest.skip(
        "REACT_APP_BACKEND_URL is not set — these are live-server integration "
        "tests. Start the backend and set REACT_APP_BACKEND_URL=<its base url> "
        "to run them.",
        allow_module_level=True,
    )

BASE_URL = _BASE_URL.rstrip("/")

# Iter 3 added 4 standard atlases (aal, harvard_oxford_cort, harvard_oxford_sub, juelich)
# Paths are relative to the /atlases mount, which is grouped one folder per
# atlas family (Phase 4b).
ATLAS_FILES = [
    ("mni152/mni152.nii.gz", 1_000_000),
    ("wang2015/wang2015_prob.nii.gz", 50_000),
    ("wang2015/wang2015_maxprob.nii.gz", 20_000),
    ("benson14/benson14_polar_angle.nii.gz", 50_000),
    ("benson14/benson14_eccentricity.nii.gz", 50_000),
    ("benson14/benson14_visual_areas.nii.gz", 20_000),
    ("misc/visual_areas_v1v5.nii.gz", 20_000),
    ("aal/aal_atlas.nii.gz", 20_000),
    ("harvard_oxford/harvard_oxford_cort.nii.gz", 20_000),
    ("harvard_oxford/harvard_oxford_sub.nii.gz", 10_000),
    ("juelich/juelich_atlas.nii.gz", 10_000),
    ("destrieux/destrieux.nii.gz", 20_000),
]

LABEL_FILES = [
    "aal/aal_labels.json",
    "harvard_oxford/harvard_oxford_cort_labels.json",
    "harvard_oxford/harvard_oxford_sub_labels.json",
    "juelich/juelich_labels.json",
    "destrieux/destrieux_labels.json",
]


# === Backend API smoke ===
class TestApiSmoke:
    def test_api_root_hello_world(self):
        r = requests.get(f"{BASE_URL}/api/", timeout=15)
        assert r.status_code == 200
        assert r.json().get("message") == "Hello World"


# === Static atlas asset availability ===
class TestAtlasStatic:
    @pytest.mark.parametrize("fname,min_size", ATLAS_FILES)
    def test_atlas_volume_served(self, fname, min_size):
        url = f"{BASE_URL}/atlases/{fname}"
        r = requests.get(url, timeout=30)
        assert r.status_code == 200, f"{fname} returned {r.status_code}"
        assert len(r.content) >= min_size, f"{fname} too small: {len(r.content)}"
        # Accept either gzip magic or raw NIfTI-1 header (348 = 0x015C little-endian).
        # niivue auto-detects regardless of extension.
        head = r.content[:4]
        is_gzip = head[:2] == b"\x1f\x8b"
        is_nifti1 = head == b"\x5c\x01\x00\x00"  # sizeof_hdr=348 LE
        is_nifti2 = head == b"\x1c\x02\x00\x00"  # sizeof_hdr=540 LE (NIfTI-2)
        assert is_gzip or is_nifti1 or is_nifti2, f"{fname} bad magic: {head.hex()}"

    @pytest.mark.parametrize("fname", LABEL_FILES)
    def test_atlas_labels_json(self, fname):
        url = f"{BASE_URL}/atlases/{fname}"
        r = requests.get(url, timeout=15)
        assert r.status_code == 200, f"{fname} returned {r.status_code}"
        data = r.json()
        assert isinstance(data, list) and len(data) > 0, f"{fname} not a non-empty list"
        # validate shape of first entry
        sample = data[0]
        assert "index" in sample and "name" in sample, f"{fname} missing index/name keys"
        assert isinstance(sample["index"], int)
        assert isinstance(sample["name"], str) and len(sample["name"]) > 0

    def test_old_wang_file_removed(self):
        url = f"{BASE_URL}/atlases/wang2015/wang2015_visual_rois.nii.gz"
        r = requests.get(url, timeout=15)
        if r.status_code == 200:
            assert r.content[:2] != b"\x1f\x8b"
        else:
            assert r.status_code in (404, 403)

    def test_destrieux_labels_count(self):
        """Iter 4: Destrieux atlas (FreeSurfer aparc.a2009s) should have ~151 labels."""
        r = requests.get(f"{BASE_URL}/atlases/destrieux/destrieux_labels.json", timeout=15)
        assert r.status_code == 200
        data = r.json()
        # 150 sulco-gyral regions + 1 Background entry → ~151
        assert 140 <= len(data) <= 160, f"unexpected label count: {len(data)}"

    def test_visual_areas_v1v5_labels_range(self):
        """Iter 4: misc/visual_areas_v1v5.nii.gz should be the V1-V5 (Juelich indices 48-52) re-mapped file."""
        r = requests.get(f"{BASE_URL}/atlases/misc/visual_areas_v1v5.nii.gz", timeout=30)
        assert r.status_code == 200
        # magic check only — content is binary NIfTI; just ensure it's served
        head = r.content[:4]
        assert head[:2] == b"\x1f\x8b" or head == b"\x5c\x01\x00\x00"
