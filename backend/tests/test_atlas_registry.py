"""Registry behaviour: discovery, aliases, order, and the delete guards.

The delete guards matter most. Atlases deliberately do NOT go through
routers/modules._uninstall_guard (a shipped atlas has no install-ledger entry
and would always 409), so this file is the only thing standing between "remove
one atlas" and "remove something that was never ours".
"""
import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import atlas_labels  # noqa: E402
import atlas_registry  # noqa: E402


def make_atlas(root: Path, atlas_id: str, *, aliases=None, derived_from=None,
               names=("Alpha", "Beta")):
    folder = root / atlas_id
    folder.mkdir(parents=True, exist_ok=True)
    data = np.zeros((8, 8, 8), np.int16)
    data[1:4, 1:4, 1:4] = 1
    data[5:7, 5:7, 5:7] = 2
    nib.save(nib.Nifti1Image(data, np.eye(4)), str(folder / ("%s.nii.gz" % atlas_id)))
    atlas_labels.write_labels(
        folder / ("%s.labels.json" % atlas_id),
        [{"value": i + 1, "name": n, "hemi": None, "color": None, "centroidMM": None}
         for i, n in enumerate(names)])
    desc = {
        "schemaVersion": 1, "id": atlas_id, "aliases": list(aliases or []),
        "name": "Atlas %s" % atlas_id, "short": atlas_id, "description": "",
        "kind": "parcellation", "space": "MNI152",
        "volume": "%s.nii.gz" % atlas_id, "labels": "%s.labels.json" % atlas_id,
        "colormap": "random", "opacity": 0.55, "ignoreZeroVoxels": True,
        "origin": {"kind": "builtin"}, "license": {},
    }
    if derived_from:
        desc["derivedFrom"] = derived_from
        desc["origin"] = {"kind": "derived", "derivedFrom": derived_from}
    (folder / "atlas.json").write_text(json.dumps(desc), encoding="utf-8")
    return folder


@pytest.fixture()
def atlas_root(tmp_path, monkeypatch):
    """Point deps.ATLAS_DIR at a scratch directory for the duration of a test."""
    import deps
    root = tmp_path / "atlases"
    root.mkdir()
    monkeypatch.setattr(deps, "ATLAS_DIR", root)
    return root


def test_only_folders_with_a_descriptor_are_atlases(atlas_root):
    """benson14/, surfaces/, mni152/ and misc/ live under the same root and are
    not parcellations. The atlas.json probe is what keeps them out."""
    make_atlas(atlas_root, "aaa")
    (atlas_root / "surfaces").mkdir()
    (atlas_root / "surfaces" / "lh.gii").write_bytes(b"not an atlas")
    (atlas_root / "loose_file.nii.gz").write_bytes(b"x")

    assert [d["id"] for d in atlas_registry.scan()] == ["aaa"]


def test_resolve_matches_id_case_insensitively_and_by_alias(atlas_root):
    make_atlas(atlas_root, "harvard_oxford_cort", aliases=["ho_cort", "harvard_oxford"])
    for key in ("harvard_oxford_cort", "HARVARD_OXFORD_CORT", "ho_cort", "harvard_oxford"):
        assert atlas_registry.resolve(key)["id"] == "harvard_oxford_cort", key
    assert atlas_registry.resolve("nope") is None
    assert atlas_registry.resolve("") is None


def test_an_exact_id_beats_another_atlas_alias(atlas_root):
    """Two atlases must never fight over a name: an id is authoritative."""
    make_atlas(atlas_root, "yeo7", aliases=["yeo"])
    make_atlas(atlas_root, "yeo", aliases=[])
    assert atlas_registry.resolve("yeo")["id"] == "yeo"


def test_order_persists_and_new_atlases_land_at_the_end(atlas_root):
    for i in ("aaa", "bbb", "ccc"):
        make_atlas(atlas_root, i)
    atlas_registry.set_order(["ccc", "aaa", "bbb"])
    assert [d["id"] for d in atlas_registry.list_atlases()] == ["ccc", "aaa", "bbb"]

    # An atlas installed after the order was saved must not jump into the middle.
    make_atlas(atlas_root, "ddd")
    assert [d["id"] for d in atlas_registry.list_atlases()] == ["ccc", "aaa", "bbb", "ddd"]


def test_order_ignores_unknown_ids(atlas_root):
    make_atlas(atlas_root, "aaa")
    assert atlas_registry.set_order(["ghost", "aaa"]) == ["aaa"]


def test_hidden_is_recorded_and_filterable(atlas_root):
    make_atlas(atlas_root, "aaa")
    make_atlas(atlas_root, "bbb")
    atlas_registry.set_hidden("bbb", True)
    assert [d["id"] for d in atlas_registry.list_atlases(include_hidden=False)] == ["aaa"]
    assert {d["id"]: d["hidden"] for d in atlas_registry.list_atlases()} == {
        "aaa": False, "bbb": True}
    atlas_registry.set_hidden("bbb", False)
    assert [d["id"] for d in atlas_registry.list_atlases(include_hidden=False)] == ["aaa", "bbb"]


def test_patch_writes_the_descriptor_and_leaves_unset_fields_alone(atlas_root):
    make_atlas(atlas_root, "aaa")
    before = atlas_registry.require("aaa")
    after = atlas_registry.patch("aaa", {"name": "Renamed", "kind": None, "opacity": None})
    assert after["name"] == "Renamed"
    assert after["kind"] == before["kind"]
    assert after["opacity"] == before["opacity"]
    # Persisted, not just returned.
    assert atlas_registry.resolve("aaa")["name"] == "Renamed"


def test_patch_rejects_an_unknown_kind(atlas_root):
    make_atlas(atlas_root, "aaa")
    with pytest.raises(atlas_registry.AtlasError):
        atlas_registry.patch("aaa", {"kind": "banana"})


def test_patch_never_writes_resolved_paths_into_the_descriptor(atlas_root):
    """`dir`/`volumePath` are computed per machine; baking them into atlas.json
    would break the folder the moment it moved or was installed elsewhere."""
    make_atlas(atlas_root, "aaa")
    atlas_registry.patch("aaa", {"name": "Renamed"})
    raw = json.loads((atlas_root / "aaa" / "atlas.json").read_text(encoding="utf-8"))
    for leaked in ("dir", "volumePath", "labelsPath", "url", "labelsUrl", "installed", "bytes"):
        assert leaked not in raw


def test_region_colours_are_stored_on_the_labels_not_in_app_state(atlas_root):
    make_atlas(atlas_root, "aaa")
    atlas_registry.set_region_colors("aaa", {1: [255, 0, 0]})
    regions = atlas_registry.labels_for("aaa")
    assert regions[0]["color"] == [255, 0, 0]
    assert regions[1]["color"] is None
    # Passing None clears one back to the colormap default.
    atlas_registry.set_region_colors("aaa", {1: None})
    assert atlas_registry.labels_for("aaa")[0]["color"] is None


def test_remove_deletes_the_folder_and_drops_it_from_state(atlas_root):
    make_atlas(atlas_root, "aaa")
    make_atlas(atlas_root, "bbb")
    atlas_registry.set_order(["bbb", "aaa"])
    res = atlas_registry.remove("aaa")
    assert res["id"] == "aaa"
    assert res["removed"] in ("trashed", "deleted")
    assert not (atlas_root / "aaa").exists()
    assert (atlas_root / "bbb").exists()
    assert atlas_registry.load_state()["order"] == ["bbb"]


def test_remove_refuses_an_atlas_another_one_was_derived_from(atlas_root):
    make_atlas(atlas_root, "parent")
    make_atlas(atlas_root, "parent_lr", derived_from="parent")
    with pytest.raises(atlas_registry.AtlasError) as exc:
        atlas_registry.remove("parent")
    assert "parent_lr" in str(exc.value)
    assert (atlas_root / "parent").exists()
    # The child alone is removable, and then the parent is too.
    atlas_registry.remove("parent_lr")
    atlas_registry.remove("parent")
    assert atlas_registry.scan() == []


def test_remove_refuses_something_outside_the_atlas_directory(atlas_root, tmp_path, monkeypatch):
    """The containment guard: an atlas.json is a plain file a user can edit, so
    a descriptor is never trusted to point wherever it likes."""
    outside = tmp_path / "elsewhere"
    make_atlas(outside, "escapee")
    # Register it under the atlas root by path only — the folder itself is not
    # inside the root, which is exactly what must be refused.
    monkeypatch.setattr(atlas_registry, "scan", lambda: [
        dict(atlas_registry.read_descriptor(outside / "escapee"), hidden=False, checksums={})])
    with pytest.raises(atlas_registry.AtlasError) as exc:
        atlas_registry.remove("escapee")
    assert "outside" in str(exc.value)
    assert (outside / "escapee").exists()


def test_remove_refuses_an_unknown_atlas(atlas_root):
    with pytest.raises(atlas_registry.AtlasError):
        atlas_registry.remove("ghost")


def test_slug_and_reserved_ids(atlas_root):
    assert atlas_registry.slug("My Atlas (v2)!") == "my_atlas_v2"
    assert atlas_registry.slug("  Jülich  ") == "j_lich"
    assert atlas_registry.is_valid_id("my_atlas")
    assert not atlas_registry.is_valid_id("My Atlas")
    assert not atlas_registry.is_valid_id("")
    # A reserved folder holds non-atlas assets; claiming it would shadow them.
    for reserved in ("mni152", "benson14", "surfaces"):
        assert not atlas_registry.is_valid_id(reserved)


def test_within_atlas_dir_rejects_traversal(atlas_root):
    assert atlas_registry.within_atlas_dir(atlas_root / "aaa")
    assert not atlas_registry.within_atlas_dir(atlas_root.parent)
    assert not atlas_registry.within_atlas_dir(atlas_root / ".." / "elsewhere")


def test_a_corrupt_descriptor_is_skipped_not_fatal(atlas_root):
    make_atlas(atlas_root, "good")
    bad = atlas_root / "bad"
    bad.mkdir()
    (bad / "atlas.json").write_text("{ not json", encoding="utf-8")
    assert [d["id"] for d in atlas_registry.scan()] == ["good"]


def test_tracts4d_survives_a_descriptor_round_trip(atlas_root):
    """deps._atlas_specs_for reads this to pick the per-bundle dissection mode;
    dropping it silently downgrades HCP1065 to winner-take-all."""
    folder = make_atlas(atlas_root, "hcp")
    desc = json.loads((folder / "atlas.json").read_text(encoding="utf-8"))
    desc["tracts4d"] = "hcp.tracts4d.nii.gz"
    (folder / "atlas.json").write_text(json.dumps(desc), encoding="utf-8")

    assert atlas_registry.resolve("hcp")["tracts4d"] == "hcp.tracts4d.nii.gz"
    atlas_registry.patch("hcp", {"name": "Renamed"})
    assert atlas_registry.resolve("hcp")["tracts4d"] == "hcp.tracts4d.nii.gz"
