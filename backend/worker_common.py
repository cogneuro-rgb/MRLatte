"""Shared helpers for the isolated subprocess workers (dissect_worker.py,
dissect_between_worker.py, lnm_worker.py, summary_render_worker.py).

Extracted from three byte-identical copies of `_make_set_status` and two
byte-identical copies of the Harvard-Oxford / 4D-tract atlas-overlap
functions. This is a pure relocation — every function body below is
unchanged from its original worker copy; only where it's defined moved.
"""
import json
import math
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import nibabel as nib

import atlas_labels


# ── Cross-process sys.path propagation ───────────────────────────────────────
# Workers are spawned as fresh subprocesses of the SAME interpreter
# ([sys.executable, script, config_json] — deps._run_worker_json and the three
# sync spawn sites in routers/tracts.py and routers/lnm.py). A child process
# never inherits its parent's sys.path, and in a packaged install the
# embeddable Python's python*._pth switches sys.path to "isolated" mode, which
# makes CPython IGNORE PYTHONPATH entirely — so PYTHONPATH can't carry paths
# across the boundary either. frontend/public/electron.js's backend bootstrap
# works around this exact restriction for the PARENT process (via a `-c`
# script that inserts site-packages/backend/the optional stacks before
# importing uvicorn); this is the other half of that same story for workers.
# The two OPTIONAL stacks a full build adds beyond the baked-in `site-packages`
# (python-reports, python-validation — see assemble-bundle.ps1) reach the
# parent through that bootstrap but never reach a worker on their own, so e.g.
# summary_render_worker.py's brainsprite figures silently fail to import
# nilearn/matplotlib in a full build. Fix: the parent computes its extra
# sys.path entries with extra_sys_path_for_worker() below and writes them into
# the worker's config JSON under "sys_path"; each worker inserts them (see the
# `sys.path.insert(0, ...)` loop right after it reads `cfg["sys_path"]`) before
# importing anything that might live in one of them.
def _norm_path(path):
    return os.path.normcase(os.path.normpath(path)) if path else path


def _compute_extra_sys_path(current_path, baseline_path, own_dir):
    """Pure diff, split out for testing: entries in `current_path` that are
    not in `baseline_path` and are not `own_dir` (each worker already adds
    its own script directory itself — see e.g. lnm_worker.py:68). Order-
    preserving, de-duplicated."""
    baseline_norm = {_norm_path(p) for p in baseline_path if p}
    own_norm = _norm_path(own_dir) if own_dir else None
    extra = []
    seen = set()
    for p in current_path:
        if not p:
            continue
        n = _norm_path(p)
        if n in baseline_norm or n == own_norm or n in seen:
            continue
        seen.add(n)
        extra.append(p)
    return extra


_baseline_sys_path_cache = None


def _baseline_sys_path():
    """sys.path of a FRESH, bootstrap-free child of this same interpreter —
    exactly what a worker subprocess starts with on its own (stdlib plus
    whatever the interpreter's own `._pth`/site config bakes in, e.g. the
    `site-packages` line assemble-bundle.ps1 patches into the embeddable
    Python's `._pth`). Cached for the life of the parent process: sys.path
    doesn't change at runtime, and this avoids a subprocess spawn per request.
    """
    global _baseline_sys_path_cache
    if _baseline_sys_path_cache is None:
        try:
            out = subprocess.run(
                [sys.executable, "-c", "import sys, json; print(json.dumps(sys.path))"],
                capture_output=True, text=True, timeout=30, check=True,
            )
            _baseline_sys_path_cache = json.loads(out.stdout)
        except Exception:  # noqa: BLE001 — must never block a worker spawn
            _baseline_sys_path_cache = list(sys.path)
    return _baseline_sys_path_cache


def extra_sys_path_for_worker():
    """sys.path entries this (parent) process has that a freshly-spawned
    worker subprocess would NOT have on its own. Derived from the live
    sys.path (via `_baseline_sys_path`) rather than hardcoded stack names, so
    it stays correct for any future optional stack without this module
    needing to know about it. Conservative: excludes the worker's own script
    directory (each worker already inserts that itself) plus anything a
    plain interpreter already has (stdlib, default site-packages). Returns []
    in dev, where a normal venv already puts everything on the default
    path — dev is byte-for-byte unaffected."""
    own_dir = str(Path(__file__).resolve().parent)
    return _compute_extra_sys_path(sys.path, _baseline_sys_path(), own_dir)


# ── Vendored `nilearn.image.resample_to_img` ────────────────────────────────
# Phase 1b: `nilearn` was pulled into the core install for exactly ONE symbol,
# `resample_to_img`, and it hard-requires pandas + scikit-learn — 127 MB of
# wheels for one 60-line function. The port below is a faithful, line-for-line
# reimplementation of nilearn 0.12's `resample_to_img` -> `resample_img` path
# on top of `scipy.ndimage.affine_transform` + `nibabel`, restricted to the
# behaviour the callers actually use (3D/4D source, 3D target grid, no
# clipping, fill 0).
#
# Fidelity notes — every one of these is load-bearing for bit-identical output
# and was confirmed by backend/tests/test_resample_parity.py:
#
#   * `scipy.linalg.inv` (NOT `numpy.linalg.inv`) for the source-affine
#     inverse: the two disagree in the last ULP on some affines, and that
#     propagates into voxel-centre coordinates and flips nearest-neighbour
#     ties.
#   * `A = np.diag(A)` when A is diagonal: scipy dispatches a 1-D matrix to
#     `zoom_shift` and a 2-D one to the general geometric transform, which are
#     not bitwise equal.
#   * dtype: preserved, except signed-int + 'continuous' which nilearn casts
#     to the same-width float (int16 -> float32, not float16).
#   * int64/uint64 output is downcast to int32 when it fits, and bool -> uint8
#     — nilearn's `new_img_like` does this, and callers see the dtype.
#   * degenerate case (same affine within `allclose` AND same 3D shape) is a
#     passthrough, matching nilearn's `_resampling_not_needed`.
#
# Deliberate divergence: nilearn extrapolates NaN/inf out of the data before
# resampling (via `nilearn.masking.extrapolate_out_mask`) and restores the NaN
# mask afterwards. No call site here ever passes non-finite data (lesion
# masks, integer atlases, integer density maps), so that path is not ported;
# a non-finite input raises instead of silently taking a different code path.
#
# `force_resample` is accepted and ignored: it selected nilearn's
# pure-translation "padding optimization", which nilearn itself is retiring in
# 0.13 (`force_resample=True` becomes the default) because that shortcut
# mis-places data whenever the source extends past the target origin. This
# port always takes the real resampling path.
_INTERPOLATION_ORDER = {"continuous": 3, "linear": 1, "nearest": 0}


class BoundingBoxError(ValueError):
    """Target grid's field of view contains none of the source data."""


def _to_matrix_vector(transform):
    """Split a homogeneous 4x4 transform into its 3x3 matrix and 3-vector."""
    ndimin = transform.shape[0] - 1
    ndimout = transform.shape[1] - 1
    return transform[0:ndimin, 0:ndimout], transform[0:ndimin, ndimout]


def _get_bounds(shape, affine):
    """World-space bounds of the corner-voxel CENTRES of `shape` under
    `affine`. Only used for the empty-field-of-view check."""
    adim, bdim, cdim = shape
    adim -= 1
    bdim -= 1
    cdim -= 1
    box = np.array([
        [0.0, 0, 0, 1], [adim, 0, 0, 1], [0, bdim, 0, 1], [0, 0, cdim, 1],
        [adim, bdim, 0, 1], [adim, 0, cdim, 1], [0, bdim, cdim, 1],
        [adim, bdim, cdim, 1],
    ]).T
    box = np.dot(affine, box)[:3]
    return list(zip(box.min(axis=-1), box.max(axis=-1)))


def _new_img_like(ref_img, data, affine, copy_header=False):
    """Local port of `nilearn.image.new_img_like` for the NIfTI case."""
    if data.dtype == bool:
        data = data.astype(np.uint8)
    if data.dtype in (np.dtype(np.int64), np.dtype(np.uint64)) and data.size:
        info = np.iinfo(np.int32)
        if info.min <= data.min() and data.max() <= info.max:
            data = data.astype("int32")
    header = None
    if copy_header and ref_img.header is not None:
        header = ref_img.header.copy()
        try:
            "something" in header  # noqa: B015 — probes dict-like headers
        except TypeError:
            pass
        else:
            if "scl_slope" in header:
                header["scl_slope"] = 0.0
            if "scl_inter" in header:
                header["scl_inter"] = 0.0
            if "glmax" in header:
                header["glmax"] = 0.0
            if "cal_max" in header:
                header["cal_max"] = np.max(data) if data.size > 0 else 0.0
            if "cal_min" in header:
                header["cal_min"] = np.min(data) if data.size > 0 else 0.0
    klass = ref_img.__class__
    if klass is nib.Nifti1Pair:
        # Nifti1Pair has no to_filename; nilearn promotes it the same way.
        klass = nib.Nifti1Image
    return klass(data, affine, header=header)


def resample_to_img(source_img, target_img, interpolation="continuous",
                    fill_value=0, clip=False, order="F", copy=True,
                    copy_header=False, force_resample=None):
    """Resample `source_img` onto `target_img`'s voxel grid.

    Drop-in replacement for `nilearn.image.resample_to_img` for 3D/4D NIfTI
    inputs. No registration is performed — the images must already be aligned
    in world space.

    interpolation : "nearest" (order 0), "linear" (order 1) or "continuous"
                    (order 3, the default, matching nilearn).
    fill_value    : value for target voxels falling outside the source FOV.
    clip          : clamp the output into [min(source, 0), max(source, 0)].
    order         : memory layout of the output array ("F" like nilearn).
    copy / force_resample : accepted for signature compatibility; ignored
                    (this implementation never aliases the source data and
                    always takes the real resampling path).
    """
    from scipy import linalg
    from scipy.ndimage import affine_transform

    if interpolation not in _INTERPOLATION_ORDER:
        raise ValueError(
            f"interpolation must be one of {tuple(_INTERPOLATION_ORDER)}.\n"
            f" Got '{interpolation}' instead.")

    affine = np.asarray(source_img.affine)
    source_shape = source_img.shape
    target_affine = np.asarray(target_img.affine)
    # A 4D target only contributes its 3D grid (nilearn does the same).
    target_shape = tuple(int(s) for s in target_img.shape[:3])

    # ── Degenerate case: already on the target grid → passthrough ───────────
    if (np.array_equal(np.asarray(target_shape), np.asarray(source_shape[:3]))
            and np.allclose(target_affine, affine)):
        return source_img

    data = np.asanyarray(source_img.dataobj)
    if data.dtype.kind == "f" and not np.all(np.isfinite(data)):
        raise ValueError(
            "resample_to_img: non-finite values (NaN/inf) in the source image. "
            "The vendored resampler does not implement nilearn's out-of-mask "
            "extrapolation for them.")

    # Empty-field-of-view check, identical to nilearn's.
    bounds = _get_bounds(data.shape[:3],
                         np.linalg.inv(target_affine).dot(affine))
    if bounds[0][1] < 0 or bounds[1][1] < 0 or bounds[2][1] < 0:
        raise BoundingBoxError("The field of view given by the target affine "
                               "does not contain any of the data")

    if np.all(target_affine == affine):
        # More numerically stable than inv(affine) @ affine.
        transform_affine = np.eye(4)
    else:
        transform_affine = np.dot(linalg.inv(affine), target_affine)
    A, b = _to_matrix_vector(transform_affine)

    resampled_dtype = data.dtype
    if interpolation == "continuous" and data.dtype.kind == "i":
        aux = data.dtype.name.replace("int", "float")
        aux = aux.replace("ufloat", "float").replace("floatc", "float")
        if aux in ("float8", "float16"):
            aux = "float32"
        resampled_dtype = np.dtype(aux)

    # A diagonal matrix passed as 1-D lets scipy pick its faster (and
    # numerically distinct) zoom_shift path — nilearn relies on this.
    if np.all(np.diag(np.diag(A)) == A):
        A = np.diag(A)

    other_shape = list(data.shape[3:])
    resampled_data = np.zeros(list(target_shape) + other_shape,
                              order=order, dtype=resampled_dtype)
    all_img = (slice(None),) * 3
    # The interpolation is separable in the trailing dimensions, so a 4D
    # source is resampled one 3D volume at a time.
    for ind in np.ndindex(*other_shape):
        affine_transform(
            data[all_img + ind], A, offset=b, output_shape=target_shape,
            output=resampled_data[all_img + ind], cval=fill_value,
            order=_INTERPOLATION_ORDER[interpolation],
        )

    if clip:
        vmin = min(data.min(), 0) if data.size else 0
        vmax = max(data.max(), 0) if data.size else 0
        resampled_data.clip(vmin, vmax, out=resampled_data)

    return _new_img_like(source_img, resampled_data, target_affine,
                         copy_header=copy_header)


# Default atlas-overlap spec used by both dissect workers when the caller
# doesn't specify one. Paths follow the canonical atlas layout
# (<id>/<id>.nii.gz + <id>/<id>.labels.json); deps._atlas_specs_for() builds
# the same shape from the registry for any other atlas. The "ho_cort" key is
# the pre-revamp id and is what result["atlas_overlap"] is keyed by, which
# frontend/src/lib/htmlReport.js renders by name.
DEFAULT_ATLAS_SPECS = [
    {"key": "ho_cort", "nii": "harvard_oxford_cort/harvard_oxford_cort.nii.gz",
     "labels": "harvard_oxford_cort/harvard_oxford_cort.labels.json"},
]


def make_set_status(status_path):
    """Return a set_status(stage, progress, message) that atomically overwrites
    status_path with the current job stage, or a no-op when status_path is
    falsy. Writes to a temp file + os.replace so a concurrent reader (the
    parent's /status endpoint) never sees a partial file."""
    if not status_path:
        return lambda *a, **k: None

    def set_status(stage, progress, message=""):
        payload = {"stage": stage, "progress": float(progress),
                   "message": message, "done": False, "error": None}
        try:
            d = os.path.dirname(status_path) or "."
            fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
            with os.fdopen(fd, "w") as f:
                json.dump(payload, f)
            os.replace(tmp, status_path)
        except Exception:  # noqa: BLE001 — progress reporting must never crash the worker
            pass

    return set_status


def ho_overlap(atlas_dir, dm_img, dm_data, atlas_nii_name, atlas_labels_name):
    """Harvard-Oxford-style single-label-per-voxel atlas overlap: for each
    labelled region, how many of the density map's nonzero voxels fall in it."""
    atlas_path = atlas_dir / atlas_nii_name
    labels_path = atlas_dir / atlas_labels_name
    if not atlas_path.exists() or not labels_path.exists():
        return []

    atlas_img = nib.load(str(atlas_path))
    # force_resample is accepted and ignored by the vendored resampler, which
    # always takes the real resampling path. Kept explicit so the call reads the
    # same as the nilearn-era one it replaced, where the flag was load-bearing:
    # False mis-placed data on same-zoom grids (80.2% of voxels wrong, measured).
    atlas_r = resample_to_img(atlas_img, dm_img, interpolation='nearest',
                               copy_header=False, force_resample=True)
    a = np.asarray(atlas_r.dataobj, dtype=int)

    labels = atlas_labels.name_map(atlas_labels.read_labels_or_empty(labels_path))

    rows = []
    dm_nonzero = dm_data > 0
    for label_id, region_name in labels.items():
        region_mask = (a == label_id)
        hit_voxels = int(np.sum(region_mask & dm_nonzero))
        if hit_voxels == 0:
            continue
        region_voxels = int(np.sum(region_mask))
        rows.append({
            "label":              label_id,
            "name":               region_name,
            "region_voxels":      region_voxels,
            "hit_voxels":         hit_voxels,
            "pct_region":         round(100 * hit_voxels / max(region_voxels, 1), 1),
            "streamline_density": int(dm_data[region_mask].sum()),
        })
    rows.sort(key=lambda r: r["hit_voxels"], reverse=True)
    return rows


def tracts4d_overlap(atlas_dir, dm_img, dm_data, atlas_nii_name, atlas_labels_name):
    """4D tractography-atlas overlap (e.g. HCP842): the atlas is a 4D stack of
    per-tract BINARY masks (one frame per tract), which overlap heavily.
    Instead of a single winner-take-all label, report EVERY tract the
    affected streamlines pass through: resample the density map into the
    atlas grid once, then AND it against each frame. A voxel may count
    toward multiple tracts (intended)."""
    atlas_path = atlas_dir / atlas_nii_name
    labels_path = atlas_dir / atlas_labels_name
    if not atlas_path.exists() or not labels_path.exists():
        return []
    atlas_img = nib.load(str(atlas_path))
    if atlas_img.ndim != 4:
        return []
    X, Y, Z, T = atlas_img.shape
    ref3d = nib.Nifti1Image(np.zeros((X, Y, Z), dtype=np.int16), atlas_img.affine)
    dens_img = resample_to_img(dm_img, ref3d, interpolation='nearest',
                                copy_header=False, force_resample=True)
    dens = np.asarray(dens_img.dataobj, dtype=int)
    dm_nonzero = dens > 0

    labels = atlas_labels.name_map(atlas_labels.read_labels_or_empty(labels_path))

    dataobj = atlas_img.dataobj
    rows = []
    for t in range(T):
        mask_t = np.asanyarray(dataobj[..., t]) > 0
        hit = mask_t & dm_nonzero
        hit_voxels = int(hit.sum())
        if hit_voxels == 0:
            continue
        region_voxels = int(mask_t.sum())
        label_id = t + 1
        rows.append({
            "label":              label_id,
            "name":               labels.get(label_id, f"Tract {label_id}"),
            "region_voxels":      region_voxels,
            "hit_voxels":         hit_voxels,
            "pct_region":         round(100 * hit_voxels / max(region_voxels, 1), 1),
            "streamline_density": int(dens[hit].sum()),
        })
    rows.sort(key=lambda r: r["hit_voxels"], reverse=True)
    return rows


def overlap_for(atlas_dir, spec, dm_img, dm_data):
    """Dispatch to ho_overlap or tracts4d_overlap based on spec["mode"]."""
    if spec.get("mode") == "tracts4d":
        return tracts4d_overlap(atlas_dir, dm_img, dm_data, spec["nii"], spec["labels"])
    return ho_overlap(atlas_dir, dm_img, dm_data, spec["nii"], spec["labels"])


def dissection_metrics(dm, ref_affine):
    """affected_voxels / density_max / tract_volume_cm3 from a density map.
    Identical in dissect_worker.py and dissect_between_worker.py."""
    affected_voxels = int(np.sum(dm > 0))
    density_max = int(dm.max())
    voxel_vol_mm3 = float(np.prod(np.abs(np.diag(ref_affine[:3, :3]))))
    tract_vol_cm3 = round(affected_voxels * voxel_vol_mm3 / 1000, 3)
    return affected_voxels, density_max, tract_vol_cm3


# ── Sub-progress for the two slowest dissection phases ──────────────────────
# `load_tractogram` (DIPY, deserializes the whole .trk into streamline
# objects) and the lesion-mask resample step are single opaque calls with no
# callback hook — there's no way to get REAL interim progress out of them
# without patching DIPY itself. `monitored_stage` instead ticks set_status
# along an asymptotic curve on a background thread while the call runs on the
# main thread, so the bar visibly moves instead of sitting frozen at the
# stage's starting percentage for the many seconds these calls can take.
class _StageMonitor:
    """Context manager: on __enter__, sets the stage to `lo` and starts a
    daemon thread ticking progress toward (but never reaching) `hi` every
    ~0.4s along `lo + (hi-lo) * (1 - exp(-elapsed/expected_s))`. On a clean
    __exit__, stops the thread and snaps to exactly `hi` — so a wrong
    `expected_s` only affects how the bar looks mid-flight, never the stage
    boundary the frontend keys off of. On an exception, the thread is stopped
    without forcing `hi` (the caller's error path/set_status("error", ...) —
    if any — takes over instead)."""

    def __init__(self, set_status, stage, lo, hi, message, expected_s):
        self._set_status = set_status
        self._stage = stage
        self._lo = lo
        self._hi = hi
        self._message = message
        self._expected_s = max(float(expected_s), 0.5)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        t0 = time.monotonic()
        while not self._stop.wait(0.4):
            elapsed = time.monotonic() - t0
            frac = 1.0 - math.exp(-elapsed / self._expected_s)
            self._set_status(self._stage, self._lo + (self._hi - self._lo) * frac, self._message)

    def __enter__(self):
        self._set_status(self._stage, self._lo, self._message)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._stop.set()
        self._thread.join(timeout=1.0)
        if exc_type is None:
            self._set_status(self._stage, self._hi, self._message)
        return False


def monitored_stage(set_status, stage, lo, hi, message, expected_s):
    """with monitored_stage(set_status, "load", 0.0, 0.45, "Loading tractogram…", expected_s=8.0):
        sft = load_tractogram(...)
    `expected_s` is a rough duration estimate (seeded from e.g. tractogram
    file size) — it only shapes the asymptotic curve, it never caps how long
    the `with` block may actually run."""
    return _StageMonitor(set_status, stage, lo, hi, message, expected_s)


def target_filtered_with_progress(streamlines, affine, mask, set_status, stage,
                                   lo, hi, message_prefix, n_chunks=25):
    """Chunked equivalent of `list(target(streamlines, affine, mask,
    include=True))` (DIPY's per-streamline inclusion filter) that reports real
    progress via set_status as each chunk completes.

    Result is IDENTICAL to the unchunked call: target() tests each streamline
    independently (order-independent, no cross-streamline state), and chunks
    are sliced off `streamlines` in order and concatenated in the same order —
    so this is a pure progress-reporting refactor, not a behavior change.
    """
    from dipy.tracking.utils import target  # local: dipy is a heavy, worker-only dep

    total = len(streamlines)
    selected = []
    if total == 0:
        return selected
    chunk_size = max(1, -(-total // n_chunks))  # ceil(total / n_chunks)
    done = 0
    for start in range(0, total, chunk_size):
        chunk = streamlines[start:start + chunk_size]
        selected.extend(target(chunk, affine, mask, include=True))
        done = min(start + chunk_size, total)
        frac = done / total
        set_status(stage, lo + (hi - lo) * frac, f"{message_prefix} {done:,}/{total:,}…")
    return selected


# ── Cross-request atlas caching ──────────────────────────────────────────────
# Workers are spawned fresh per request (asyncio.create_subprocess_exec), so an
# in-process cache alone never helps across requests — but nib.load() itself is
# cheap for atlases (small files, and NiBabel lazy-loads .nii/.nii.gz via an
# ArrayProxy). The real per-request cost this doesn't touch is the 673 MB
# global tractogram (DIPY's load_tractogram fully deserializes TRK streamline
# data — not a flat array, so it isn't mmap-able the way a plain .npy is) and
# the 131 MB LNM connectome bundle. A real fix for either needs a persistent
# worker pool (workers stop being spawned per-request) or a one-time conversion
# to an mmap-friendly on-disk format consumed by every subsequent request —
# both are bigger architectural changes than this pass's scope. Left open.
