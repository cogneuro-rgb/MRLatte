"""Custom 4-D probability atlases (one map per region, the shipped tract
atlases' shape) import as what those are: a label map — each voxel's most
likely region, above a cut — plus the per-region binary stack kept as the
atlas's `tracts4d`, which the overlap readers take as `> 0`."""
import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import atlas_ops  # noqa: E402
import deps  # noqa: E402
from server import app  # noqa: E402

AFFINE = np.diag([2.0, 2.0, 2.0, 1.0])
AFFINE[:3, 3] = [-20.0, -20.0, -20.0]


def _prob_atlas():
    """Three regions on a 20^3 grid, as percentages: region 2 overlaps region 1
    and wins where it is more likely; region 3 is faint everywhere it exists."""
    data = np.zeros((20, 20, 20, 3), np.uint8)
    data[2:10, 2:10, 2:10, 0] = 80
    data[6:14, 6:14, 6:14, 1] = 90
    data[15:18, 15:18, 15:18, 2] = 10          # under a 25 % cut of the max (90)
    return data


def _save(path, data):
    nib.save(nib.Nifti1Image(data, AFFINE), str(path))
    return path


def test_label_map_is_the_most_likely_region_above_the_cut(tmp_path):
    data = _prob_atlas()
    labels_img, masks_img = atlas_ops.maxprob_from_4d(_save(tmp_path / "p.nii.gz", data), 0.25)
    labels = np.asarray(labels_img.dataobj)
    assert labels.shape == (20, 20, 20)
    assert labels[3, 3, 3] == 1 and labels[8, 8, 8] == 2 and labels[12, 12, 12] == 2
    assert labels[16, 16, 16] == 0 and labels[0, 0, 0] == 0
    masks = np.asarray(masks_img.dataobj)
    assert masks.shape == data.shape and masks.dtype == np.uint8
    assert masks[8, 8, 8, 0] == 1 and masks[8, 8, 8, 1] == 1     # overlap kept per region
    assert masks[..., 2].sum() == 0


def test_a_4d_atlas_imports_with_its_masks(tmp_path, monkeypatch):
    root = tmp_path / "module-root"
    (root / "atlases").mkdir(parents=True)
    monkeypatch.setattr(deps, "MODULE_ROOT", root)
    monkeypatch.setattr(deps, "ATLAS_DIR", root / "atlases")
    client = TestClient(app)
    vol = _save(tmp_path / "my_tracts.nii.gz", _prob_atlas())
    names = b"Alpha tract\nBeta tract\nGamma tract\n"
    r = client.post("/api/atlases/import/stage",
                    files={"volume": ("my_tracts.nii.gz", vol.read_bytes()),
                           "labels": ("names.txt", names)},
                    data={"name": "My tracts"})
    assert r.status_code == 200, r.text
    staged = r.json()
    assert staged["report"]["frames"] == 3 and staged["report"]["canSplitLR"] is False
    assert [x["name"] for x in staged["regions"]] == ["Alpha tract", "Beta tract", "Gamma tract"]

    r = client.post(f"/api/atlases/import/{staged['stageId']}/commit",
                    json={"id": "my_tracts", "name": "My tracts", "kind": "tracts",
                          "threshold": 0.25, "regions": staged["regions"]})
    assert r.status_code == 200, r.text
    folder = root / "atlases" / "my_tracts"
    desc = json.loads((folder / "atlas.json").read_text(encoding="utf-8"))
    assert desc["tracts4d"] == "my_tracts.tracts4d.nii.gz" and desc["kind"] == "tracts"
    assert nib.load(str(folder / desc["tracts4d"])).shape == (20, 20, 20, 3)
    assert nib.load(str(folder / desc["volume"])).ndim == 3
    listed = [a["id"] for a in client.get("/api/atlases").json()["atlases"]]
    assert "my_tracts" in listed
