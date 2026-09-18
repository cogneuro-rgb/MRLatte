"""The atlas registry: one source of truth for what atlases exist.

Before this, "which atlases does MRLatte have" was answered by a hardcoded
array in the frontend (atlasConfig.STANDARD_ATLASES, 6 entries) that had drifted
from what was actually on disk (11), from what the manifest declared (9), and
from three separate hardcoded id lists in the backend. Every consumer had its
own partial answer.

Now an atlas is a self-describing FOLDER under ATLAS_DIR:

    <ATLAS_DIR>/<id>/
        atlas.json          identity + display defaults  (the registry's unit)
        <id>.nii.gz         the volume
        <id>.labels.json    canonical labels (see atlas_labels)

A folder without an atlas.json is not an atlas and is ignored, which is what
keeps benson14/, wang2015/, wm_retinotopy/, surfaces/, mni152/ and misc/ out of
here -- those are consumed by RETINOTOPY_LAYERS, BASE_VOLUME and the validation
router, and have nothing to do with parcellations.

DELIBERATELY NOT THE MODULE LEDGER. `manifest.installed.json` records what the
module installer installed, and `_uninstall_guard` in routers/modules.py refuses
to remove anything absent from it -- correctly, because a repo-tracked payload
is part of the checkout, not a managed install. Atlases need per-atlas
add/remove regardless of how they got there, so they carry their own state file
and their own containment guard, and the module ledger is left exactly as it is.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import atlas_labels

STATE_FILENAME = "atlases.state.json"
DESCRIPTOR_FILENAME = "atlas.json"
SCHEMA_VERSION = 1

KINDS = ("parcellation", "networks", "tracts", "tracts4d", "continuous")
ORIGINS = ("builtin", "catalog", "import", "derived")

# Folders under ATLAS_DIR that hold non-atlas assets. Not a filter (the
# atlas.json probe already excludes them) -- listed so the migration and the
# import wizard refuse to claim these ids.
RESERVED_IDS = frozenset({
    "mni152", "benson14", "wang2015", "wm_retinotopy", "surfaces", "misc",
})

_SLUG_RE = re.compile(r"[^a-z0-9_]+")


class AtlasError(ValueError):
    """A registry operation the caller must surface to the user."""


# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #

def atlas_dir() -> Path:
    """Absolute path to the atlas root, resolved fresh on every call.

    `deps.ATLAS_DIR` is bound at import, so a module-level copy here would go
    stale whenever a test or the launcher repoints deps.MODULE_ROOT. Same lazy
    `import deps` trick as lnm_backend.atlas_dir_path(), for the same reason:
    deps pulls in FastAPI, which a compute worker has no reason to load.
    """
    import deps
    return Path(deps.ATLAS_DIR)


def _norm(p: Path) -> str:
    return os.path.normcase(os.path.normpath(str(p)))


def within_atlas_dir(path) -> bool:
    """True iff `path` is inside ATLAS_DIR, after resolving symlinks.

    The atlas equivalent of routers/modules._within. Every delete and every
    write goes through this; nothing else bounds them, because atlases do not
    pass through the module installer.
    """
    try:
        root = _norm(Path(os.path.realpath(str(atlas_dir()))))
        p = _norm(Path(os.path.realpath(str(path))))
    except (OSError, ValueError):
        return False
    return p == root or p.startswith(root + os.sep)


def slug(text: str) -> str:
    """Filesystem- and URL-safe atlas id from arbitrary user text."""
    s = _SLUG_RE.sub("_", str(text or "").strip().lower()).strip("_")
    return re.sub(r"_{2,}", "_", s)


def is_valid_id(atlas_id: str) -> bool:
    return bool(atlas_id) and atlas_id == slug(atlas_id) and atlas_id not in RESERVED_IDS


# --------------------------------------------------------------------------- #
# State: order, hidden, recorded checksums
# --------------------------------------------------------------------------- #

def state_path() -> Path:
    return atlas_dir() / STATE_FILENAME


def _atomic_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=1, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_state() -> dict:
    try:
        data = json.loads(state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "order": list(data.get("order") or []),
        "hidden": list(data.get("hidden") or []),
        # {atlasId: {relname: sha256}} -- recorded at download time. The chosen
        # integrity model does not pre-pin hashes for catalog atlases, so this
        # is what a later verify compares against to catch local corruption.
        "checksums": dict(data.get("checksums") or {}),
    }


def save_state(state: dict) -> None:
    _atomic_json(state_path(), {
        "schemaVersion": SCHEMA_VERSION,
        "order": list(state.get("order") or []),
        "hidden": list(state.get("hidden") or []),
        "checksums": dict(state.get("checksums") or {}),
    })


# --------------------------------------------------------------------------- #
# Descriptors
# --------------------------------------------------------------------------- #

def _coerce(raw: dict, folder: Path) -> dict:
    """Normalise a parsed atlas.json, filling in defaults."""
    atlas_id = str(raw.get("id") or folder.name)
    volume = str(raw.get("volume") or ("%s.nii.gz" % atlas_id))
    labels = str(raw.get("labels") or ("%s.labels.json" % atlas_id))
    kind = raw.get("kind") if raw.get("kind") in KINDS else "parcellation"
    origin = dict(raw.get("origin") or {})
    if origin.get("kind") not in ORIGINS:
        origin["kind"] = "builtin"
    return {
        "schemaVersion": int(raw.get("schemaVersion") or SCHEMA_VERSION),
        "id": atlas_id,
        "aliases": [str(a) for a in (raw.get("aliases") or [])],
        "name": str(raw.get("name") or atlas_id),
        "short": str(raw.get("short") or raw.get("name") or atlas_id),
        "description": str(raw.get("description") or ""),
        "kind": kind,
        "space": str(raw.get("space") or "MNI152"),
        "volume": volume,
        "labels": labels,
        "colormap": str(raw.get("colormap") or "random"),
        "opacity": float(raw.get("opacity", 0.55)),
        "ignoreZeroVoxels": bool(raw.get("ignoreZeroVoxels", True)),
        "lateralized": raw.get("lateralized"),
        "derivedFrom": raw.get("derivedFrom"),
        # Optional sibling: a 4-D per-bundle binary stack. A tract atlas has
        # both -- the 3-D max-probability volume for display, and this for the
        # dissection breakdown, where a voxel may belong to several bundles.
        "tracts4d": raw.get("tracts4d"),
        "origin": origin,
        "license": dict(raw.get("license") or {}),
        # Filled in by scan(), not stored:
        "dir": str(folder),
        "volumePath": str(folder / volume),
        "labelsPath": str(folder / labels),
        "url": "/atlases/%s/%s" % (atlas_id, volume),
        "labelsUrl": "/atlases/%s/%s" % (atlas_id, labels),
    }


_STORED_KEYS = (
    "schemaVersion", "id", "aliases", "name", "short", "description", "kind",
    "space", "volume", "labels", "colormap", "opacity", "ignoreZeroVoxels",
    "lateralized", "derivedFrom", "tracts4d", "origin", "license",
)


def write_descriptor(folder: Path, descriptor: dict) -> None:
    """Write atlas.json, keeping only the persisted keys.

    scan() decorates descriptors with resolved paths and URLs; writing those
    back would bake an absolute path into a file that travels between machines.
    """
    if not within_atlas_dir(folder):
        raise AtlasError("refusing to write outside the atlas directory")
    body = {k: descriptor[k] for k in _STORED_KEYS if k in descriptor}
    body.setdefault("schemaVersion", SCHEMA_VERSION)
    _atomic_json(Path(folder) / DESCRIPTOR_FILENAME, body)


def read_descriptor(folder: Path):
    """Parse one atlas folder. Returns a descriptor, or None if it is not one."""
    folder = Path(folder)
    desc_file = folder / DESCRIPTOR_FILENAME
    try:
        raw = json.loads(desc_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    d = _coerce(raw, folder)
    d["installed"] = Path(d["volumePath"]).exists()
    d["hasLabels"] = Path(d["labelsPath"]).exists()
    try:
        d["bytes"] = sum(p.stat().st_size for p in folder.iterdir() if p.is_file())
    except OSError:
        d["bytes"] = 0
    return d


def scan() -> list:
    """Every atlas folder under ATLAS_DIR, unordered."""
    root = atlas_dir()
    out = []
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return out
    for child in entries:
        if not child.is_dir():
            continue
        d = read_descriptor(child)
        if d is not None:
            out.append(d)
    return out


def list_atlases(include_hidden: bool = True) -> list:
    """Every atlas, in the user's saved order, with `hidden` applied.

    Atlases absent from the saved order sort after the ordered ones, by name,
    so a freshly installed atlas appears at the end rather than jumping into
    the middle of a list the user arranged.
    """
    state = load_state()
    order = {aid: i for i, aid in enumerate(state["order"])}
    hidden = set(state["hidden"])
    found = scan()
    found.sort(key=lambda d: (order.get(d["id"], len(order)), d["name"].lower()))
    out = []
    for d in found:
        d["hidden"] = d["id"] in hidden
        d["checksums"] = state["checksums"].get(d["id"], {})
        if d["hidden"] and not include_hidden:
            continue
        out.append(d)
    return out


def resolve(atlas_id: str):
    """Descriptor for an id OR one of its aliases, else None.

    Aliases exist because the canonical ids changed during the revamp
    (ho_cort -> harvard_oxford_cort, hcp1065 -> hcp1065_tracts, visfAtlas ->
    visfatlas). Saved workspaces and layerLabelAtlas maps still hold the old
    ids; this is the one place that knows about them.
    """
    if not atlas_id:
        return None
    wanted = str(atlas_id)
    found = scan()
    for d in found:
        if d["id"] == wanted:
            return d
    lowered = wanted.lower()
    for d in found:
        if d["id"].lower() == lowered:
            return d
        if any(a.lower() == lowered for a in d["aliases"]):
            return d
    return None


def require(atlas_id: str) -> dict:
    d = resolve(atlas_id)
    if d is None:
        raise AtlasError("no atlas '%s' is installed" % atlas_id)
    return d


def labels_for(atlas_id: str) -> list:
    """Canonical regions for an atlas; [] when it has no readable label file."""
    d = resolve(atlas_id)
    if d is None:
        return []
    return atlas_labels.read_labels_or_empty(d["labelsPath"])


def volume_path(atlas_id: str):
    d = resolve(atlas_id)
    return Path(d["volumePath"]) if d else None


# --------------------------------------------------------------------------- #
# Mutations
# --------------------------------------------------------------------------- #

def set_order(order) -> list:
    """Persist a display order. Unknown ids are dropped, missing ones appended."""
    known = [d["id"] for d in scan()]
    wanted = [str(a) for a in (order or []) if a in known]
    seen = set(wanted)
    wanted.extend(a for a in known if a not in seen)
    state = load_state()
    state["order"] = wanted
    save_state(state)
    return wanted


def set_hidden(atlas_id: str, hidden: bool) -> None:
    d = require(atlas_id)
    state = load_state()
    current = set(state["hidden"])
    if hidden:
        current.add(d["id"])
    else:
        current.discard(d["id"])
    state["hidden"] = sorted(current)
    save_state(state)


def record_checksums(atlas_id: str, checksums: dict) -> None:
    state = load_state()
    state["checksums"][atlas_id] = dict(checksums or {})
    save_state(state)


_PATCHABLE = ("name", "short", "description", "colormap", "opacity",
              "ignoreZeroVoxels", "kind")


def patch(atlas_id: str, fields: dict) -> dict:
    """Update display fields on atlas.json. Returns the fresh descriptor.

    Per-region colours are NOT here -- they live on the regions themselves in
    the labels file, so that a colour scheme travels with the atlas folder
    instead of being stranded in a state file keyed by id.
    """
    d = require(atlas_id)
    folder = Path(d["dir"])
    # A pydantic model_dump() carries every unset field as None; those mean
    # "leave alone", not "set to None".
    if fields.get("kind") is not None and fields["kind"] not in KINDS:
        raise AtlasError("unknown atlas kind '%s'" % fields["kind"])
    changed = dict(d)
    for key in _PATCHABLE:
        if fields.get(key) is not None:
            changed[key] = fields[key]
    changed["opacity"] = max(0.0, min(1.0, float(changed.get("opacity", 0.55))))
    write_descriptor(folder, changed)
    if "hidden" in fields and fields["hidden"] is not None:
        set_hidden(d["id"], bool(fields["hidden"]))
    return require(d["id"])


def set_region_colors(atlas_id: str, colors: dict) -> list:
    """Merge {value: [r,g,b]} into the labels file. None clears one back to auto."""
    d = require(atlas_id)
    regions = atlas_labels.read_labels_or_empty(d["labelsPath"])
    if not regions:
        raise AtlasError("'%s' has no readable label list to colour" % d["id"])
    wanted = {int(k): v for k, v in (colors or {}).items()}
    for r in regions:
        if r["value"] in wanted:
            v = wanted[r["value"]]
            r["color"] = [int(c) for c in v] if v else None
    atlas_labels.write_labels(d["labelsPath"], regions)
    return regions


def dependents(atlas_id: str) -> list:
    """Ids of installed atlases derived from this one."""
    return [d["id"] for d in scan() if d.get("derivedFrom") == atlas_id]


def remove(atlas_id: str) -> dict:
    """Delete an atlas folder, preferring the OS trash.

    Two refusals, both distinct from the module ledger's:
      * the folder must resolve inside ATLAS_DIR;
      * an atlas another installed atlas was derived from stays, or the child's
        provenance becomes a dangling reference.

    A git-tracked folder is NOT refused -- it goes to the recycle bin and `git
    checkout` restores it, so this is recoverable twice over.
    """
    d = require(atlas_id)
    folder = Path(d["dir"])
    if not within_atlas_dir(folder) or _norm(folder) == _norm(atlas_dir()):
        raise AtlasError(
            "'%s' resolves outside the atlas directory; refusing to delete it"
            % d["id"])
    children = dependents(d["id"])
    if children:
        raise AtlasError(
            "'%s' is the source of %s. Remove %s first."
            % (d["id"], ", ".join(children),
               "it" if len(children) == 1 else "those"))

    freed = d.get("bytes", 0)
    method = _trash_tree(folder)

    state = load_state()
    state["order"] = [a for a in state["order"] if a != d["id"]]
    state["hidden"] = [a for a in state["hidden"] if a != d["id"]]
    state["checksums"].pop(d["id"], None)
    save_state(state)
    return {"id": d["id"], "removed": method, "bytesFreed": freed}


def _trash_tree(folder: Path) -> str:
    """Recycle-bin a directory, falling back to a permanent delete.

    routers/modules._remove_payload does this for a single file (path.unlink);
    an atlas is a folder, so rmtree is the fallback rather than unlink.
    """
    try:
        from send2trash import send2trash as _to_trash
    except ImportError:
        shutil.rmtree(folder)
        return "deleted"
    try:
        _to_trash(str(folder))
        return "trashed"
    except Exception:  # noqa: BLE001 -- no trash on this volume (network/UNC)
        shutil.rmtree(folder)
        return "deleted"
