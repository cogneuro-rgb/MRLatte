# Module manifest + capability API.
#
# The app ships without its large optional assets (tractogram, connectome
# bundle, atlas packs) and without the heavy plotting/validation Python stacks.
# This router answers the one question the whole UI needs: what is actually
# present on THIS machine, and which features does that unlock.
#
# Phase 4 adds the write side: sideload, download, verify, repair and uninstall.
# Everything below treats a sideloaded archive as attacker-controlled input —
# see `_safe_join` / `_validate_archive` for the module-root boundary, and
# `_uninstall_guard` for the refusal to delete anything outside the module root.
from fastapi import APIRouter
from deps import *  # noqa: F401,F403 (shared config, models, helpers)

import deps            # for deps.MODULE_ROOT, which tests/env may repoint
import hashlib
import importlib.util
import re
import stat as _stat
import threading
import time
from pathlib import PurePosixPath

router = APIRouter()


# REPO_ROOT is the repo-root anchor computed in deps (searches upward for a
# marker); `from deps import *` above binds it here. Recomputing it as
# ROOT_DIR.parent would break the moment backend/ stops sitting directly under
# the repo root.

# The manifest is checked-in source, but it lives INSIDE the module root
# (MODULE_ROOT/manifest.json) alongside the payload it describes — the same
# layout a packaged install already uses. Deriving the default from MODULE_ROOT
# rather than a hardcoded 'modules' segment keeps this correct in both dev
# (MODULE_ROOT = data/modules) and packaged (MODULE_ROOT = <bundle>/modules)
# without an if/else. Nothing here ever bulk-deletes "everything under
# MODULE_ROOT" (see _uninstall_guard, _plan) so the manifest is never at risk
# from the install/uninstall machinery.
MANIFEST_PATH = Path(os.environ.get(
    'MRLATTE_MODULE_MANIFEST', str(MODULE_ROOT / 'manifest.json')
))


def _manifest_path() -> Path:
    """Manifest location, re-read from the environment on every call.

    A module-level constant would freeze whatever MRLATTE_MODULE_MANIFEST said
    at import time, which makes the installer untestable (the test suite points
    it at a scratch manifest) and breaks a launcher that sets it late."""
    return Path(os.environ.get('MRLATTE_MODULE_MANIFEST', str(MANIFEST_PATH)))


def _module_root() -> Path:
    """MODULE_ROOT read through `deps` rather than the star-imported copy.

    `from deps import *` binds MODULE_ROOT by value; reading the attribute off
    the module instead means a relocated root (tests, launcher) is honoured."""
    return Path(deps.MODULE_ROOT)


def _ledger_path() -> Path:
    """Written by the installer after a successful hash-checked install.
    Absent on a dev checkout, which is why `installed` must never depend on it."""
    return _module_root() / 'manifest.installed.json'

# Size tolerance for the fast installed-check. Exact equality is too brittle
# (a legacy asset may be a slightly different build of the same dataset), while
# a bare existence check would happily accept a truncated or HTML-stub file.
_SIZE_TOLERANCE = 0.02

_manifest_cache = {"mtime": None, "data": None}


# === Manifest loading =========================================================

def _load_manifest() -> dict:
    """Parse modules/manifest.json, memoised on (path, mtime). Never raises."""
    path = _manifest_path()
    try:
        key = (str(path), path.stat().st_mtime)
    except OSError:
        logger.warning("module manifest not found at %s", path)
        return {"schemaVersion": 0, "modules": []}
    if _manifest_cache["mtime"] != key:
        try:
            _manifest_cache["data"] = json.loads(path.read_text(encoding="utf-8"))
            _manifest_cache["mtime"] = key
        except Exception as e:  # noqa: BLE001 — a broken manifest must not 500 the app
            logger.exception("module manifest is unreadable: %s", e)
            return {"schemaVersion": 0, "modules": []}
    return _manifest_cache["data"] or {"schemaVersion": 0, "modules": []}


def _manifest_entry(module_id: str) -> dict:
    """Raw manifest entry for `module_id`, or 404."""
    for entry in _load_manifest().get("modules") or []:
        if entry.get("id") == module_id:
            return entry
    raise HTTPException(status_code=404, detail=f"unknown module '{module_id}'")


def _load_ledger() -> dict:
    """Read <MODULE_ROOT>/manifest.installed.json -> {id: record}. Never raises."""
    try:
        raw = json.loads(_ledger_path().read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — absent on every un-installed machine
        return {}
    entries = raw.get("modules") if isinstance(raw, dict) else raw
    if isinstance(entries, dict):
        return entries
    if isinstance(entries, list):
        return {e.get("id"): e for e in entries if isinstance(e, dict) and e.get("id")}
    return {}


# === Path resolution ==========================================================

def resolve_entry(entry: dict) -> Path:
    """Resolve a manifest entry to the path its asset ACTUALLY loads from.

    This deliberately goes through deps.module_path() — the same function
    backend/deps.py uses for GLOBAL_TRACT_FILE / LNM_BUNDLE / ATLAS_DIR —
    with the same (rel, env_var) arguments, taken from the manifest. The asset
    lives under the module root; an explicit env override still wins.
    """
    return module_path(
        entry.get("installTo") or "",
        entry.get("envVar") or None,
    )


def _size_ok(actual: int, declared) -> bool:
    if not declared:
        return actual > 0
    return abs(actual - int(declared)) <= max(1, int(int(declared) * _SIZE_TOLERANCE))


def _check_data(entry: dict):
    """Fast exists+size check for a `data` module. Returns (installed, missing)."""
    base = resolve_entry(entry)
    files = entry.get("files")
    if not files:
        # Single-file module: installTo IS the file.
        try:
            st = base.stat()
        except OSError:
            return False, [base.name]
        if not st.st_size or not _size_ok(st.st_size, entry.get("bytes")):
            return False, [base.name]
        return True, []

    missing = []
    for f in files:
        rel = f.get("path") or ""
        try:
            st = (base / rel).stat()
        except OSError:
            missing.append(rel)
            continue
        if not st.st_size:
            missing.append(rel)
            continue
        # Mutable files (atlas.json, *.labels.json) are app-writable after
        # install — presence only. A renamed region or recolored atlas
        # rewrites a ~600-byte atlas.json past the 2% size tolerance below,
        # which would otherwise flag every legitimate edit as the whole
        # module being "broken" (mirrors tools/scripts/modules.mjs's
        # verifyData(), which already treats mutable files this way).
        if f.get("mutable"):
            continue
        if not _size_ok(st.st_size, f.get("bytes")):
            missing.append(rel)
    return (not missing), missing


def _has_any_file(entry: dict) -> bool:
    """True if at least one of the module's declared files is on disk.

    Distinguishes `broken` (a half-installed or corrupted module — Repair) from
    `missing` (nothing was ever installed — Install)."""
    if (entry.get("type") or "data") != "data":
        return False
    base = resolve_entry(entry)
    files = entry.get("files")
    if not files:
        return base.exists()
    return any((base / (f.get("path") or "")).exists() for f in files)


def _check_python(entry: dict):
    """Importability check for a `python-package` module. No import executed —
    find_spec only touches the finders, so this stays well inside the ~50 ms
    budget even when the package would be expensive to import (nilearn)."""
    missing = []
    for pkg in entry.get("pythonPackages") or []:
        try:
            if importlib.util.find_spec(pkg) is None:
                missing.append(pkg)
        except (ImportError, ValueError):
            missing.append(pkg)
    return (not missing), missing


def _slot_probe(entry: dict):
    """Resolve a `type: "slot"` module and validate whatever is actually there.

    Returns (state, reason, details, path). A slot is a directory the user drops
    a file into — the file may have any name, so there is nothing to hash and
    nothing to match by filename. Resolution mirrors deps.slot_path exactly:
    env override, then a `link`-mode registered path, then MODULE_ROOT/<dir>.
    Any drift between the two would report a capability as on while the workers
    resolved somewhere else.

    "broken" carries a reason (e.g. "no reference affine"); "missing" means the
    slot is genuinely empty. Conflating the two would send a user hunting for a
    file that is already sitting there.
    """
    import os as _os
    from pathlib import Path as _Path
    from module_slots import VALIDATORS, scan_slot

    slot = entry.get("slot") or {}
    exts = {e.lower() for e in slot.get("extensions") or []}
    validator = slot.get("validator", "")
    fn = VALIDATORS.get(validator)
    if fn is None:
        return "broken", f"unknown validator '{validator}'", {}, None

    # 1. explicit env override — a direct file path
    env_var = entry.get("envVar")
    if env_var and _os.environ.get(env_var):
        p = _Path(_os.environ[env_var])
        if not p.exists():
            return "broken", f"{env_var} points at a missing file: {p}", {}, None
        ok, reason, details = fn(p)
        return ("installed" if ok else "broken"), ("" if ok else f"{p.name}: {reason}"), details, p

    # 2. a `link`-mode install: the file stays where the user already had it.
    # A moved or deleted original is `broken` WITH the path, not `missing` —
    # otherwise a feature that silently stopped working sends the user looking
    # for a file they never removed from the slot directory (it was never there).
    record = _load_ledger().get(entry.get("id")) or {}
    if record.get("slotMode") == "link" and record.get("slotPath"):
        p = _Path(record["slotPath"])
        if not p.is_file():
            return "broken", (
                f"the registered file is no longer at {p} — it was moved or "
                f"deleted. Re-select it, or remove the registration."), {}, None
        ok, reason, details = fn(p)
        return ("installed" if ok else "broken"), ("" if ok else f"{p.name}: {reason}"), details, p

    # 3. the slot directory itself. `_module_root()` rather than the
    # star-imported MODULE_ROOT: the latter is bound by VALUE at import, so a
    # relocated root (tests, launcher) would be scanned at its old location
    # while every other path in this router honoured the new one.
    found, state, reason, details = scan_slot(_module_root() / slot.get("directory", ""),
                                              exts, validator)
    if state == "installed":
        return state, reason, details, found
    return state, reason, details, None


def _check(entry: dict):
    if entry.get("type") == "python-package":
        return _check_python(entry)
    if entry.get("type") == "container":
        return False, ["container runtime not implemented"]
    if entry.get("type") == "slot":
        state, reason, _details, _p = _slot_probe(entry)
        return (state == "installed"), ([] if state == "installed" else [reason or "slot empty"])
    return _check_data(entry)


def human_bytes(n) -> str:
    """Human-readable size for the UI ('673 MB', '1.2 GB')."""
    try:
        n = float(n or 0)
    except (TypeError, ValueError):
        return "unknown size"
    if n < 1024:
        return f"{int(n)} B"
    for unit in ("KB", "MB", "GB", "TB"):
        n /= 1024.0
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if n < 10 else f"{n:.0f} {unit}"
    return f"{n:.0f} TB"


# === Snapshot =================================================================

def module_snapshot() -> dict:
    """Current module + capability state. Cheap enough to call per request."""
    manifest = _load_manifest()
    ledger = _load_ledger()

    modules = []
    capabilities = {}
    for entry in manifest.get("modules") or []:
        mid = entry.get("id")
        if not mid:
            continue
        installed, missing = _check(entry)
        record = ledger.get(mid) or {}
        # `verified` is a hash claim, and hashing is explicitly off this path.
        # It is therefore true only when the installer recorded a successful
        # sha256 verification for the version we currently believe is present.
        verified = bool(
            installed
            and record.get("verified")
            and (not record.get("version") or record.get("version") == entry.get("version"))
        )
        mtype = entry.get("type") or "data"
        # Rule 4, fast tier: a module the ledger (or a partial file set) says
        # should be here but whose files fail exists+size is `broken`, not
        # `missing` — broken is what surfaces Repair.
        slot_reason, slot_details, slot_path_found = "", {}, None
        if mtype == "slot":
            # Slots own all three states themselves — a present-but-invalid file
            # is `broken` with a reason, which the exists+size tier cannot express.
            state, slot_reason, slot_details, slot_path_found = _slot_probe(entry)
        elif installed:
            state = "installed"
        elif mtype == "data" and (record or _has_any_file(entry)):
            state = "broken"
        else:
            state = "missing"

        unlocks = entry.get("unlocks") or []
        for cap in unlocks:
            # A capability is on only if EVERY module that unlocks it is
            # present (currently one module per capability, but ANDing is the
            # safe default should a capability ever need two).
            capabilities[cap] = capabilities.get(cap, True) and installed

        sources = entry.get("sources") or []
        modules.append({
            "id": mid,
            "name": entry.get("name") or mid,
            "description": entry.get("description") or "",
            "type": mtype,
            "tier": entry.get("tier") or "optional",
            "version": record.get("version") or entry.get("version"),
            "bytes": entry.get("bytes") or 0,
            "bytesHuman": human_bytes(entry.get("bytes")),
            "unlocks": unlocks,
            "installed": installed,
            "verified": verified,
            "missing": missing,
            "state": state,
            "path": (str(resolve_entry(entry)) if mtype == "data"
                     else str(slot_path_found) if slot_path_found
                     else str(_module_root() / (entry.get("slot") or {}).get("directory", ""))
                     if mtype == "slot" else None),
            # Slot-only: where to drop the file, why the present one was
            # rejected, and what the accepted file turned out to contain.
            "slot": ({**(entry.get("slot") or {}),
                      "reason": slot_reason,
                      "details": slot_details} if mtype == "slot" else None),
            "sources": sources,
            "license": entry.get("license") or {},
            # Both manifest shapes, passed through verbatim: multi-file modules
            # have `files` and a null module sha256; single-file modules have
            # the module sha256 and no `files`.
            "files": entry.get("files") or [],
            "sha256": entry.get("sha256"),
            # --- phase 4: what the store may offer for this module ---------
            # `python-package` modules have a pip source and are deliberately
            # not installable yet (no shelling out to pip this phase).
            "sideloadable": mtype == "data",
            # Slots take a filesystem PATH, not an upload: the payloads run to
            # hundreds of MB and are validated structurally rather than by hash,
            # so there is nothing to gain from streaming them through HTTP — and
            # `link` mode exists precisely to avoid moving the bytes at all.
            "slotInstallable": mtype == "slot",
            "slotMode": record.get("slotMode") if mtype == "slot" else None,
            "slotPath": record.get("slotPath") if mtype == "slot" else None,
            # Named in the UI when an override is why a slot cannot be managed
            # from the app, so the message can say which variable to unset.
            "envVar": entry.get("envVar"),
            "downloadable": mtype == "data" and bool(_download_url_for(entry, None)),
            "sideloadOnly": mtype == "data" and not any(
                s.get("type") == "github-release" for s in sources),
            # Slots include hand-dropped files: the slot directory is a place
            # this app asks the user to use, so it may clean it up. Mirrors
            # _uninstall_slot's refusals via the shared helper.
            #
            # A `data` module also needs a ledger entry, unlike a slot: the repo
            # ships tracked payloads (mni152-template, atlases-core) directly
            # under the module root with no install record, and _uninstall_guard
            # refuses those with a 409 — this must agree or the button lies.
            "uninstallable": (
                (mtype == "data" and installed
                 and _within(_module_root(), resolve_entry(entry))
                 and mid in ledger)
                or (mtype == "slot" and installed
                    and _slot_uninstallable(entry, record, slot_path_found))
            ),
            "repairable": mtype == "data" and state == "broken",
            "notInstallableReason": (
                None if mtype in ("data", "slot")
                else "Python-package modules are not installable from the app yet."
            ),
        })

    return {
        "schemaVersion": manifest.get("schemaVersion", 0),
        "manifest": str(_manifest_path()),
        "moduleRoot": str(_module_root()),
        "installable": True,   # phase 4: sideload/install/uninstall are live
        "modules": modules,
        "capabilities": capabilities,
    }


# === The module-root boundary =================================================
# Everything the installer writes, and everything uninstall deletes, must be
# inside MODULE_ROOT. A sideloaded archive is attacker-controlled input:
# `zipfile.extractall` happily honours `../`, absolute paths and drive letters
# (Zip Slip), so every destination is resolved and re-checked against the root
# before a single byte is written.

def _norm(p: Path) -> str:
    """Case- and separator-normalised absolute path, for containment tests.
    NTFS is case-insensitive, so a raw string compare is not enough."""
    return os.path.normcase(os.path.normpath(str(p)))


def _within(root: Path, path: Path) -> bool:
    """True iff `path` is `root` or lives underneath it, after resolving any
    symlink/junction in the parts that already exist on disk."""
    try:
        r = _norm(Path(os.path.realpath(str(root))))
        p = _norm(Path(os.path.realpath(str(path))))
    except (OSError, ValueError):
        return False
    if p == r:
        return True
    return p.startswith(r + os.sep)


class BoundaryError(ValueError):
    """A path escaped MODULE_ROOT. Always fatal for the whole operation."""


def _safe_join(root: Path, rel) -> Path:
    """Join `rel` under `root`, refusing anything that could escape it.

    Rejects: absolute POSIX paths, UNC paths, Windows drive letters, `..`
    segments, NUL bytes, and any resolved destination that lands outside
    `root` (which catches a symlink/junction already present inside the root).
    """
    root_r = Path(os.path.realpath(str(root)))
    rel = "" if rel is None else str(rel)
    if not rel:
        return root_r
    if "\x00" in rel:
        raise BoundaryError("archive member contains a NUL byte")
    text = rel.replace("\\", "/")
    if text.startswith("/") or text.startswith("//"):
        raise BoundaryError(f"absolute path not allowed: {rel!r}")
    if len(text) >= 2 and text[1] == ":":
        raise BoundaryError(f"drive-qualified path not allowed: {rel!r}")
    parts = []
    for part in PurePosixPath(text).parts:
        if part in ("", "."):
            continue
        if part == "..":
            raise BoundaryError(f"parent-directory traversal not allowed: {rel!r}")
        if ":" in part:
            raise BoundaryError(f"drive/stream qualifier not allowed: {rel!r}")
        parts.append(part)
    if not parts:
        return root_r
    dest = root_r.joinpath(*parts)
    # realpath() collapses any symlink in the EXISTING prefix, so a member
    # aimed through a symlinked directory is caught by the containment test.
    dest_r = Path(os.path.realpath(str(dest)))
    if not _within(root_r, dest_r):
        raise BoundaryError(f"path escapes the module root: {rel!r}")
    # A pre-existing symlink AT the destination would make the final
    # os.replace() write through to the link target.
    if dest.is_symlink():
        raise BoundaryError(f"destination is a symlink: {rel!r}")
    return dest_r


def _install_base(entry: dict) -> Path:
    """Where this module's payload is WRITTEN (directory for a multi-file
    module, the file itself for a single-file one).

    Deliberately pinned to MODULE_ROOT via `_safe_join`, not `resolve_entry()`:
    an explicit env override (ATLAS_DIR, GLOBAL_TRACT_FILE, …) could point reads
    at some other location, but writes must never land outside the root we
    promised to stay in.

    An explicit env override is honoured only while it stays inside MODULE_ROOT;
    otherwise we refuse rather than write outside the root.
    """
    root = _module_root()
    env_var = entry.get("envVar")
    override = os.environ.get(env_var) if env_var else None
    if override:
        p = Path(os.path.realpath(override))
        if not _within(root, p):
            raise HTTPException(status_code=409, detail=(
                f"{env_var}={override} points outside the module root "
                f"({root}); refusing to install there. Unset {env_var} or move "
                f"it under the module root."))
        return p
    return _safe_join(root, entry.get("installTo") or "")


def _staging_root() -> Path:
    """Scratch area for uploads/downloads. Inside MODULE_ROOT so a promote is a
    same-filesystem `os.replace` (atomic) rather than a cross-device copy."""
    return _module_root() / ".staging"


def _jobs_root() -> Path:
    return Path(os.environ.get("MRLATTE_MODULE_JOBS_DIR",
                               str(_module_root() / ".jobs")))


# === Declared-hash policy =====================================================
# Fail closed: "no hash declared" is NOT "hash verified". An absent sha256 can
# never be read as permission — otherwise a module added to the manifest with
# `"sha256": null` would install attacker-supplied bytes through the very
# .part-then-promote machinery that exists to stop exactly that.
#
# The only way past is an explicit `"sha256": "unverified"` in the manifest,
# which is logged loudly at install time and recorded as unverified in the
# ledger. It is a written-down decision, never an inference from absence.
#
# Two manifest shapes this must NOT break:
#   * a multi-file `data` module carries `sha256: null` at MODULE level and a
#     real digest per entry in `files[]` — that null is correct and is never
#     consulted, because `_plan` only reads the module-level hash when there is
#     no `files` array;
#   * `slot` and `python-package` modules carry no hashes at all and never
#     reach the installer (`_require_data_module` turns them away first).

_UNVERIFIED = "unverified"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _declared_hash(value):
    """Normalised manifest sha256, or None when nothing was declared.
    null, missing and "" all collapse to None — they are the same claim."""
    if value is None:
        return None
    text = str(value).strip().lower()
    return text or None


_NO_HASH = "no usable sha256 in the manifest"


def _no_hash_error(item: dict) -> HTTPException:
    """The refusal. Names the module and the file, and says what to fix.

    A plain-string detail, like every other manifest-level refusal here
    (`_require_data_module`, the installTo/env-override guards): the Module
    Store surfaces string details verbatim and falls back to a bare "HTTP 409"
    for structured ones, and this message is the whole point."""
    declared = _declared_hash(item.get("sha256"))
    mid, rel = item.get("module"), item.get("rel")
    if declared is None:
        what = f"declares no sha256 for '{rel}'"
        fix = ("Add that file's sha256 to the manifest. If the asset genuinely "
               "cannot be hashed, declare \"sha256\": \"unverified\" for it "
               "explicitly — an absent hash is never taken as permission.")
    else:
        what = f"declares an unusable sha256 for '{rel}' ({item.get('sha256')!r})"
        fix = ("A manifest sha256 must be 64 hex characters, or the literal "
               "\"unverified\".")
    return HTTPException(status_code=409, detail=(
        f"{_NO_HASH}: module '{mid}' {what}. Refusing to install bytes nothing "
        f"has vouched for. {fix}"))


def _hash_policy(item: dict) -> tuple:
    """('verify', digest) or ('optout', None). Raises 409 for anything else."""
    declared = _declared_hash(item.get("sha256"))
    if declared == _UNVERIFIED:
        return "optout", None
    if declared is None or not _SHA256_RE.match(declared):
        raise _no_hash_error(item)
    return "verify", declared


def _require_hashes(items: list) -> list:
    """Pre-flight for a whole install: refuse before a single byte is fetched,
    rather than only at the promote gate. Announces every explicit opt-out."""
    for it in items:
        if _hash_policy(it)[0] == "optout":
            logger.warning(
                "MODULE INSTALL UNVERIFIED: '%s' file '%s' declares "
                "\"sha256\": \"unverified\" — installing WITHOUT integrity "
                "verification because the manifest explicitly opts out.",
                it.get("module"), it.get("rel"))
    return items


def _all_verified(items: list) -> bool:
    """True only if every file was checked against a real digest — an explicit
    opt-out must never end up recorded as `verified` in the ledger."""
    return all(_SHA256_RE.match(_declared_hash(it.get("sha256")) or "")
               for it in items)


# === Install plan =============================================================

def _plan(entry: dict) -> list:
    """[{rel, dest, sha256, bytes}] — one item per file this module installs.

    Handles both manifest shapes: multi-file modules carry a `files` array with
    a per-file sha256 and `sha256: null` at module level; single-file modules
    carry a module-level sha256 and no `files`.
    """
    base = _install_base(entry)
    mid = entry.get("id")
    files = entry.get("files")
    if not files:
        return [{
            "module": mid,
            "rel": base.name,
            "dest": base,
            "sha256": (entry.get("sha256") or None),
            "bytes": entry.get("bytes") or None,
        }]
    out = []
    for f in files:
        rel = f.get("path") or ""
        out.append({
            "module": mid,
            "rel": rel,
            "dest": _safe_join(base, rel),
            "sha256": (f.get("sha256") or None),
            "bytes": f.get("bytes") or None,
        })
    return out


_HASH_CHUNK = 1 << 20


def _sha256_stream(src, dest_path: Path, expect_bytes=None) -> tuple:
    """Copy `src` (a binary file object) to `dest_path`, hashing as we go.
    Returns (sha256_hex, bytes_written). Never verifies — the caller does."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    n = 0
    with open(dest_path, "wb") as out:
        while True:
            chunk = src.read(_HASH_CHUNK)
            if not chunk:
                break
            h.update(chunk)
            n += len(chunk)
            out.write(chunk)
    return h.hexdigest(), n


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_HASH_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _part_of(dest: Path) -> Path:
    return dest.with_name(dest.name + ".part")


def _verify_part(item: dict, part: Path, actual_sha=None):
    """Rule 3: refuse a hash mismatch, naming the file and both digests.

    Also the last line of defence for the fail-closed hash policy: a file the
    manifest declares no usable sha256 for is refused here even if the
    pre-flight was somehow bypassed. Only an explicit "unverified" passes."""
    mode, expected = _hash_policy(item)
    if mode == "optout":
        return None
    actual = actual_sha or _sha256_of(part)
    if actual.lower() != expected:
        raise HTTPException(status_code=400, detail={
            "error": "sha256 mismatch",
            "file": item["rel"],
            "expected": item.get("sha256"),
            "actual": actual,
        })
    return actual


def _promote(items: list) -> list:
    """Rename every verified `<file>.part` onto its final name. Called only
    after EVERY file has been hashed and matched, so a module is never left
    half-upgraded by a mid-way failure."""
    promoted = []
    for it in items:
        part = _part_of(it["dest"])
        it["dest"].parent.mkdir(parents=True, exist_ok=True)
        os.replace(str(part), str(it["dest"]))
        promoted.append(str(it["dest"]))
    return promoted


def _discard_parts(items: list):
    for it in items:
        try:
            _part_of(it["dest"]).unlink()
        except OSError:
            pass


# === Archive handling (Zip Slip) ==============================================

def _member_is_link(info) -> bool:
    """True for a symlink or a Unix-special member. Zip stores the Unix mode in
    the top 16 bits of external_attr when create_system == 3 (Unix)."""
    if info.create_system != 3:
        return False
    mode = info.external_attr >> 16
    if not mode:
        return False
    return not (_stat.S_ISREG(mode) or _stat.S_ISDIR(mode))


def _validate_archive(zf, boundary: Path):
    """Fail-closed scan of EVERY member before anything is extracted.

    Returns {normalised member path -> ZipInfo} for the regular files.
    Raises BoundaryError on the first member that could escape `boundary`, so a
    malicious archive is rejected as a whole rather than partially applied.
    """
    members = {}
    for info in zf.infolist():
        name = info.filename or ""
        if _member_is_link(info):
            raise BoundaryError(f"archive contains a link/special member: {name!r}")
        # Validates traversal/absolute/drive for directories too — a directory
        # entry named '../x' is just as dangerous as a file one.
        _safe_join(boundary, name)
        if info.is_dir():
            continue
        key = str(PurePosixPath(name.replace("\\", "/")))
        members[key] = info
    return members


def _strip_single_top_dir(members: dict) -> dict:
    """Release zips are usually wrapped in one top-level directory. If every
    member shares one, also index them by the un-prefixed path so a manifest
    `files[].path` still matches. Never removes the original keys."""
    tops = {k.split("/", 1)[0] for k in members if "/" in k}
    flat = {k for k in members if "/" not in k}
    if len(tops) != 1 or flat:
        return members
    top = tops.pop()
    merged = dict(members)
    for k, v in members.items():
        merged.setdefault(k[len(top) + 1:], v)
    return merged


def _select_members(entry: dict, items: list, members: dict) -> dict:
    """Map each planned file to its archive member.

    Only the manifest's declared files are ever extracted. Extra members are
    ignored rather than installed: they carry no sha256, and writing an
    unverified attacker-supplied file into the module root is precisely what
    rule 3 forbids.
    """
    idx = _strip_single_top_dir(members)
    chosen = {}
    missing = []
    single = not entry.get("files")
    for it in items:
        rel = str(PurePosixPath(it["rel"].replace("\\", "/")))
        info = idx.get(rel)
        if info is None and single:
            # Single-file module: accept a one-entry archive whatever it is
            # named, or a member whose basename matches the install target.
            by_base = [v for k, v in idx.items() if k.rsplit("/", 1)[-1] == rel]
            if len(members) == 1:
                info = next(iter(members.values()))
            elif len(by_base) == 1:
                info = by_base[0]
        if info is None:
            missing.append(it["rel"])
        else:
            chosen[it["rel"]] = info
    if missing:
        raise HTTPException(status_code=400, detail={
            "error": "archive is missing required files",
            "missing": missing,
            "found": sorted(members)[:50],
        })
    return chosen


def _install_from_zip(entry: dict, archive: Path, items: list) -> list:
    """Extract, verify and atomically promote the declared files of `archive`."""
    base = _install_base(entry)
    boundary = base if entry.get("files") else base.parent
    try:
        with zipfile.ZipFile(archive) as zf:
            members = _validate_archive(zf, boundary)
            chosen = _select_members(entry, items, members)
            for it in items:
                info = chosen[it["rel"]]
                # Zip-bomb / wrong-payload guard: the declared size is known
                # before we decompress a single byte.
                if it.get("bytes") and info.file_size != int(it["bytes"]):
                    raise HTTPException(status_code=400, detail={
                        "error": "declared size mismatch",
                        "file": it["rel"],
                        "expected": int(it["bytes"]),
                        "actual": info.file_size,
                    })
                part = _part_of(it["dest"])
                with zf.open(info, "r") as src:
                    actual, _n = _sha256_stream(src, part)
                _verify_part(it, part, actual)
    except (HTTPException, BoundaryError):
        _discard_parts(items)
        raise
    except zipfile.BadZipFile as e:
        _discard_parts(items)
        raise HTTPException(status_code=400, detail=f"not a readable zip archive: {e}")
    except Exception:
        _discard_parts(items)
        raise
    return _promote(items)


def _install_raw_file(entry: dict, src_path: Path, items: list) -> list:
    """Single-file module sideloaded/downloaded as the bare asset."""
    if len(items) != 1:
        raise HTTPException(status_code=400, detail=(
            "this module has multiple files — upload a .zip archive"))
    it = items[0]
    part = _part_of(it["dest"])
    try:
        if Path(os.path.realpath(str(src_path))) != Path(os.path.realpath(str(part))):
            with open(src_path, "rb") as f:
                actual, _n = _sha256_stream(f, part)
        else:
            actual = _sha256_of(part)
        _verify_part(it, part, actual)
    except Exception:
        _discard_parts(items)
        raise
    return _promote(items)


# === Ledger ===================================================================

def _write_ledger(module_id: str, entry: dict, files: list, verified: bool):
    """Record a successful install. Written atomically (tmp + os.replace) so a
    concurrent reader never sees a partial ledger."""
    path = _ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    ledger = _load_ledger()
    ledger[module_id] = {
        "id": module_id,
        "version": entry.get("version"),
        "verified": bool(verified),
        "installedAt": datetime.now(timezone.utc).isoformat(),
        "files": files,
    }
    _atomic_json(path, {"schemaVersion": 1, "modules": ledger})


def _drop_ledger(module_id: str):
    ledger = _load_ledger()
    if ledger.pop(module_id, None) is None:
        return
    _atomic_json(_ledger_path(), {"schemaVersion": 1, "modules": ledger})


def _atomic_json(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, str(path))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def capability(name: str) -> bool:
    return bool(module_snapshot()["capabilities"].get(name))


def module_by_id(mid: str, snapshot: dict = None):
    snap = snapshot or module_snapshot()
    return next((m for m in snap["modules"] if m["id"] == mid), None)


# === Endpoints ================================================================

@router.get("/modules")
async def list_modules():
    """Report every manifest module, whether it is installed, and the resulting
    capability flags. Installed state comes from a fast filesystem/importability
    check — never from hashing, and never from probing an asset URL (the SPA
    fallback in server.py turns a missing static asset into a 200 index.html)."""
    return module_snapshot()


def _require_data_module(module_id: str) -> dict:
    entry = _manifest_entry(module_id)
    mtype = entry.get("type") or "data"
    if mtype != "data":
        raise HTTPException(status_code=409, detail=(
            f"module '{module_id}' is a {mtype} module and is not installable "
            f"from the app yet"))
    return entry


def _require_slot_module(module_id: str) -> dict:
    entry = _manifest_entry(module_id)
    mtype = entry.get("type") or "data"
    if mtype != "slot":
        raise HTTPException(status_code=409, detail=(
            f"module '{module_id}' is a {mtype} module — slot install takes a "
            f"filesystem path and only applies to slot modules"))
    return entry


def _plan_or_400(entry: dict) -> list:
    """`_plan` with the boundary check surfaced as a 4xx rather than a 500 — a
    manifest whose `installTo` escapes MODULE_ROOT is a bad manifest, not a
    server fault."""
    try:
        return _plan(entry)
    except BoundaryError as e:
        raise HTTPException(status_code=409, detail=(
            f"manifest entry '{entry.get('id')}' has an installTo that escapes "
            f"the module root: {e}"))


@router.post("/modules/{module_id}/sideload")
async def sideload_module(module_id: str, file: UploadFile = File(...)):
    """Install a module from a user-supplied file.

    The upload is either a .zip (any module) or, for a single-file module, the
    bare asset. Nothing is trusted: every archive member is checked against the
    module root before extraction, every declared file is SHA-256 verified as a
    `<file>.part`, and only once ALL of them match are the parts renamed into
    place.
    """
    entry = _require_data_module(module_id)
    items = _require_hashes(_plan_or_400(entry))
    stage_dir = _staging_root() / f"sideload-{uuid.uuid4().hex}"

    def _work():
        stage_dir.mkdir(parents=True, exist_ok=True)
        upload = stage_dir / "upload.bin"
        try:
            with open(upload, "wb") as out:
                shutil.copyfileobj(file.file, out, _HASH_CHUNK)
            if zipfile.is_zipfile(upload):
                promoted = _install_from_zip(entry, upload, items)
            elif entry.get("files"):
                raise HTTPException(status_code=400, detail=(
                    f"'{module_id}' is a multi-file module — upload the .zip "
                    f"containing {len(items)} files"))
            else:
                promoted = _install_raw_file(entry, upload, items)
        finally:
            shutil.rmtree(stage_dir, ignore_errors=True)
        _write_ledger(module_id, entry,
                      [it["rel"] for it in items],
                      verified=_all_verified(items))
        return promoted

    try:
        promoted = await run_in_threadpool(_work)
    except BoundaryError as e:
        raise HTTPException(status_code=400, detail={
            "error": "archive rejected: it would write outside the module root",
            "reason": str(e),
        })
    snap = module_snapshot()
    return {
        "ok": True,
        "id": module_id,
        "installed": promoted,
        "module": module_by_id(module_id, snap),
        "capabilities": snap["capabilities"],
    }


# === Slot install (path, not upload) ==========================================
# A slot payload is user-supplied, hundreds of MB, and validated structurally
# rather than by hash — so it is selected by PATH and either registered where it
# lies (`link`) or copied into the slot directory (`copy`). The source path is
# outside MODULE_ROOT by definition; it is only ever READ, and uninstall must
# never touch it.

class SlotInstallRequest(BaseModel):
    path: str
    mode: str = "copy"


def _slot_validate_source(entry: dict, src: Path):
    """Validate the chosen file with the slot's own validator, before any bytes
    move. The validators read headers only (module_slots docstring: a 700 MB
    tractogram is cheap to check), so rejecting a wrong file is instant rather
    than arriving after a multi-hundred-MB copy."""
    from module_slots import VALIDATORS

    slot = entry.get("slot") or {}
    fn = VALIDATORS.get(slot.get("validator", ""))
    if fn is None:
        raise HTTPException(status_code=500, detail=(
            f"manifest entry '{entry.get('id')}' names an unknown validator "
            f"'{slot.get('validator')}'"))
    if not src.is_file():
        raise HTTPException(status_code=400,
                            detail=f"no such file: {src}")
    exts = {e.lower() for e in slot.get("extensions") or []}
    if exts and src.suffix.lower() not in exts:
        raise HTTPException(status_code=400, detail=(
            f"'{src.name}' has extension '{src.suffix}' — this slot expects "
            f"{', '.join(sorted(exts))}"))
    ok, reason, details = fn(src)
    if not ok:
        # The validator's `reason` is written to be user-facing; passing it
        # through verbatim is the whole point of validating here.
        raise HTTPException(status_code=400, detail={
            "error": f"'{src.name}' is not usable for this slot",
            "reason": reason,
        })
    return details


@router.post("/modules/{module_id}/slot-install")
async def slot_install(module_id: str, req: SlotInstallRequest):
    """Register (`link`) or copy (`copy`) a user-chosen file into a slot."""
    entry = _require_slot_module(module_id)
    mode = (req.mode or "copy").lower()
    if mode not in ("copy", "link"):
        raise HTTPException(status_code=400,
                            detail=f"mode must be 'copy' or 'link', got {req.mode!r}")

    src = Path(os.path.expanduser(str(req.path or "").strip()))
    if not src.is_absolute():
        raise HTTPException(status_code=400,
                            detail="path must be absolute")
    src = Path(os.path.realpath(str(src)))
    details = _slot_validate_source(entry, src)

    slot = entry.get("slot") or {}
    slot_rel = slot.get("directory", "")

    def _work():
        if mode == "link":
            # Nothing is written into the module root at all; deps.slot_path
            # picks the registration up on its next resolve.
            _write_slot_ledger(module_id, entry, mode="link",
                               slot_path=src, slot_rel=slot_rel, files=[])
            return str(src)

        # copy: stage as `<name>.part` (scan_slot skips .part, so a partial
        # transfer is invisible to the capability check) then atomically rename.
        dest_dir = _safe_join(_module_root(), slot_rel)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = _safe_join(_module_root(), f"{slot_rel}/{src.name}")
        if Path(os.path.realpath(str(src))) == Path(os.path.realpath(str(dest))):
            raise HTTPException(status_code=400, detail=(
                "that file is already in the slot directory — nothing to copy"))
        part = _part_of(dest)
        try:
            with open(src, "rb") as fin, open(part, "wb") as fout:
                shutil.copyfileobj(fin, fout, _HASH_CHUNK)
            os.replace(str(part), str(dest))
        except Exception:
            try:
                part.unlink()
            except OSError:
                pass
            raise
        _write_slot_ledger(module_id, entry, mode="copy",
                           slot_path=dest, slot_rel=slot_rel,
                           files=[f"{slot_rel}/{dest.name}"])
        return str(dest)

    try:
        installed_at = await run_in_threadpool(_work)
    except BoundaryError as e:
        raise HTTPException(status_code=409, detail={
            "error": "refused: the destination would fall outside the module root",
            "reason": str(e),
        })

    snap = module_snapshot()
    return {
        "ok": True,
        "id": module_id,
        "mode": mode,
        "path": installed_at,
        "details": details,
        "module": module_by_id(module_id, snap),
        "capabilities": snap["capabilities"],
    }


def _write_slot_ledger(module_id: str, entry: dict, mode: str,
                       slot_path: Path, slot_rel: str, files: list):
    """Ledger row for a slot install.

    `slotRel` is what deps._registered_slot_path matches on — it needs no module
    id, so deps never has to import this router. `verified` is False by design:
    a slot is validated structurally, never hashed, and claiming otherwise would
    put an unearned hash claim in the ledger.
    """
    path = _ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    ledger = _load_ledger()
    ledger[module_id] = {
        "id": module_id,
        "version": entry.get("version"),
        "verified": False,
        "installedAt": datetime.now(timezone.utc).isoformat(),
        "files": files,
        "slotMode": mode,
        "slotPath": str(slot_path),
        "slotRel": slot_rel,
    }
    _atomic_json(path, {"schemaVersion": 1, "modules": ledger})


def _remove_payload(path: Path) -> str:
    """Delete `path`, preferring the OS trash.

    A slot payload is a multi-hundred-MB asset the user obtained themselves —
    an HCP tractogram can be an hours-long re-download — so an accidental
    uninstall should be recoverable. `send2trash` is an OPTIONAL import: where
    it is absent the removal is permanent, and the caller reports which happened
    rather than implying a recycle-bin that did not occur.

    Returns "trashed" or "deleted".
    """
    try:
        from send2trash import send2trash as _to_trash
    except ImportError:
        path.unlink()
        return "deleted"
    try:
        _to_trash(str(path))
        return "trashed"
    except Exception:  # noqa: BLE001 — no trash on this volume (network/UNC)
        path.unlink()
        return "deleted"


def _slot_uninstallable(entry: dict, record: dict, found) -> bool:
    """Whether the store may offer Uninstall for this slot.

    Mirrors _uninstall_slot's refusals exactly; drift here would render a button
    that always 409s."""
    env_var = entry.get("envVar")
    if env_var and os.environ.get(env_var):
        return False
    if record.get("slotMode") == "link":
        return True
    return found is not None and _within(_module_root(), Path(found))


async def _uninstall_slot(module_id: str, entry: dict):
    """Undo a slot install, including a file the user dropped in by hand.

    Three cases, and the distinction is the whole point:

      * an env override (GLOBAL_TRACT_FILE, …) points at storage this app does
        not manage — refuse, exactly as _uninstall_guard does for data modules;
      * a `link` registration never copied anything, so only the registration
        goes. The user's own file elsewhere on disk is not ours to delete;
      * otherwise the asset resolves to a file INSIDE the slot directory under
        MODULE_ROOT. That directory exists *because this app tells the user to
        put files there*, so removing one is in scope even with no ledger entry.
        This is the one deliberate relaxation of rule 6, and it stays bounded by
        the _within() check below — a hand-dropped file anywhere else is still
        refused.
    """
    root = _module_root()
    record = _load_ledger().get(module_id) or {}
    env_var = entry.get("envVar")

    if env_var and os.environ.get(env_var):
        raise HTTPException(status_code=409, detail=(
            f"'{module_id}' resolves through the {env_var} override "
            f"({os.environ[env_var]}), which points outside the module root at "
            f"storage this app does not manage. Refusing to delete it — unset "
            f"{env_var} first."))

    if record.get("slotMode") == "link":
        _drop_ledger(module_id)
        snap = module_snapshot()
        return {
            "ok": True,
            "id": module_id,
            "mode": "link",
            # A link uninstall deliberately frees nothing: the bytes were never
            # ours. Say so rather than reporting a confusing 0 B.
            "unregisteredOnly": True,
            "disposition": "unregistered",
            "removed": [],
            "failed": [],
            "bytesFreed": 0,
            "bytesFreedHuman": human_bytes(0),
            "module": module_by_id(module_id, snap),
            "capabilities": snap["capabilities"],
        }

    _state, _reason, _details, found = _slot_probe(entry)
    target = Path(found) if found else (
        Path(record["slotPath"]) if record.get("slotPath") else None)
    if target is None:
        raise HTTPException(status_code=409, detail=(
            f"'{module_id}' has no file in its slot to remove."))
    if not _within(root, target):
        raise HTTPException(status_code=409, detail=(
            f"'{module_id}' resolves to {target}, outside the module root "
            f"({root}). Refusing to delete files outside the module root."))

    def _work():
        freed, removed, failed = 0, [], []
        disposition = "deleted"
        for p in (target, _part_of(target)):
            try:
                size = p.stat().st_size
            except OSError:
                continue
            try:
                disposition = _remove_payload(p)
            except OSError as e:
                failed.append({"file": str(p), "error": str(e)})
                continue
            freed += size
            removed.append(str(p))
        _prune_empty(target.parent, root)
        _drop_ledger(module_id)
        return freed, removed, failed, disposition

    freed, removed, failed, disposition = await run_in_threadpool(_work)
    snap = module_snapshot()
    return {
        "ok": not failed,
        "id": module_id,
        "mode": record.get("slotMode") or "dropped-in",
        "unregisteredOnly": False,
        # "trashed" (recoverable from the recycle bin) or "deleted" (permanent).
        "disposition": disposition,
        "removed": removed,
        "failed": failed,
        "bytesFreed": freed,
        "bytesFreedHuman": human_bytes(freed),
        "module": module_by_id(module_id, snap),
        "capabilities": snap["capabilities"],
    }


# === Deep verification / repair ===============================================

def _verify_files(entry: dict) -> list:
    """Streamed SHA-256 of every declared file, at the location the app
    actually loads from (module root, or an env override)."""
    base = resolve_entry(entry)
    files = entry.get("files")
    if not files:
        targets = [(base.name, base, entry.get("sha256"), entry.get("bytes"), False)]
    else:
        targets = [(f.get("path"), base / (f.get("path") or ""),
                    f.get("sha256"), f.get("bytes"), bool(f.get("mutable")))
                   for f in files]
    out = []
    for rel, path, expected, declared, mutable in targets:
        digest = _declared_hash(expected)
        # `hashed` is what makes a `verified` claim honest. A row that passed a
        # size check alone is NOT verified, however green it looks.
        #
        # `mutable` files are the exception the atlas revamp introduced: an
        # atlas.json carries the display name and colormap, and a .labels.json
        # carries per-region colours and renamed regions — the app REWRITES
        # both whenever the user edits an atlas. The shipped bytes are still
        # hash-checked at INSTALL time (_require_hashes reads the same
        # sha256); it is only after install, once the file belongs to the user,
        # that a mismatch stops meaning corruption.
        hashed = bool(digest and _SHA256_RE.match(digest)) and not mutable
        row = {"file": rel, "path": str(path), "expected": expected,
               "hashed": hashed, "actual": None, "bytes": None,
               "present": path.exists(), "ok": False}
        if not row["present"]:
            out.append(row)
            continue
        try:
            row["bytes"] = path.stat().st_size
            row["actual"] = _sha256_of(path)
        except OSError as e:
            row["error"] = str(e)
            out.append(row)
            continue
        if hashed:
            row["ok"] = row["actual"] == digest
        elif mutable:
            # Presence is the only honest check. Renaming an atlas rewrites a
            # ~600-byte atlas.json, which moves its size well past the 2% size
            # tolerance — so a size check here would flag every edit as damage
            # just as surely as a hash check would.
            row["ok"] = True
            row["mutable"] = True
            row["note"] = "app-writable metadata — presence checked only"
        else:
            row["ok"] = _size_ok(row["bytes"], declared)
            row["note"] = ("no usable sha256 in the manifest — size checked "
                           "only; this file cannot be verified")
        out.append(row)
    return out


@router.post("/modules/{module_id}/verify")
async def verify_module(module_id: str):
    """Deep, streamed SHA-256 of every file (the slow tier of rule 4). The fast
    exists+size check runs on every /api/modules call; this one is on demand."""
    entry = _require_data_module(module_id)
    results = await run_in_threadpool(_verify_files, entry)
    ok = bool(results) and all(r["ok"] for r in results)
    # `verified` is a HASH claim. A size-only pass on a file with no declared
    # sha256 must never be recorded as one.
    if ok and all(r["hashed"] for r in results):
        _write_ledger(module_id, entry, [r["file"] for r in results], verified=True)
    else:
        # Do not leave a stale `verified: true` claim behind a corrupt file.
        record = _load_ledger().get(module_id)
        if record and record.get("verified"):
            _write_ledger(module_id, entry, record.get("files") or [], verified=False)
    return {
        "id": module_id,
        "ok": ok,
        "files": results,
        "corrupt": [r["file"] for r in results if r["present"] and not r["ok"]],
        "missing": [r["file"] for r in results if not r["present"]],
        # Present and the right size, but the manifest gave us nothing to check
        # them against. Reported, never counted as verified.
        "unhashed": [r["file"] for r in results if not r["hashed"]],
    }


# === Uninstall ================================================================

def _uninstall_guard(entry: dict) -> Path:
    """Rule 6: never delete anything this app did not itself install. Two ways a
    module fails that test:

      * it resolves OUTSIDE the module root, via an explicit env override
        (ATLAS_DIR, GLOBAL_TRACT_FILE, …) pointed somewhere else; or
      * it sits INSIDE the root but has no install-ledger entry — i.e. it is
        tracked source or user-supplied data in a dev checkout (the atlases the
        repo ships, a hand-dropped slot file), not something this app downloaded.

    An install writes the ledger; only then may uninstall remove those files."""
    resolved = resolve_entry(entry)
    root = _module_root()
    if not _within(root, resolved):
        raise HTTPException(status_code=409, detail=(
            f"'{entry.get('id')}' resolves to {resolved}, outside the module "
            f"root ({root}) — most likely via the {entry.get('envVar')} "
            f"override. Refusing to delete files outside the module root."))
    if entry.get("id") not in _load_ledger():
        raise HTTPException(status_code=409, detail=(
            f"'{entry.get('id')}' is present under the module root but was not "
            f"installed by this app (no install-ledger entry) — it is part of "
            f"your checkout, not a managed install. Refusing to delete files it "
            f"did not install."))
    return resolved


def _prune_empty(dirpath: Path, stop: Path):
    """Remove now-empty directories up to (but never including) `stop`."""
    cur = dirpath
    stop_n = _norm(stop)
    while _norm(cur) != stop_n and _within(stop, cur):
        try:
            next(cur.iterdir())
            return
        except StopIteration:
            pass
        except OSError:
            return
        try:
            cur.rmdir()
        except OSError:
            return
        cur = cur.parent


@router.delete("/modules/{module_id}")
async def uninstall_module(module_id: str):
    """Delete a module's files and report the space freed.

    Only the manifest's declared files are removed — four modules share the
    `atlases` directory, so removing `installTo` wholesale would take three
    other modules with it."""
    # Slots resolve to a user-chosen path rather than a manifest `installTo`,
    # and a `link` install has nothing under the root to delete at all, so they
    # get their own guard rather than being forced through _uninstall_guard's
    # resolve_entry()/installTo assumptions.
    if (_manifest_entry(module_id).get("type") or "data") == "slot":
        return await _uninstall_slot(module_id, _require_slot_module(module_id))
    entry = _require_data_module(module_id)
    _uninstall_guard(entry)
    base = _install_base(entry)
    items = _plan_or_400(entry)
    root = _module_root()

    def _work():
        freed = 0
        removed, failed = [], []
        disposition = "deleted"
        for it in items:
            for path in (it["dest"], _part_of(it["dest"])):
                try:
                    size = path.stat().st_size
                except OSError:
                    continue
                if not _within(root, path):     # belt and braces
                    failed.append({"file": str(path), "error": "outside module root"})
                    continue
                try:
                    disposition = _remove_payload(path)
                except OSError as e:
                    failed.append({"file": str(path), "error": str(e)})
                    continue
                freed += size
                removed.append(str(path))
        _prune_empty(base if entry.get("files") else base.parent, root)
        _drop_ledger(module_id)
        return freed, removed, failed, disposition

    freed, removed, failed, disposition = await run_in_threadpool(_work)
    snap = module_snapshot()
    return {
        "ok": not failed,
        "id": module_id,
        "disposition": disposition,
        "removed": removed,
        "failed": failed,
        "bytesFreed": freed,
        "bytesFreedHuman": human_bytes(freed),
        "module": module_by_id(module_id, snap),
        "capabilities": snap["capabilities"],
    }


# === Download engine ==========================================================
# Lives in the backend, not Electron's main process, so one implementation
# serves the browser bundle and the desktop app. `requests` with stream=True +
# HTTP Range resume — no new dependency.

def _release_base() -> str:
    """Base URL for `github-release` sources. Deliberately has no default: with
    nothing hosted yet, an unset value must mean 'no downloadable source'
    rather than a silent call out to a URL that does not exist."""
    return (os.environ.get("MRLATTE_MODULE_RELEASE_BASE") or "").rstrip("/")


def _check_url(url: str) -> str:
    if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400,
                            detail=f"only http(s) download URLs are allowed: {url!r}")
    return url


def _download_url_for(entry: dict, override):
    """Resolve the URL an install job should fetch, or None if this module has
    no configured download source (every `upstream` entry in the manifest is a
    landing page, not a direct download — those are sideload-only)."""
    if override:
        return _check_url(override)
    base = _release_base()
    if not base:
        return None
    for src in entry.get("sources") or []:
        if src.get("type") == "github-release" and src.get("asset"):
            tag = src.get("tag")
            return _check_url(f"{base}/{tag}/{src['asset']}" if tag
                              else f"{base}/{src['asset']}")
    return None


_JOB_LOCK = threading.Lock()
_JOB_CANCELLED = set()          # job_ids the user asked to stop
_JOB_BY_MODULE = {}             # module_id -> most recent job_id


class JobCancelled(Exception):
    pass


def _job_dir(job_id: str) -> Path:
    # deps._UUID4_RE is underscore-prefixed, so `from deps import *` skips it.
    if not deps._UUID4_RE.match(job_id or ""):
        raise HTTPException(status_code=400, detail="invalid job id")
    return _jobs_root() / job_id


def _set_job(job_id: str, /, **fields):
    """Merge `fields` into the job's status.json. Atomic (tmp + os.replace) so
    the poller never reads a half-written file — same pattern as
    worker_common.make_set_status and the summary/dissect jobs."""
    d = _jobs_root() / job_id
    path = d / "status.json"
    current = {}
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        current = {}
    current.update(fields)
    current["updatedAt"] = time.time()
    try:
        _atomic_json(path, current)
    except OSError:
        logger.warning("module job %s: could not write status", job_id)
    return current


def _cancelled(job_id: str) -> bool:
    with _JOB_LOCK:
        return job_id in _JOB_CANCELLED


def _download(url: str, part: Path, job_id: str, expected_bytes=None):
    """Stream `url` into `part`, resuming from whatever is already there.

    Returns the number of bytes on disk. Raises JobCancelled if the user
    cancelled; the partial `.part` is left in place so a retry resumes.
    """
    import requests   # local: keeps the import off the app's startup path

    part.parent.mkdir(parents=True, exist_ok=True)
    have = part.stat().st_size if part.exists() else 0
    headers = {"Accept-Encoding": "identity"}   # Range + gzip do not mix
    if have:
        headers["Range"] = f"bytes={have}-"

    with requests.get(url, stream=True, timeout=(10, 120), headers=headers,
                      allow_redirects=True) as r:
        if r.status_code == 416:                # already complete
            return have
        if have and r.status_code == 200:       # server ignored the Range
            have, mode = 0, "wb"
        elif r.status_code == 206:
            mode = "ab"
        elif r.status_code == 200:
            mode = "wb"
        else:
            r.raise_for_status()
            mode = "wb"
        try:
            total = int(r.headers.get("Content-Length") or 0) + have
        except (TypeError, ValueError):
            total = 0
        total = total or int(expected_bytes or 0) or None
        _set_job(job_id, stage="downloading", bytes_done=have, bytes_total=total)

        done = have
        last = 0.0
        with open(part, mode) as out:
            for chunk in r.iter_content(chunk_size=_HASH_CHUNK):
                if _cancelled(job_id):
                    raise JobCancelled()
                if not chunk:
                    continue
                out.write(chunk)
                done += len(chunk)
                now = time.monotonic()
                if now - last > 0.25:
                    last = now
                    _set_job(job_id, stage="downloading", bytes_done=done,
                             bytes_total=total,
                             progress=(done / total) if total else 0.0)
        _set_job(job_id, bytes_done=done, bytes_total=total or done, progress=1.0)
    return done


def _run_install_job(job_id: str, module_id: str, entry: dict, url: str):
    """Body of a download+install job. Runs on a worker thread."""
    items = _require_hashes(_plan_or_400(entry))
    multi = bool(entry.get("files"))
    stage_dir = _staging_root() / f"job-{job_id}"
    archive = stage_dir / "module.zip"
    try:
        _set_job(job_id, stage="downloading", progress=0.0, error=None)
        if multi:
            part = _part_of(archive)
            _download(url, part, job_id, entry.get("bytes"))
            os.replace(str(part), str(archive))
            _set_job(job_id, stage="verifying", progress=1.0)
            _install_from_zip(entry, archive, items)
        else:
            it = items[0]
            part = _part_of(it["dest"])
            _download(url, part, job_id, it.get("bytes"))
            _set_job(job_id, stage="verifying", progress=1.0)
            # The download already wrote <dest>.part; verify it in place and
            # promote only on a match.
            _install_raw_file(entry, part, items)
        _write_ledger(module_id, entry, [it["rel"] for it in items],
                      verified=_all_verified(items))
        _set_job(job_id, stage="done", done=True, progress=1.0)
    except JobCancelled:
        _set_job(job_id, stage="cancelled", done=True,
                 error="cancelled by user")
    except HTTPException as e:
        _set_job(job_id, stage="error", done=True, error=e.detail)
    except Exception as e:  # noqa: BLE001 — a job must record its failure
        logger.exception("module install job %s failed", job_id)
        _set_job(job_id, stage="error", done=True, error=f"{type(e).__name__}: {e}")
    finally:
        shutil.rmtree(stage_dir, ignore_errors=True)
        with _JOB_LOCK:
            _JOB_CANCELLED.discard(job_id)
            # Stop advertising a finished job as this module's cancellable one.
            if _JOB_BY_MODULE.get(module_id) == job_id:
                _JOB_BY_MODULE.pop(module_id, None)


class InstallRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    sourceUrl: Optional[str] = None


@router.post("/modules/{module_id}/install")
async def install_module(module_id: str, body: Optional[InstallRequest] = None):
    """Start a download+install job. Returns { job_id } — poll
    /api/modules/jobs/{job_id} for progress."""
    entry = _require_data_module(module_id)
    url = _download_url_for(entry, body.sourceUrl if body else None)
    if not url:
        raise HTTPException(status_code=409, detail=(
            f"'{module_id}' has no downloadable source. "
            + ("It is non-redistributable — obtain it yourself and use "
               "Sideload." if not (entry.get("license") or {}).get("redistributable")
               else "Set MRLATTE_MODULE_RELEASE_BASE or pass sourceUrl.")))
    # Fail closed BEFORE a job exists: a module the manifest declares no usable
    # sha256 for is refused at request time, not hundreds of MB later.
    _require_hashes(_plan_or_400(entry))
    job_id = str(uuid.uuid4())
    (_jobs_root() / job_id).mkdir(parents=True, exist_ok=True)
    _set_job(job_id, job_id=job_id, module=module_id, url=url, stage="queued",
             progress=0.0, bytes_done=0, bytes_total=entry.get("bytes") or 0,
             done=False, error=None, startedAt=time.time())
    with _JOB_LOCK:
        _JOB_BY_MODULE[module_id] = job_id
    threading.Thread(target=_run_install_job,
                     args=(job_id, module_id, entry, url),
                     name=f"module-install-{module_id}", daemon=True).start()
    return {"job_id": job_id, "id": module_id, "url": url}


@router.get("/modules/jobs/{job_id}")
async def module_job_status(job_id: str):
    path = _job_dir(job_id) / "status.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        raise HTTPException(status_code=404, detail="unknown job")
    except json.JSONDecodeError:
        # A reader that lost the race with a rename; the next poll succeeds.
        return {"job_id": job_id, "stage": "downloading", "progress": 0.0,
                "done": False, "error": None}


@router.post("/modules/{module_id}/cancel")
async def cancel_module_job(module_id: str, job_id: Optional[str] = None):
    """Stop the module's running install. The partial `.part` is kept so a
    later install resumes with an HTTP Range request."""
    with _JOB_LOCK:
        jid = job_id or _JOB_BY_MODULE.get(module_id)
    if not jid:
        raise HTTPException(status_code=404,
                            detail=f"no install job for '{module_id}'")
    try:
        if json.loads((_job_dir(jid) / "status.json").read_text(
                encoding="utf-8")).get("done"):
            raise HTTPException(status_code=409,
                                detail=f"job {jid} has already finished")
    except (OSError, json.JSONDecodeError):
        pass
    with _JOB_LOCK:
        _JOB_CANCELLED.add(jid)
    _set_job(jid, stage="cancelling")
    return {"ok": True, "id": module_id, "job_id": jid}
