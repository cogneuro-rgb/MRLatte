"""An optional module is in use only while a job that needs it is running.

Opening the Longitudinal panel asks /api/longitudinal/available; the Tract
Dissection section asks /api/tracts/dissect/available. Both used to import
their package to answer, which put the module "in use" for the rest of the
session — the user saw "SimpleITK is in use" without ever using it. And the
comparison itself ran SimpleITK in the server, so even a finished comparison
kept it locked until restart. Now the probes only look the package up, the
work runs in worker processes, and the server counts a package in use only
while such a worker runs."""
import gzip
import inspect
import sys
import threading
import time

import numpy as np
import nibabel as nib
import pytest
from fastapi.testclient import TestClient

import deps
import routers.longitudinal as longitudinal
import routers.tracts as tracts
from server import app


def test_availability_probes_do_not_import_their_package():
    for fn, pkg in ((longitudinal.longitudinal_available, "SimpleITK"),
                    (tracts.tract_dissect_available, "dipy")):
        src = inspect.getsource(fn)
        assert f"import {pkg}" not in src and f"from {pkg}" not in src, fn.__name__


def test_longitudinal_probe_answers_from_the_package_spec(monkeypatch):
    calls = []
    monkeypatch.setattr(longitudinal, "package_present", lambda name: calls.append(name) or False)
    r = TestClient(app).get("/api/longitudinal/available").json()
    assert r["available"] is False and calls == ["SimpleITK"]
    assert "module store" in r["reason"]


def _nifti_bytes(data):
    img = nib.Nifti1Image(data.astype(np.float32), np.diag([2.0, 2.0, 2.0, 1.0]))
    return gzip.compress(img.to_bytes())


@pytest.mark.skipif(not deps.package_present("SimpleITK"), reason="SimpleITK not installed")
def test_a_comparison_runs_in_a_worker_and_leaves_simpleitk_unloaded():
    loaded_before = "SimpleITK" in sys.modules
    base = np.zeros((12, 12, 12))
    base[3:9, 3:9, 3:9] = 100.0
    follow = base.copy()
    follow[3:6, 3:9, 3:9] = 0.0                          # half the block is gone
    r = TestClient(app).post("/api/longitudinal/register", files={
        "baseline": ("baseline.nii.gz", _nifti_bytes(base)),
        "followup": ("followup.nii.gz", _nifti_bytes(follow))})
    assert r.status_code == 200, r.text
    assert r.headers["X-Same-Grid"] == "True"
    assert float(r.headers["X-Changed-Voxel-Pct"]) == 50.0
    diff = nib.Nifti1Image.from_bytes(gzip.decompress(r.content)).get_fdata()
    assert diff.min() == -100.0 and diff.max() == 0.0
    if not loaded_before:
        assert "SimpleITK" not in sys.modules            # the server never loaded it
    assert "SimpleITK" not in deps.packages_in_use()     # and the job is over


def test_a_worker_marks_its_packages_in_use_only_while_it_runs(tmp_path, monkeypatch):
    script = tmp_path / "slow_worker.py"
    script.write_text("import time; time.sleep(1.5); print('{}')\n")
    monkeypatch.setitem(deps.WORKER_PACKAGES, script, ("mrl_busy_pkg",))
    seen = []
    t = threading.Thread(target=deps._run_worker_json, args=(script, {}, tmp_path, 60))
    t.start()
    for _ in range(100):
        seen.append("mrl_busy_pkg" in deps.packages_in_use())
        if seen[-1]:
            break
        time.sleep(0.02)
    t.join()
    assert seen[-1] is True
    assert "mrl_busy_pkg" not in deps.packages_in_use()
