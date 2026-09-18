"""What the import wizard refuses, what it merely warns about, and the
lateralization probe that decides whether a left/right split is offered.

The refuse/warn split is the design here: refusing a legitimate atlas because
it is in an unusual space, or has labels its author never named, would just
push the user to edit files by hand.
"""
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import atlas_validate  # noqa: E402


def _save(tmp_path, data, affine=None, name="a.nii.gz"):
    if affine is None:
        affine = np.diag([2.0, 2.0, 2.0, 1.0])
        affine[:3, 3] = [-40.0, -30.0, -30.0]
    path = tmp_path / name
    nib.save(nib.Nifti1Image(data, affine), str(path))
    return path


def _bilateral(tmp_path):
    data = np.zeros((40, 30, 30), np.int16)
    data[5:35, 5:15, 5:25] = 1      # straddles x = 0
    data[21:35, 16:25, 5:25] = 2    # right only
    return _save(tmp_path, data)


# ── refusals ────────────────────────────────────────────────────────────────

def test_refuses_a_file_that_is_not_a_nifti(tmp_path):
    path = tmp_path / "x.nii.gz"
    path.write_bytes(b"definitely not a nifti")
    ok, reason, _ = atlas_validate.inspect_volume(path)
    assert not ok
    assert "readable" in reason.lower()


def test_refuses_a_4d_probabilistic_atlas_with_an_actionable_message(tmp_path):
    path = _save(tmp_path, np.zeros((10, 10, 10, 5), np.float32))
    ok, reason, _ = atlas_validate.inspect_volume(path)
    assert not ok
    # The user needs to know WHAT to do, not just that it failed.
    assert "max-probability" in reason


def test_refuses_an_empty_volume(tmp_path):
    path = _save(tmp_path, np.zeros((10, 10, 10), np.int16))
    ok, reason, _ = atlas_validate.inspect_volume(path)
    assert not ok
    assert "no non-zero labels" in reason


def test_refuses_nan(tmp_path):
    data = np.zeros((10, 10, 10), np.float32)
    data[0, 0, 0] = np.nan
    ok, reason, _ = atlas_validate.inspect_volume(_save(tmp_path, data))
    assert not ok
    assert "NaN" in reason


def test_refuses_a_singular_affine(tmp_path, monkeypatch):
    """nibabel refuses to WRITE a zero-volume affine, so this one can only
    arrive from a hand-built file — hence a stub rather than a fixture on disk.
    The guard still has to exist: a singular affine makes every world-space
    calculation downstream (centroids, the L/R split) silently meaningless."""
    data = np.zeros((10, 10, 10), np.int16)
    data[2:5, 2:5, 2:5] = 1
    path = _save(tmp_path, data)

    class _Stub:
        affine = np.diag([1.0, 1.0, 0.0, 1.0])
        dataobj = data

    monkeypatch.setattr(nib, "load", lambda _p: _Stub())
    ok, reason, _ = atlas_validate.inspect_volume(path)
    assert not ok
    assert "singular" in reason


# ── accepted, with warnings ─────────────────────────────────────────────────

def test_a_singleton_4th_dimension_is_squeezed_not_refused(tmp_path):
    data = np.zeros((10, 10, 10, 1), np.int16)
    data[2:5, 2:5, 2:5, 0] = 1
    ok, _reason, details = atlas_validate.inspect_volume(_save(tmp_path, data))
    assert ok
    assert details["shape"] == [10, 10, 10]
    assert any("single frame" in w for w in details["warnings"])


def test_a_continuous_map_is_accepted_but_flagged(tmp_path):
    data = np.zeros((10, 10, 10), np.float32)
    data[2:5, 2:5, 2:5] = 0.37
    ok, _reason, details = atlas_validate.inspect_volume(_save(tmp_path, data))
    assert ok
    assert details["kind"] == "continuous"
    assert any("not whole numbers" in w for w in details["warnings"])


def test_an_implausible_space_warns_rather_than_refuses(tmp_path):
    affine = np.diag([20.0, 20.0, 20.0, 1.0])       # 40 * 20 mm = far past MNI
    data = np.zeros((40, 40, 40), np.int16)
    data[2:5, 2:5, 2:5] = 1
    ok, _reason, details = atlas_validate.inspect_volume(_save(tmp_path, data, affine))
    assert ok
    assert any("MNI space" in w for w in details["warnings"])
    assert any("voxel size" in w for w in details["warnings"])


# ── lateralization ──────────────────────────────────────────────────────────

def test_detects_a_label_spanning_both_hemispheres(tmp_path):
    ok, _reason, details = atlas_validate.inspect_volume(_bilateral(tmp_path))
    assert ok
    assert details["lateralized"] is False
    assert details["bilateralValues"] == [1]        # label 2 is right-only
    assert details["voxelCounts"][1] > 0


def test_a_fully_one_sided_atlas_reports_lateralized(tmp_path):
    data = np.zeros((40, 30, 30), np.int16)
    data[21:35, 5:15, 5:25] = 1     # right
    data[5:19, 16:25, 5:25] = 2     # left
    ok, _reason, details = atlas_validate.inspect_volume(_save(tmp_path, data))
    assert ok
    assert details["lateralized"] is True
    assert details["bilateralValues"] == []


def test_side_is_decided_by_world_x_not_voxel_index(tmp_path):
    """The shipped atlases are LIA-native: voxel i is not left/right. Reading
    the side off the voxel index instead of the affine put the crosshair in the
    wrong hemisphere, which is exactly what this guards."""
    data = np.zeros((30, 40, 30), np.int16)
    data[5:25, 21:35, 5:25] = 1     # right half along the SECOND voxel axis
    affine = np.zeros((4, 4))
    affine[0, 1] = 2.0              # world x comes from voxel j
    affine[1, 0] = 2.0
    affine[2, 2] = 2.0
    affine[3, 3] = 1.0
    affine[:3, 3] = [-40.0, -30.0, -30.0]
    ok, _reason, details = atlas_validate.inspect_volume(_save(tmp_path, data, affine))
    assert ok
    assert details["lateralized"] is True
    assert details["bilateralValues"] == []


# ── label cross-check ───────────────────────────────────────────────────────

def test_cross_check_reports_both_directions(tmp_path):
    _ok, _reason, details = atlas_validate.inspect_volume(_bilateral(tmp_path))
    warnings = atlas_validate.cross_check_labels(details, [
        {"value": 1, "name": "Alpha"},
        {"value": 9, "name": "Ghost"},      # named, but no voxels
    ])                                       # label 2 present, but unnamed
    assert any("no name" in w for w in warnings)
    assert any("no voxels" in w for w in warnings)


def test_cross_check_is_silent_when_labels_match(tmp_path):
    _ok, _reason, details = atlas_validate.inspect_volume(_bilateral(tmp_path))
    assert atlas_validate.cross_check_labels(details, [
        {"value": 1, "name": "Alpha"}, {"value": 2, "name": "Beta"},
    ]) == []


@pytest.mark.parametrize("bad", [b"", b"\x00\x01\x02"])
def test_inspect_never_raises(tmp_path, bad):
    """(ok, reason, details), never an exception — the module_slots contract."""
    path = tmp_path / "junk.nii.gz"
    path.write_bytes(bad)
    ok, reason, details = atlas_validate.inspect_volume(path)
    assert ok is False and isinstance(reason, str) and isinstance(details, dict)
