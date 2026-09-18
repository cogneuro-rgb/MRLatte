"""Volume + label list are ONE fact.

atlas_ops.split_lr renumbers a whole atlas. If the volume and the label list
ever disagree about which integer is which region, every downstream readout —
the crosshair bar, the overlap table, the lesion report, the LNM region tables —
is confidently wrong with no visible symptom. These tests exist to make that
failure loud.
"""
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import atlas_ops  # noqa: E402
import atlas_validate  # noqa: E402


def _bilateral_atlas(tmp_path):
    """Two labels, each spanning both hemispheres, plus one right-only label."""
    shape = (40, 30, 30)
    data = np.zeros(shape, np.int16)
    # Disjoint j ranges: an overlapping label would OVERWRITE part of another
    # and quietly change what "bilateral" means for it.
    data[5:35, 5:14, 5:25] = 1      # spans x = 0
    data[5:35, 15:24, 5:25] = 2     # spans x = 0
    data[21:35, 25:29, 5:25] = 3    # right side only (world x > 0)
    affine = np.diag([2.0, 2.0, 2.0, 1.0])
    affine[:3, 3] = [-40.0, -30.0, -30.0]
    path = tmp_path / "src.nii.gz"
    nib.save(nib.Nifti1Image(data, affine), str(path))
    regions = [
        {"value": 1, "name": "Alpha", "hemi": None, "color": [10, 20, 30], "centroidMM": None},
        {"value": 2, "name": "Beta", "hemi": None, "color": None, "centroidMM": None},
        {"value": 3, "name": "Right Gamma", "hemi": None, "color": None, "centroidMM": None},
    ]
    return path, regions


def test_split_lr_keeps_volume_and_labels_in_step(tmp_path):
    path, regions = _bilateral_atlas(tmp_path)
    img, new = atlas_ops.split_lr(path, regions)
    data = np.asarray(img.dataobj)

    in_volume = {int(v) for v in np.unique(data) if v != 0}
    in_labels = {r["value"] for r in new}
    assert in_volume == in_labels, "volume integers and label values disagree"
    # Dense, gap-free renumbering.
    assert in_labels == set(range(1, len(new) + 1))


def test_split_lr_doubles_only_the_bilateral_labels(tmp_path):
    path, regions = _bilateral_atlas(tmp_path)
    _img, new = atlas_ops.split_lr(path, regions)
    names = [r["name"] for r in new]
    # Alpha and Beta straddle the midline -> two each; Gamma is one-sided -> one.
    assert "Alpha (L)" in names and "Alpha (R)" in names
    assert "Beta (L)" in names and "Beta (R)" in names
    # A label already on one side keeps its name: "Right Gamma (R)" reads as a bug.
    assert "Right Gamma" in names
    assert "Right Gamma (R)" not in names
    assert len(new) == 5


def test_split_lr_assigns_sides_by_world_x_not_voxel_index(tmp_path):
    path, regions = _bilateral_atlas(tmp_path)
    img, new = atlas_ops.split_lr(path, regions)
    data = np.asarray(img.dataobj)
    affine = np.asarray(img.affine, float)
    by_name = {r["name"]: r["value"] for r in new}

    for name, expect_negative in (("Alpha (L)", True), ("Alpha (R)", False)):
        idx = np.argwhere(data == by_name[name])
        xs = (idx * affine[0, :3]).sum(axis=1) + affine[0, 3]
        assert (xs < 0).all() if expect_negative else (xs >= 0).all(), name


def test_split_lr_carries_colours_and_marks_hemispheres(tmp_path):
    path, regions = _bilateral_atlas(tmp_path)
    _img, new = atlas_ops.split_lr(path, regions)
    alpha = [r for r in new if r["name"].startswith("Alpha")]
    assert all(r["color"] == [10, 20, 30] for r in alpha)
    assert {r["hemi"] for r in alpha} == {"L", "R"}
    # Centroids belong to the OLD numbering and must not be carried over.
    assert all(r["centroidMM"] is None for r in new)


def test_split_lr_leaves_the_source_untouched(tmp_path):
    path, regions = _bilateral_atlas(tmp_path)
    before = np.asarray(nib.load(str(path)).dataobj).copy()
    atlas_ops.split_lr(path, regions)
    after = np.asarray(nib.load(str(path)).dataobj)
    assert np.array_equal(before, after)


def test_split_lr_output_is_still_a_valid_atlas(tmp_path):
    path, regions = _bilateral_atlas(tmp_path)
    img, new = atlas_ops.split_lr(path, regions)
    out = tmp_path / "split.nii.gz"
    nib.save(img, str(out))
    ok, reason, details = atlas_validate.inspect_volume(out)
    assert ok, reason
    assert details["labelCount"] == len(new)
    # Every label is now one-sided, which is the entire point of the operation.
    assert details["lateralized"] is True
    assert details["bilateralValues"] == []


def test_region_mask_selects_exactly_those_labels(tmp_path):
    path, regions = _bilateral_atlas(tmp_path)
    src = np.asarray(nib.load(str(path)).dataobj)
    mask = np.asarray(atlas_ops.region_mask(path, [1, 3]).dataobj)
    assert mask.dtype == np.uint8
    assert np.array_equal(mask > 0, np.isin(src, [1, 3]))


def test_region_mask_refuses_an_empty_selection(tmp_path):
    path, _regions = _bilateral_atlas(tmp_path)
    with pytest.raises(ValueError):
        atlas_ops.region_mask(path, [])
    with pytest.raises(ValueError):
        atlas_ops.region_mask(path, [999])


def test_region_stats_centroid_lands_inside_its_own_region(tmp_path):
    """A bilateral single-label region's raw centroid sits on the midline,
    OUTSIDE the region. Navigating there puts the crosshair in the wrong
    hemisphere's white matter, which is the bug the snap fixes."""
    path, regions = _bilateral_atlas(tmp_path)
    stats = atlas_ops.region_stats(path, regions)
    img = nib.load(str(path))
    data = np.asarray(img.dataobj)
    inv = np.linalg.inv(np.asarray(img.affine, float))
    for value, s in stats.items():
        mm = np.array([*s["centroidMM"], 1.0])
        i, j, k = np.rint((inv @ mm)[:3]).astype(int)
        assert int(data[i, j, k]) == value, "centroid of %d is outside it" % value
        assert s["voxels"] > 0
        assert s["volumeMM3"] == pytest.approx(s["voxels"] * 8.0)


def test_split_count_matches_what_the_wizard_promised(tmp_path):
    """The import wizard shows atlas_validate's bilateral count BEFORE the user
    commits ("N regions span both sides ... giving M regions"). If split_lr uses
    a looser rule, the promise is wrong: a real Harvard-Oxford subcortical
    import reported 1 bilateral region and produced 5 extra, because a handful
    of partial-volume voxels bled across x = 0."""
    data = np.zeros((40, 30, 30), np.int16)
    data[5:35, 5:15, 5:25] = 1       # genuinely bilateral
    data[21:35, 16:25, 5:25] = 2     # right-only...
    data[19:21, 16:25, 5:25] = 2     # ...with a two-voxel bleed past the midline

    affine = np.diag([2.0, 2.0, 2.0, 1.0])
    affine[:3, 3] = [-40.0, -30.0, -30.0]
    path = tmp_path / "src.nii.gz"
    nib.save(nib.Nifti1Image(data, affine), str(path))
    regions = [{"value": 1, "name": "Alpha", "hemi": None, "color": None, "centroidMM": None},
               {"value": 2, "name": "Beta", "hemi": None, "color": None, "centroidMM": None}]

    _ok, _reason, details = atlas_validate.inspect_volume(path)
    promised = details["labelCount"] + len(details["bilateralValues"])

    _img, new = atlas_ops.split_lr(path, regions)
    assert len(new) == promised, (
        "wizard promised %d regions, split produced %d" % (promised, len(new)))
    # Beta's midline bleed must not have spawned a sliver region.
    assert sorted(r["name"] for r in new) == ["Alpha (L)", "Alpha (R)", "Beta"]
