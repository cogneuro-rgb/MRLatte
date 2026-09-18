"""Atlas label lists: read anything, write one thing.

Atlases arrive in whatever format their author shipped. Before this module the
repo carried two on-disk JSON shapes and parsed them independently in five
places (lnm_backend, worker_common x2, summary_render_worker, and the
frontend), each with its own idea of whether keys were str or int. Adding a
sixth caller meant a sixth parser.

So: ONE reader that sniffs the format from the bytes, and ONE canonical shape
written back out:

    {"schemaVersion": 1,
     "regions": [{"value": 1, "name": "Frontal Pole",
                  "hemi": null, "color": null, "centroidMM": null}, ...]}

Formats accepted, in detection order:

  canonical   {"schemaVersion": .., "regions": [...]}
  legacy-list [{"index": 0, "name": "Background"}, ...]     (AAL, HO, JHU, ...)
  legacy-map  {"1": "V1v", "2": "V1d", ...}                 (wang2015, visfAtlas)
  csv         value,name with any number of trailing empty columns
              (neuroparc's Anatomical-labels-csv pads rows out to 7 columns)
  lut         index name R G B A, whitespace-separated, # comments
              (FreeSurfer LUT / FSL -- the only format carrying colours)
  fsl-xml     <label index="0" x=".." ..>Frontal Pole</label>
              (Harvard-Oxford's native distribution format)
  text        one name per line -> values 1..N

Detection reads content, never the filename: a .txt holding JSON is common
enough that trusting the extension just produces a confusing error later.

Value 0 is background by convention. It is dropped on read regardless of what
the source called it ("Background", "null", "empty", "Unknown", "???"), because
every consumer skips it and keeping it means every consumer must remember to.
"""
from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path

SCHEMA_VERSION = 1

# Names a source may use for label 0. Compared casefolded and stripped.
_BACKGROUND_NAMES = {
    "background", "null", "none", "empty", "unknown", "???", "n/a", "na", "",
}


class LabelParseError(ValueError):
    """The bytes are not a label list in any format we accept."""


def _is_background(value, name) -> bool:
    return int(value) == 0 or str(name).strip().casefold() in _BACKGROUND_NAMES


def _region(value, name, hemi=None, color=None, centroid=None) -> dict:
    return {
        "value": int(value),
        "name": str(name).strip(),
        "hemi": hemi,
        "color": [int(c) for c in color] if color else None,
        "centroidMM": [float(c) for c in centroid] if centroid else None,
    }


def _finish(regions) -> list:
    """Drop background, de-duplicate by value (first wins), sort by value."""
    seen, out = set(), []
    for r in regions:
        if _is_background(r["value"], r["name"]) or r["value"] in seen:
            continue
        seen.add(r["value"])
        out.append(r)
    out.sort(key=lambda r: r["value"])
    return out


# --------------------------------------------------------------------------- #
# Per-format parsers. Each takes decoded text and returns a region list, or
# raises LabelParseError. None is called directly -- parse_labels dispatches.
# --------------------------------------------------------------------------- #

def _parse_json(text: str):
    data = json.loads(text)

    # canonical
    if isinstance(data, dict) and isinstance(data.get("regions"), list):
        out = []
        for r in data["regions"]:
            if not isinstance(r, dict) or "value" not in r:
                raise LabelParseError("canonical labels: a region has no 'value'")
            out.append(_region(r["value"], r.get("name") or "Region %s" % r["value"],
                               r.get("hemi"), r.get("color"), r.get("centroidMM")))
        return out

    # legacy-list: [{"index": .., "name": ..}]
    if isinstance(data, list):
        out = []
        for e in data:
            if not isinstance(e, dict):
                raise LabelParseError("legacy label list: entries must be objects")
            if "index" not in e and "value" not in e:
                raise LabelParseError("legacy label list: entry has no 'index'")
            v = e.get("index", e.get("value"))
            out.append(_region(v, e.get("name") or "Region %s" % v,
                               e.get("hemi"), e.get("color"), e.get("centroidMM")))
        return out

    # neuroparc metadata: {"MetaData": {...}, "rois": {"1": {"label": .., "center": [..]}}}
    # Nine of the catalog's atlases ship no label CSV at all, and this is the
    # only place their region names exist. `center` is deliberately IGNORED:
    # neuroparc's centres are raw means, which for a bilateral single-label
    # region land on the midline outside the region itself. atlas_ops.region_stats
    # recomputes them snapped onto an in-region voxel at install time.
    if isinstance(data, dict) and isinstance(data.get("rois"), dict):
        out = []
        for k, v in data["rois"].items():
            try:
                val = int(k)
            except (TypeError, ValueError):
                continue
            name = v.get("label") if isinstance(v, dict) else v
            out.append(_region(val, name or "Region %d" % val))
        if not out:
            raise LabelParseError("neuroparc metadata has an empty 'rois' map")
        return out

    # legacy-map: {"1": "V1v"} -- the value may also be an object.
    if isinstance(data, dict):
        out = []
        for k, v in data.items():
            try:
                val = int(k)
            except (TypeError, ValueError):
                raise LabelParseError(
                    "label map: key %r is not an integer label value" % (k,))
            if isinstance(v, str):
                out.append(_region(val, v))
            elif isinstance(v, dict):
                out.append(_region(val, v.get("name") or "Region %s" % val,
                                   v.get("hemi"), v.get("color"), v.get("centroidMM")))
            else:
                raise LabelParseError("label map: value for %r is not a name" % (k,))
        return out

    raise LabelParseError("JSON is neither a label list nor a label map")


def _parse_csv(text: str):
    rows = list(csv.reader(io.StringIO(text)))
    out = []
    for i, row in enumerate(rows):
        cells = [c.strip() for c in row]
        while cells and cells[-1] == "":
            cells.pop()                      # neuroparc pads with empty columns
        if not cells:
            continue
        if len(cells) < 2:
            raise LabelParseError("CSV line %d: expected 'value,name'" % (i + 1))
        try:
            val = int(float(cells[0]))
        except ValueError:
            if i == 0:
                continue                     # a header row is fine, skip it
            raise LabelParseError(
                "CSV line %d: %r is not a label value" % (i + 1, cells[0]))
        color = None
        if len(cells) >= 5:                  # value,name,R,G,B
            try:
                color = [int(float(c)) for c in cells[2:5]]
            except ValueError:
                color = None
        out.append(_region(val, cells[1], color=color))
    if not out:
        raise LabelParseError("CSV contained no label rows")
    return out


_LUT_RE = re.compile(r"^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?\s*$")


def _parse_lut(text: str):
    out = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = _LUT_RE.match(line)
        if not m:
            raise LabelParseError(
                "LUT line is not 'index name R G B': %r" % line.strip())
        # LUT names are underscore-joined by convention; kept verbatim so they
        # still match whatever the source atlas's own documentation says.
        out.append(_region(m.group(1), m.group(2),
                           color=[int(m.group(3)), int(m.group(4)), int(m.group(5))]))
    if not out:
        raise LabelParseError("LUT contained no label rows")
    return out


def _parse_fsl_xml(text: str):
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise LabelParseError("not readable XML: %s" % exc) from exc
    out = []
    for node in root.iter("label"):
        raw = node.get("index")
        if raw is None:
            continue
        try:
            idx = int(raw)
        except ValueError:
            continue
        # FSL's XML indexes from 0 for the FIRST REAL REGION -- its background
        # is implicit, not listed. Shift so label N in the volume is region N.
        out.append(_region(idx + 1,
                           (node.text or "").strip() or "Region %d" % (idx + 1)))
    if not out:
        raise LabelParseError("XML contained no <label> elements")
    return out


# Anything that decoded to a replacement char or a C0 control (other than the
# whitespace ones) was not text to begin with.
_NOT_TEXT = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]")


def _parse_text(text: str):
    """One name per line -- the last-resort format.

    Guarded, because it is the fallback every other parser falls THROUGH to:
    without this, a NIfTI or any other binary dropped into the label slot
    "parses" into regions named after its bytes, and the user finds out only
    when the region list is gibberish.
    """
    if _NOT_TEXT.search(text):
        raise LabelParseError("this is a binary file, not a list of region names")
    names = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not names:
        raise LabelParseError("file contained no names")
    return [_region(i + 1, n) for i, n in enumerate(names)]


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

def parse_labels(data, hint: str = ""):
    """Parse label bytes/text into canonical regions.

    `hint` is an optional filename used only to break ties between formats that
    could both parse the same bytes; content always decides first.

    Raises LabelParseError with a user-facing message -- this text is shown in
    the import wizard, so it must say which formats were tried and what broke.
    """
    if isinstance(data, (bytes, bytearray)):
        text = bytes(data).decode("utf-8-sig", errors="replace")
    else:
        text = str(data)
    stripped = text.lstrip()
    if not stripped:
        raise LabelParseError("label file is empty")

    suffix = Path(hint).suffix.lower()
    attempts = []
    if stripped[0] in "[{":
        attempts.append(("JSON", _parse_json))
    elif stripped[0] == "<":
        attempts.append(("FSL XML", _parse_fsl_xml))
    else:
        # Plain-text family. A LUT has >=5 whitespace columns, a CSV has commas,
        # anything else is a bare name list. Try the best guess first, then the
        # others, so a near-miss still gets a chance.
        first = next((ln for ln in text.splitlines()
                      if ln.strip() and not ln.lstrip().startswith("#")), "")
        order = []
        if _LUT_RE.match(first):
            order = [("LUT", _parse_lut), ("CSV", _parse_csv)]
        elif "," in first or suffix in (".csv", ".tsv"):
            order = [("CSV", _parse_csv), ("LUT", _parse_lut)]
        else:
            order = [("CSV", _parse_csv), ("LUT", _parse_lut)]
        attempts.extend(order)
        attempts.append(("plain text", _parse_text))

    errors = []
    for label, fn in attempts:
        try:
            regions = _finish(fn(text))
        except Exception as exc:  # noqa: BLE001 -- a bad file is expected input
            errors.append("%s: %s" % (label, exc))
            continue
        if regions:
            return regions
        errors.append("%s: parsed, but no non-background labels" % label)

    raise LabelParseError(
        "could not read this as a label list. Tried " + "; ".join(errors))


def read_labels(path):
    """Read a label file from disk. Raises LabelParseError, or OSError."""
    p = Path(path)
    return parse_labels(p.read_bytes(), hint=p.name)


def read_labels_or_empty(path):
    """Best-effort read: [] when the file is absent or unreadable.

    For call sites that degrade gracefully -- worker_common.ho_overlap returns
    no rows rather than failing a whole dissection job when an atlas is not
    installed.
    """
    try:
        return read_labels(path)
    except (OSError, LabelParseError):
        return []


def write_labels(path, regions) -> None:
    """Write canonical labels. Values are re-sorted; background is dropped."""
    payload = {"schemaVersion": SCHEMA_VERSION, "regions": _finish(list(regions))}
    Path(path).write_text(
        json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")


def name_map(regions, key=int) -> dict:
    """{value: name}. Pass key=str for the callers that index by string."""
    return {key(r["value"]): r["name"] for r in regions}


def color_map(regions) -> dict:
    """{value: [r, g, b]} for the regions that carry a colour."""
    return {int(r["value"]): list(r["color"]) for r in regions if r.get("color")}
