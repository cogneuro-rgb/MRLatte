"""Tract dissection's engine (dipy) is a one-click module, not part of the
bundle: with the tractogram present but dipy not installed, every dissection
endpoint says which module to install instead of failing inside a worker."""
import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import routers.tracts as tracts
from server import app

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def no_dipy(tmp_path, monkeypatch):
    trk = tmp_path / "whole_brain.trk"
    trk.write_bytes(b"x")
    monkeypatch.setattr(tracts, "GLOBAL_TRACT_FILE", trk)
    monkeypatch.setattr(tracts, "dipy_installed", lambda: False)


@pytest.mark.parametrize("path", ["/api/tracts/dissect", "/api/tracts/dissect/start",
                                  "/api/tracts/dissect/between", "/api/tracts/dissect/between/start"])
def test_dissection_without_dipy_points_to_the_module(no_dipy, path):
    files = {"file": ("lesion.nii.gz", io.BytesIO(b"x"), "application/gzip"),
             "file_a": ("a.nii.gz", io.BytesIO(b"x"), "application/gzip"),
             "file_b": ("b.nii.gz", io.BytesIO(b"x"), "application/gzip")}
    r = TestClient(app).post(path, files=files)
    assert r.status_code == 503, r.text
    assert "module store" in r.json()["detail"]


def test_the_manifest_makes_dipy_a_module_and_dissection_need_it():
    manifest = json.loads((REPO / "data" / "modules" / "manifest.json").read_text(encoding="utf-8"))
    entry = next(m for m in manifest["modules"] if m["id"] == "tract-dissection-dipy")
    assert entry["type"] == "python-package" and entry["pythonPackages"] == ["dipy"]
    assert "dissect" in entry["unlocks"]
    frozen = (REPO / "backend" / "requirements-frozen.txt").read_text()
    assert not any(line.strip().lower().startswith("dipy") for line in frozen.splitlines())
