"""Shared lesion-metrics engine: lqtpy called in-process, wired to MRLatte's
own atlas registry.

Plain module -- **no FastAPI imports** -- so both routers/lesion_metrics.py
and (later) the One-Click Summary job can call it directly. Mirrors the shape
of worker_common.py: import-time side effects are limited to a defensive
`import lqtpy`, never a crash.

lqtpy is pinned in requirements-frozen.txt to a commit SHA on the published
repo (https://github.com/rohan3412/LQTpy) -- see that file's header. Even so,
every caller in this module must tolerate lqtpy being absent in a dev
environment that hasn't installed it -- `available()` reports that state, and
`compute_metrics` raises `LqtpyUnavailableError` instead of letting an
ImportError/AttributeError leak out of `import server`.
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

try:
    import lqtpy
    import lqtpy.datasets as _lqtpy_datasets
    _LQTPY_IMPORT_ERROR = None
except Exception as exc:  # noqa: BLE001 -- absence must not break `import server`
    lqtpy = None
    _lqtpy_datasets = None
    _LQTPY_IMPORT_ERROR = exc


class LesionMetricsError(Exception):
    """Base class for errors this module raises directly (not re-raised from
    lqtpy). Carries the HTTP status the router should use."""

    status_code = 500


class LqtpyUnavailableError(LesionMetricsError):
    """lqtpy is not installed in this environment. Maps to HTTP 503."""

    status_code = 503

    def __init__(self, message: str = None):
        super().__init__(message or (
            "lqtpy is not installed in this backend environment. "
            "Run: python -m pip install -e <path-to-LQTpy-clone> --no-deps "
            f"(import failed with: {_LQTPY_IMPORT_ERROR!r})"
        ))


class UnknownAtlasIdError(LesionMetricsError):
    """An atlas id was requested that is not bridged from MRLatte's atlas
    registry. Maps to HTTP 4xx."""

    status_code = 400


class UnknownSectionError(LesionMetricsError):
    """A report-fragment section id outside lqtpy.report.style.VALID_SECTIONS
    was requested. Maps to HTTP 4xx."""

    status_code = 400


class InvalidThemeError(LesionMetricsError):
    """A report-fragments `theme` override held an unknown key or a value
    that doesn't parse as a CSS colour. Maps to HTTP 4xx."""

    status_code = 400


def available() -> bool:
    return lqtpy is not None


def version() -> "str | None":
    return getattr(lqtpy, "__version__", "unknown") if lqtpy is not None else None


def import_error() -> "Exception | None":
    return _LQTPY_IMPORT_ERROR


# --------------------------------------------------------------------------- #
# Atlas bridging: MRLatte's atlas_registry -> lqtpy.register_atlas
# --------------------------------------------------------------------------- #
# Overlap numbers must be computed on the SAME atlases the viewer shows, not
# lqtpy's own bundled aal/schaefer/dk (those are a different AAL parcellation
# revision and a different Harvard-Oxford-adjacent set entirely -- registering
# over them would silently answer a different question than "what does the
# viewer's Harvard-Oxford atlas say"). So every eligible MRLatte atlas is
# registered into lqtpy under its OWN MRLatte id (`d["id"]`, not an alias),
# and MRLatte atlas ids are the only ones this module's compute_metrics will
# accept for `atlas_ids`.
#
# Eligible kinds: "parcellation" and "networks" (one discrete label per
# voxel, which is exactly what lqtpy.overlap.region_overlap needs) and
# "tracts" (a single max-probability label volume -- same shape, just tract
# ids instead of parcel ids). "tracts4d" (a per-bundle binary stack) and
# "continuous" (e.g. Benson polar-angle/eccentricity maps) do not fit
# lqtpy's one-label-per-voxel overlap model and are left out.
_BRIDGEABLE_KINDS = frozenset({"parcellation", "networks", "tracts"})

#: id -> (volume_mtime_ns, labels_mtime_ns) for the atlases currently
#: registered into lqtpy. This is the source of truth for "what atlas ids
#: does compute_metrics accept" -- NOT lqtpy.atlases.list_atlases(), which
#: also lists lqtpy's own bundled atlases and (see note below) can hold
#: stale registrations for an atlas MRLatte has since removed.
_bridge_state: "dict[str, tuple]" = {}
_bridge_lock = threading.Lock()


def _atlas_registry():
    import atlas_registry
    return atlas_registry


def _eligible_descriptors():
    atlas_registry = _atlas_registry()
    out = []
    for d in atlas_registry.list_atlases(include_hidden=True):
        if d.get("kind") not in _BRIDGEABLE_KINDS:
            continue
        if not d.get("installed") or not d.get("hasLabels"):
            continue
        out.append(d)
    return out


def _descriptor_for(atlas_id: str) -> "dict | None":
    """The eligible MRLatte atlas descriptor for `atlas_id`, or None. Used by
    the report-fragments engine to resolve a display name / labels for a
    bridged atlas without re-walking the registry inline."""
    for d in _eligible_descriptors():
        if d["id"] == atlas_id:
            return d
    return None


def _mtime_ns(path) -> int:
    try:
        return Path(path).stat().st_mtime_ns
    except OSError:
        return -1


def _label_dict_for(d: dict) -> dict:
    """{value: (RegionName, Group)} for one MRLatte atlas descriptor, built
    from its labels.json via the same atlas_labels reader every other MRLatte
    consumer uses. `Group` mirrors lqtpy's own AAL hemi() convention (falls
    back to the region's own `hemi` field, else "")."""
    import atlas_labels
    regions = atlas_labels.read_labels_or_empty(d["labelsPath"])
    return {
        int(r["value"]): (str(r["name"]), str(r.get("hemi") or ""))
        for r in regions
    }


def sync_atlases(force: bool = False) -> None:
    """Re-register every eligible MRLatte atlas into lqtpy if the registry
    changed since the last sync. Cheap: the signature is just an mtime pair
    per atlas, no data is read unless something actually changed.

    Atlas REMOVAL is a known, documented gap: lqtpy.atlases has no
    unregister call, so an atlas deleted from MRLatte stays cached inside
    lqtpy (harmless -- it just never gets rebuilt again). `_bridge_state`
    tracks only what MRLatte *currently* has, which is what `bridged_atlas_ids()`
    reports and what `compute_metrics` validates `atlas_ids` against, so a
    removed atlas is never offered or accepted even though lqtpy's own cache
    still holds it.
    """
    if lqtpy is None:
        return
    descriptors = _eligible_descriptors()
    signature = {
        d["id"]: (_mtime_ns(d["volumePath"]), _mtime_ns(d["labelsPath"]))
        for d in descriptors
    }
    with _bridge_lock:
        if not force and signature == _bridge_state:
            return
        for d in descriptors:
            key = d["id"]
            if not force and _bridge_state.get(key) == signature.get(key):
                continue
            labels = _label_dict_for(d)
            if not labels:
                continue
            lqtpy.register_atlas(key, d["name"], d["volumePath"], labels,
                                  overwrite=True)
        _bridge_state.clear()
        _bridge_state.update(signature)


def bridged_atlas_ids() -> "list[str]":
    """MRLatte atlas ids currently valid for `compute_metrics`' `atlas_ids`."""
    if lqtpy is None:
        return []
    sync_atlases()
    return sorted(_bridge_state.keys())


def preload(timeout_s: float = None) -> dict:
    """Best-effort startup warmup: bridge every eligible atlas and build its
    lqtpy label cache up front. Fail-soft on every axis -- lqtpy absent, an
    individual atlas failing to load, or the whole pass erroring out all
    leave the server startable; only the timing is reported.

    Not a hard timeout (`preload`/`register_atlas` have no cancellation
    hook) -- callers that need a startup deadline should run this via
    asyncio.wait_for from the lifespan, same as any other blocking call.
    """
    t0 = time.monotonic()
    result = {"available": lqtpy is not None, "atlas_ids": [], "duration_s": 0.0,
              "error": None}
    if lqtpy is None:
        result["duration_s"] = round(time.monotonic() - t0, 4)
        return result
    try:
        sync_atlases(force=True)
        ids = sorted(_bridge_state.keys())
        lqtpy.preload(keys=ids)
        result["atlas_ids"] = ids
    except Exception as exc:  # noqa: BLE001 -- startup must never fail on this
        logger.warning("lesion_metrics preload failed (continuing): %s", exc)
        result["error"] = str(exc)
    result["duration_s"] = round(time.monotonic() - t0, 4)
    return result


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #
DEFAULT_THRESHOLD = 0.5


def compute_metrics(lesion_path, atlas_ids, threshold: float = DEFAULT_THRESHOLD) -> dict:
    """Lesion morphometry + per-atlas overlap for one lesion, computed by
    lqtpy on MRLatte's own bridged atlases.

    Raises `LqtpyUnavailableError` (lqtpy absent), `UnknownAtlasIdError` (an
    id not bridged from the atlas registry), or lets lqtpy's own typed
    errors (`lqtpy.errors.InvalidLesionError`/`GeometryError` for bad input,
    `DataUnavailableError`/`MissingDependencyError` for environment
    problems) propagate -- the router maps all of these to HTTP status
    codes; see routers/lesion_metrics.py.
    """
    if lqtpy is None:
        raise LqtpyUnavailableError()

    sync_atlases()
    wanted = list(atlas_ids or [])
    available_ids = set(_bridge_state.keys())
    unknown = [a for a in wanted if a not in available_ids]
    if unknown:
        raise UnknownAtlasIdError(
            f"Unknown atlas id(s) for lesion-metrics overlap: {unknown}. "
            f"Available: {sorted(available_ids)}")

    stats = lqtpy.lesion_stats(lesion_path, threshold=threshold)
    overlap = {aid: lqtpy.atlas_overlap(lesion_path, aid, threshold=threshold)
               for aid in wanted}

    return {
        "lesion_stats": stats,
        "atlas_overlap": overlap,
        "provenance": {
            "engine": "lqtpy",
            "version": getattr(lqtpy, "__version__", "unknown"),
            "threshold": threshold,
            "resampling": "lesion→atlas grid",
        },
    }


# --------------------------------------------------------------------------- #
# overlap_model mapping: compute_metrics() -> the shape the frontend, the
# One-Click Summary render worker, and the report section builders all
# consume. MIRRORS frontend/src/lib/lesionReport.js's resolveLesionAtlasMetrics
# (the `const rows = records.map(...)` block and the `volume`/`provenance`
# object literals just above it) field-for-field. Keep the two in lockstep by
# hand -- there is no shared schema file; backend/tests/test_lesion_metrics.py
# pins this mapping so the two can't silently drift apart.
# --------------------------------------------------------------------------- #

def _row_from_record(r: dict) -> dict:
    """One lqtpy atlas_overlap() record -> the row shape report/sections.js
    and OverlapPanel already render (label/regionName/group/voxelCount/
    regionVoxelCount/percentOfLesion/percentOfRegion). Mirrors the
    `rows = records.map(...)` block in resolveLesionAtlasMetrics
    (frontend/src/lib/lesionReport.js) -- LesionVoxels->voxelCount,
    PercentDamage->percentOfRegion, PercentOfLesion->percentOfLesion.
    """
    return {
        "label": r["LabelID"],
        "regionName": r["RegionName"],
        "group": r["Group"],
        "voxelCount": r["LesionVoxels"],
        "regionVoxelCount": r["RegionVoxels"],
        "percentOfLesion": r["PercentOfLesion"],
        "percentOfRegion": r["PercentDamage"],
    }


def build_overlap_model(result: dict, atlas_names: "dict[str, str]") -> dict:
    """compute_metrics()'s return -> {volume, atlasBreakdowns[], excludedAtlases,
    provenance} -- the SAME overlap-model shape
    resolveLesionAtlasMetrics()/buildLesionReportModel() build in
    frontend/src/lib/lesionReport.js, and that summary_render_worker.py's CSV
    writer and lib/report/sections.js's section builders already consume.

    Pure function, no I/O: `atlas_names` is {atlas_id: display_name} for
    every id present in `result["atlas_overlap"]`, already resolved by the
    caller (see deps.py's _run_summary_job) via atlas_registry, the same way
    the frontend passes `a.name` from its already-loaded atlas list.
    `excludedAtlases` is always `[]` here -- the caller (which knows which
    requested ids were NOT bridged) fills that in, mirroring
    resolveLesionAtlasMetrics's own `excludedAtlases` construction.

    rows are sorted descending by voxelCount, matching both the JS engine's
    ordering and resolveLesionAtlasMetrics's explicit re-sort after mapping.
    """
    stats = result.get("lesion_stats") or {}
    volume_mm3 = stats.get("volume_mm3")
    volume = {
        "voxelCount": stats.get("n_voxels", 0),
        "mm3": volume_mm3 or 0,
        "cm3": stats.get("volume_cc") if stats.get("volume_cc") is not None
               else ((volume_mm3 / 1000) if volume_mm3 is not None else 0),
        "centroidMM": stats.get("center_of_mass_mm"),
    }
    atlas_breakdowns = []
    for atlas_id, records in (result.get("atlas_overlap") or {}).items():
        rows = [_row_from_record(r) for r in (records or [])]
        rows.sort(key=lambda r: r["voxelCount"], reverse=True)
        atlas_breakdowns.append({
            "atlasId": atlas_id,
            "atlasName": atlas_names.get(atlas_id, atlas_id),
            "rows": rows,
            "voxelGrid": "atlas",
        })
    prov = result.get("provenance") or {}
    return {
        "volume": volume,
        "atlasBreakdowns": atlas_breakdowns,
        "excludedAtlases": [],
        "provenance": {
            "engine": prov.get("engine", "lqtpy"),
            "version": prov.get("version"),
            "threshold": prov.get("threshold"),
            "resampling": "atlas-grid",
            "fallback": False,
            "fallbackReason": None,
        },
    }


def disconnection_index_available() -> bool:
    """Whether lqtpy's per-tract DISCONNECTION index is present, i.e. whether
    `lqtpy.api.tract_disconnection` can run. This index is built locally
    (tools/build_discon_index.py) and is NOT the tract-overlap proxy data
    bundled in the wheel; probing the proxy here would report `true` on every
    install even though disconnection would fail. Never raises: any failure
    is reported as unavailable."""
    if _lqtpy_datasets is None:
        return False
    try:
        return bool(_lqtpy_datasets.discon_index_available())
    except Exception:  # noqa: BLE001 -- capability probe must never raise
        return False


# --------------------------------------------------------------------------- #
# Report fragments: lqtpy's embeddable HTML sections for parts of the report
# MRLatte doesn't render itself (morphometry detail, network rollup,
# per-tract streamline disconnection -- see lqtpy/report/fragments.py).
#
# Deliberately NOT embedded by MRLatte's report composer (see
# frontend/src/lib/lesionReport.js's resolveReportFragments): "parcel_damage"
# duplicates the atlas-overlap table MRLatte already renders from these same
# lqtpy numbers (build_overlap_model, above), and "tract_proxy" is a coarse
# voxel-overlap proxy that must never stand in for real disconnection. Both
# are still implemented here so the endpoint's section allowlist matches
# lqtpy.report.style.VALID_SECTIONS honestly -- a caller that explicitly asks
# for them gets them, MRLatte's own report composer just never does.
# --------------------------------------------------------------------------- #

#: MRLatte's own report theme (frontend/src/lib/report/render.js's REPORT_CSS)
#: mapped onto ReportStyle's four colour knobs, so lqtpy's fragments read as
#: part of MRLatte's report rather than a visually foreign insert:
#:   accent      -> .stat-card's default --accent / primary blue
#:   text        -> .stat-value / banner's darkest tone
#:   muted_text  -> .stat-label / .section-title
#:   border      -> .data-table / .stat-card borders
#:   surface     -> .stat-card / .data-table background
#:   row_stripe  -> .pill / .img-panel-header background
#: ReportStyle has no font knob -- fragments.stylesheet() sets
#: `font-family: inherit` on .lqt-root, so it already inherits MRLatte's own
#: body font with no extra mapping needed.
MRLATTE_REPORT_THEME = {
    "accent": "#2563eb",
    "text": "#0f172a",
    "muted_text": "#64748b",
    "border": "#e2e8f0",
    "surface": "#f8fafc",
    "row_stripe": "#f1f5f9",
}


def _build_report_style(theme, ReportStyle):
    """MRLatte's theme, with any caller-supplied `theme` dict overriding
    individual colour keys. Unknown keys or a value ReportStyle itself
    rejects as an implausible CSS colour both raise InvalidThemeError (4xx) --
    never a raw ValueError/KeyError leaking out as a 500."""
    kwargs = dict(MRLATTE_REPORT_THEME)
    if theme:
        unknown = sorted(set(theme) - set(MRLATTE_REPORT_THEME))
        if unknown:
            raise InvalidThemeError(
                f"Unknown theme key(s) {unknown}; allowed: {sorted(MRLATTE_REPORT_THEME)}")
        for key in MRLATTE_REPORT_THEME:
            if key in theme:
                kwargs[key] = theme[key]
    try:
        return ReportStyle(**kwargs)
    except ValueError as exc:
        raise InvalidThemeError(str(exc)) from exc


def network_rollup_eligible(atlas_id: str) -> "tuple[bool, str | None]":
    """Whether `atlas_id` carries genuine per-region network/group
    assignments lqtpy.network_rollup_for can roll up into more than one
    bucket. `_label_dict_for` builds each label's Group from the atlas's
    `hemi` field -- for a rollup to mean anything, at least two distinct
    non-empty Group values must exist across the atlas's labels (lqtpy's own
    docs: network_rollup_for is "intended for the Schaefer atlas, whose Group
    column is the Yeo network token").

    As of writing, every MRLatte atlas ships `hemi: null` for every label
    (verified against data/modules/atlases/*/*.labels.json) -- including
    yeo7 ("kind": "networks"), whose *regions* already ARE the Yeo-7 networks
    one-for-one, so a rollup would just collapse all of them back into a
    single meaningless bucket; that atlas's per-network breakdown is already
    exactly what MRLatte's own atlas-overlap section shows when yeo7 is
    selected. So this is False for every currently-bridged atlas -- the
    check stays generic (rather than hardcoded False) so a future atlas with
    real sub-region network grouping is picked up automatically."""
    d = _descriptor_for(atlas_id)
    if d is None:
        return False, f"atlas '{atlas_id}' is not bridged into lqtpy."
    labels = _label_dict_for(d)
    groups = {group for (_name, group) in labels.values() if group}
    if len(groups) < 2:
        return False, (
            f"atlas '{atlas_id}' has no per-region network/group assignment for lqtpy to "
            "roll up (network_rollup_for is meant for an atlas whose regions are grouped "
            "into functional networks, e.g. Schaefer parcels grouped by Yeo-7 network); "
            "MRLatte's own atlas-overlap section already shows this atlas's regions."
        )
    return True, None


def build_report_fragments(lesion_path, atlas_ids, sections, threshold: float = DEFAULT_THRESHOLD,
                            theme: "dict | None" = None) -> dict:
    """lqtpy HTML fragments (+ stylesheet) for the requested `sections`, for
    one lesion. `sections` is validated against lqtpy.report.style.VALID_SECTIONS
    (unknown id -> UnknownSectionError, 4xx). Every requested atlas id is
    validated against the currently-bridged set exactly like compute_metrics
    does (unknown id -> UnknownAtlasIdError, 4xx) -- so no caller-supplied
    string (atlas id or section id) is ever used to build HTML; the router-
    facing values (atlas display name) that DO reach the fragment HTML come
    from MRLatte's own atlas registry, and lqtpy's fragment builders
    HTML-escape every data value regardless.

    Returns {"stylesheet": str, "fragments": {kind: html}, "unavailable":
    {kind: reason}, "provenance": {...}}. A section that can't be rendered
    (disconnection index not built, no atlas carries network/group data, ...)
    lands in `unavailable` with an actionable reason instead of failing the
    whole request; a genuinely bad lesion/atlas (InvalidLesionError,
    GeometryError, UnknownAtlasError) still raises, since every section would
    fail identically.
    """
    if lqtpy is None:
        raise LqtpyUnavailableError()

    from lqtpy.report import fragments as report_fragments
    from lqtpy.report.style import ReportStyle, VALID_SECTIONS
    from lqtpy.errors import DataUnavailableError, MissingDependencyError

    wanted_sections = list(sections or [])
    unknown_sections = sorted(set(wanted_sections) - set(VALID_SECTIONS))
    if unknown_sections:
        raise UnknownSectionError(
            f"Unknown report section id(s) {unknown_sections}; valid ids: {sorted(VALID_SECTIONS)}")

    style = _build_report_style(theme, ReportStyle)

    sync_atlases()
    bridged = set(_bridge_state.keys())
    wanted_atlases = list(atlas_ids or [])
    unknown_atlases = [a for a in wanted_atlases if a not in bridged]
    if unknown_atlases:
        raise UnknownAtlasIdError(
            f"Unknown atlas id(s) for report fragments: {unknown_atlases}. "
            f"Available: {sorted(bridged)}")
    out_fragments: "dict[str, str]" = {}
    unavailable: "dict[str, str]" = {}

    for kind in wanted_sections:
        try:
            if kind == "morphometry":
                stats = lqtpy.lesion_stats(lesion_path, threshold=threshold)
                out_fragments[kind] = report_fragments.morphometry_fragment(stats, style)

            elif kind == "disconnection":
                if not disconnection_index_available():
                    unavailable[kind] = (
                        "not available -- the disconnection index isn't built on this "
                        "machine. Build it locally with lqtpy's tools/build_discon_index.py, "
                        "then point LQTPY_DATA_HOME at the directory holding the built index "
                        "and restart the backend."
                    )
                else:
                    records = lqtpy.tract_disconnection(lesion_path, threshold=threshold)
                    out_fragments[kind] = report_fragments.disconnection_fragment(records, style)

            elif kind == "tract_proxy":
                records = lqtpy.tract_proxy_overlap(lesion_path, threshold=threshold)
                out_fragments[kind] = report_fragments.tract_proxy_fragment(records, style)

            elif kind == "parcel_damage":
                if not wanted_atlases:
                    unavailable[kind] = "no atlas_ids were provided for parcel_damage."
                    continue
                parts = []
                for aid in wanted_atlases:
                    records = lqtpy.atlas_overlap(lesion_path, aid, threshold=threshold)
                    name = (_descriptor_for(aid) or {}).get("name", aid)
                    parts.append(report_fragments.parcel_damage_fragment(records, name, style))
                out_fragments[kind] = "".join(parts)

            elif kind == "network_rollup":
                if not wanted_atlases:
                    unavailable[kind] = "no atlas_ids were provided for network_rollup."
                    continue
                parts = []
                reasons = []
                for aid in wanted_atlases:
                    eligible, reason = network_rollup_eligible(aid)
                    if not eligible:
                        reasons.append(f"{aid}: {reason}")
                        continue
                    records = lqtpy.network_rollup_for(lesion_path, aid, threshold=threshold)
                    parts.append(report_fragments.network_rollup_fragment(records, style))
                if parts:
                    out_fragments[kind] = "".join(parts)
                elif reasons:
                    unavailable[kind] = "; ".join(reasons)
        except (DataUnavailableError, MissingDependencyError) as exc:
            # Environment gap for THIS section only (e.g. a missing optional
            # data file) -- report it and keep computing the rest, rather than
            # failing sections that don't depend on it.
            unavailable[kind] = str(exc)

    provenance = {
        "engine": "lqtpy",
        "version": getattr(lqtpy, "__version__", "unknown"),
        "threshold": threshold,
        "disconnectionIndexAvailable": disconnection_index_available(),
    }
    return {
        "stylesheet": report_fragments.stylesheet(style),
        "fragments": out_fragments,
        "unavailable": unavailable,
        "provenance": provenance,
    }


def status_code_for(exc: Exception) -> int:
    """Map an exception raised by this module or by lqtpy to an HTTP status
    code, for callers that build their own response instead of relying on
    the router's exception handling."""
    if isinstance(exc, LesionMetricsError):
        return exc.status_code
    if lqtpy is not None:
        from lqtpy.errors import (
            InvalidLesionError, GeometryError, UnknownAtlasError,
            MissingDependencyError, DataUnavailableError,
        )
        if isinstance(exc, (InvalidLesionError, GeometryError, UnknownAtlasError)):
            return 400
        if isinstance(exc, (MissingDependencyError, DataUnavailableError)):
            return 500
    return 500
