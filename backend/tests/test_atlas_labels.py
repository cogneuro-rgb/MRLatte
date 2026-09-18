"""Every label format the import wizard accepts must land on ONE canonical shape.

This is the regression net for the thing that motivated atlas_labels: the repo
carried two on-disk JSON shapes parsed independently in five places, each with
its own idea of whether keys were str or int and whether background was
included.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import atlas_labels  # noqa: E402

# The same three regions expressed eight different ways.
EXPECTED = [
    {"value": 1, "name": "Frontal Pole"},
    {"value": 2, "name": "Insular Cortex"},
    {"value": 3, "name": "Superior Frontal Gyrus"},
]

CANONICAL = json.dumps({"schemaVersion": 1, "regions": [
    {"value": 1, "name": "Frontal Pole", "hemi": None, "color": None, "centroidMM": None},
    {"value": 2, "name": "Insular Cortex"},
    {"value": 3, "name": "Superior Frontal Gyrus"},
]})

LEGACY_LIST = json.dumps([
    {"index": 0, "name": "Background"},
    {"index": 1, "name": "Frontal Pole"},
    {"index": 2, "name": "Insular Cortex"},
    {"index": 3, "name": "Superior Frontal Gyrus"},
])

LEGACY_MAP = json.dumps({
    "1": "Frontal Pole", "2": "Insular Cortex", "3": "Superior Frontal Gyrus",
})

NEUROPARC_META = json.dumps({
    "MetaData": {"AtlasName": "demo"},
    "rois": {
        "0": {"label": "empty", "center": [0, 0, 0], "size": 1},
        "1": {"label": "Frontal Pole", "center": [2, 56, 8], "size": 10},
        "2": {"label": "Insular Cortex", "center": [0, 0, 0], "size": 10},
        "3": {"label": "Superior Frontal Gyrus", "center": [0, 0, 0], "size": 10},
    },
})

# neuroparc pads every row out to seven columns.
CSV = ("0,null,,,,,\n"
       "1,Frontal Pole,,,,,\n"
       "2,Insular Cortex,,,,,\n"
       "3,Superior Frontal Gyrus,,,,,\n")

LUT = ("# demo LUT\n"
       "0  Unknown                 0   0   0    0\n"
       "1  Frontal_Pole           70  130 180  255\n"
       "2  Insular_Cortex        220  20  60   255\n"
       "3  Superior_Frontal      100  149 237  255\n")

FSL_XML = ("<atlas><data>"
           '<label index="0" x="1" y="2" z="3">Frontal Pole</label>'
           '<label index="1" x="1" y="2" z="3">Insular Cortex</label>'
           '<label index="2" x="1" y="2" z="3">Superior Frontal Gyrus</label>'
           "</data></atlas>")

TEXT = "Frontal Pole\nInsular Cortex\nSuperior Frontal Gyrus\n"


@pytest.mark.parametrize("payload,hint", [
    (CANONICAL, "a.labels.json"),
    (LEGACY_LIST, "a_labels.json"),
    (LEGACY_MAP, "a_labels.json"),
    (NEUROPARC_META, "a.json"),
    (CSV, "a.csv"),
    (FSL_XML, "a.xml"),
    (TEXT, "a.txt"),
])
def test_every_format_yields_the_same_three_regions(payload, hint):
    got = atlas_labels.parse_labels(payload, hint=hint)
    assert [{"value": r["value"], "name": r["name"]} for r in got] == EXPECTED


def test_lut_carries_colours_through():
    """A LUT is the only format with colours; losing them silently would
    downgrade an imported atlas to the `random` colormap for no visible reason."""
    got = atlas_labels.parse_labels(LUT, hint="a.txt")
    assert [r["value"] for r in got] == [1, 2, 3]
    assert got[0]["color"] == [70, 130, 180]
    assert atlas_labels.color_map(got) == {
        1: [70, 130, 180], 2: [220, 20, 60], 3: [100, 149, 237]}


@pytest.mark.parametrize("payload,hint", [
    (LEGACY_LIST, "a.json"), (CSV, "a.csv"), (TEXT, "a.txt"),
])
def test_background_is_dropped_whatever_it_is_called(payload, hint):
    """Value 0 never survives a read, so no consumer has to remember to skip it."""
    got = atlas_labels.parse_labels(payload, hint=hint)
    assert all(r["value"] != 0 for r in got)
    assert not any(r["name"].lower() in {"background", "null", "unknown"} for r in got)


def test_round_trip_is_stable(tmp_path):
    path = tmp_path / "x.labels.json"
    first = atlas_labels.parse_labels(LEGACY_LIST, hint="a.json")
    atlas_labels.write_labels(path, first)
    second = atlas_labels.read_labels(path)
    assert first == second
    atlas_labels.write_labels(path, second)
    assert atlas_labels.read_labels(path) == second


def test_name_map_keys_can_be_str_or_int():
    """worker_common.ho_overlap indexed by str, tracts4d_overlap by int. Both
    are supported so neither call site needs its own conversion."""
    regions = atlas_labels.parse_labels(LEGACY_MAP, hint="a.json")
    assert atlas_labels.name_map(regions) == {
        1: "Frontal Pole", 2: "Insular Cortex", 3: "Superior Frontal Gyrus"}
    assert atlas_labels.name_map(regions, key=str)["1"] == "Frontal Pole"


def test_unreadable_input_raises_a_message_naming_what_was_tried():
    with pytest.raises(atlas_labels.LabelParseError) as exc:
        atlas_labels.parse_labels(b"\x00\x01\x02 not a label list at all", hint="x.bin")
    assert "Tried" in str(exc.value)


def test_empty_file_is_refused():
    with pytest.raises(atlas_labels.LabelParseError):
        atlas_labels.parse_labels(b"   ", hint="x.csv")


def test_read_labels_or_empty_never_raises(tmp_path):
    """The dissection workers degrade to "no rows" rather than failing a job."""
    assert atlas_labels.read_labels_or_empty(tmp_path / "nope.json") == []
    bad = tmp_path / "bad.json"
    bad.write_bytes(b"{ not json")
    assert atlas_labels.read_labels_or_empty(bad) == []


def test_shipped_atlases_all_parse():
    """The real files, in the canonical layout the migration produced."""
    import atlas_registry
    found = atlas_registry.scan()
    if not found:
        pytest.skip("no atlases installed in this module root")
    for d in found:
        regions = atlas_labels.read_labels(d["labelsPath"])
        assert regions, d["id"]
        assert all(r["value"] > 0 for r in regions), d["id"]
        assert all(r["name"] for r in regions), d["id"]
