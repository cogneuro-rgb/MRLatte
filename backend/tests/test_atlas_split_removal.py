"""Removing an atlas that left/right copies were split from takes the copies
with it (cascade); without cascade it is refused, as a copy can't outlive its
source."""
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import deps  # noqa: E402
from server import app  # noqa: E402


def _bilateral(path):
    data = np.zeros((40, 30, 30), np.int16)
    data[5:35, 5:14, 5:25] = 1      # spans x = 0
    data[21:35, 16:25, 5:25] = 2    # right side only
    affine = np.diag([2.0, 2.0, 2.0, 1.0])
    affine[:3, 3] = [-40.0, -30.0, -30.0]
    nib.save(nib.Nifti1Image(data, affine), str(path))
    return path


def test_removing_the_source_of_a_split_takes_the_copy_with_it(tmp_path, monkeypatch):
    root = tmp_path / "module-root"
    (root / "atlases").mkdir(parents=True)
    monkeypatch.setattr(deps, "MODULE_ROOT", root)
    monkeypatch.setattr(deps, "ATLAS_DIR", root / "atlases")
    client = TestClient(app)
    vol = _bilateral(tmp_path / "two.nii.gz")
    staged = client.post("/api/atlases/import/stage",
                         files={"volume": ("two.nii.gz", vol.read_bytes())}).json()
    r = client.post(f"/api/atlases/import/{staged['stageId']}/commit",
                    json={"id": "two", "regions": staged["regions"]})
    assert r.status_code == 200, r.text
    r = client.post("/api/atlases/two/derive-lr", json={})
    assert r.status_code == 200, r.text
    copy = r.json()["atlas"]["id"]

    assert client.delete("/api/atlases/two").status_code == 409
    r = client.delete("/api/atlases/two", params={"cascade": "true"})
    assert r.status_code == 200, r.text
    assert r.json()["alsoRemoved"] == [copy]
    listed = [a["id"] for a in client.get("/api/atlases").json()["atlases"]]
    assert "two" not in listed and copy not in listed
