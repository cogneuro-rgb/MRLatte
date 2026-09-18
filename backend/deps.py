from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from starlette.datastructures import UploadFile as StarletteUploadFile
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
import asyncio
import json
import os
import re as _re
import sys
import shutil
import tempfile
import subprocess
import time
import zipfile
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional
import uuid
from datetime import datetime, timezone

from worker_common import extra_sys_path_for_worker
import lesion_metrics


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Pre-existing latent bug: several except-blocks below (dissection/LNM
# best-effort catches, the summary-job error/cancel handlers) call
# logger.warning/.exception/.info, but `logger` was never defined in this
# module (only in server.py) — any of those paths would raise a NameError
# instead of logging, silently swallowing the real exception. Define it here.
logger = logging.getLogger(__name__)


# === Repo root anchor =========================================================
# Everything that used to spell the repo root as `ROOT_DIR.parent` assumed
# backend/ sits directly under the repo root. If backend/ ever moves deeper
# (it briefly did, nested under a src/ wrapper), `ROOT_DIR.parent` would resolve one
# level too high — silently, with no exception, flipping every module to
# `missing` and every capability to false. Anchor on a real marker instead, so
# the root is correct regardless of how deeply nested backend/ is.

def _find_repo_root(start: Path) -> Path:
    for p in (start, *start.parents):
        if (p / 'modules' / 'manifest.json').exists() or (p / '.git').exists():
            return p
    return start.parent          # last resort; preserves today's behaviour


REPO_ROOT = _find_repo_root(ROOT_DIR)


# === Module root ==============================================================
# Every large data asset (tractogram, connectome bundle, atlases) resolves under
# ONE root instead of five unrelated repo-relative defaults. Each asset keeps its
# own env var as a per-path override, so existing deployments (deploy/Dockerfile,
# deploy/docker-compose*.yml, frontend/public/electron.js) can point them
# individually.
#
# The assets now physically live under the module root — there is no longer any
# "legacy" pre-module-root location to fall back to, so module_path()/slot_path()
# resolve env override > module root, and nothing else.

def _default_module_root() -> Path:
    """Module root used when MRLATTE_MODULE_ROOT is unset.

      * git checkout -> <repo>/data/modules   (dev; payload gitignored)
      * Windows      -> %LOCALAPPDATA%\\MRLatte\\modules
      * POSIX        -> ~/.local/share/MRLatte/modules
    """
    repo_root = REPO_ROOT
    # .git is a directory in a normal clone and a file in a worktree/submodule.
    if (repo_root / '.git').exists():
        return repo_root / 'data' / 'modules'
    if os.name == 'nt':
        local = os.environ.get('LOCALAPPDATA') or str(Path.home() / 'AppData' / 'Local')
        return Path(local) / 'MRLatte' / 'modules'
    return Path.home() / '.local' / 'share' / 'MRLatte' / 'modules'


MODULE_ROOT = Path(os.environ.get('MRLATTE_MODULE_ROOT', str(_default_module_root())))


def _registered_slot_path(slot_rel):
    """Path recorded by a `link`-mode slot install, or None.

    The Module Store can register a file where it already sits instead of
    copying hundreds of MB into the module root. That registration lives in the
    install ledger (MODULE_ROOT/manifest.installed.json), which is read here
    directly rather than through routers/modules.py — deps must not import a
    router. Records are matched on `slotRel` so this needs no module id.

    Never raises: an absent or malformed ledger is the normal case on every
    machine that has not used the Store.
    """
    try:
        raw = json.loads(
            (MODULE_ROOT / 'manifest.installed.json').read_text(encoding='utf-8'))
        entries = raw.get('modules') if isinstance(raw, dict) else raw
        records = entries.values() if isinstance(entries, dict) else (entries or [])
        for rec in records:
            if not isinstance(rec, dict) or rec.get('slotRel') != slot_rel:
                continue
            p = rec.get('slotPath')
            if p and Path(p).is_file():
                return Path(p)
    except Exception:  # noqa: BLE001 — resolution must never break import
        pass
    return None


def slot_path(slot_rel, extensions, validator, env_var=None) -> Path:
    """Resolve a user-supplied "slot" asset: env override > registered path >
    slot directory.

    Unlike module_path(), which points at one known filename, a slot is a
    DIRECTORY whose contents are validated structurally — the user drops in any
    conforming file under any name. Used for the two assets that are neither
    fixed nor redistributable: the whole-brain tractogram and the DA-LNM bundle.

    Always returns a Path so every existing `.exists()` check and worker
    argument keeps working unchanged. When the slot holds nothing valid, the
    returned path simply does not exist; module_slots.scan_slot() is what
    distinguishes "empty" from "present but broken" for the /api/modules report.
    """
    if env_var and os.environ.get(env_var):
        return Path(os.environ[env_var])   # explicit override still wins
    registered = _registered_slot_path(slot_rel)
    if registered is not None:
        return registered
    try:
        from module_slots import scan_slot
        found, _state, _reason, _details = scan_slot(
            MODULE_ROOT / slot_rel, extensions, validator)
        if found is not None:
            return found
    except Exception:  # noqa: BLE001 — resolution must never break import
        pass
    return MODULE_ROOT / slot_rel


class SlotRef(os.PathLike):
    """A slot asset resolved on ACCESS rather than at import.

    These used to be plain module-level Paths, which froze whatever the slot
    directory held when the process started: dropping a tractogram in while the
    server ran flipped the capability on in /api/modules (which rescans live)
    while every worker still resolved to the stale path, so the feature looked
    enabled and then failed. Re-resolving per access is what lets a file added
    mid-session be picked up without a restart.

    `from deps import *` binds these by VALUE into each router, so a reassigned
    module attribute would never reach them — the indirection has to live inside
    the object, not in a rebindable name.

    Supports the only operations the call sites use: `.exists()`, `str()` and
    os.fspath(). Resolution is memoised against the env override and the slot
    directory's mtime, so a per-request `.exists()` does not re-validate a
    700 MB tractogram on every call.
    """

    __slots__ = ("_rel", "_exts", "_validator", "_env_var", "_cache")

    def __init__(self, slot_rel, extensions, validator, env_var=None):
        self._rel = slot_rel
        self._exts = extensions
        self._validator = validator
        self._env_var = env_var
        self._cache = None

    def _key(self):
        env = os.environ.get(self._env_var) if self._env_var else None
        try:
            mtime = (MODULE_ROOT / self._rel).stat().st_mtime_ns
        except OSError:
            mtime = None
        # The ledger is part of the key: a link-mode install changes resolution
        # without touching the slot directory at all.
        try:
            ledger_mtime = (MODULE_ROOT / 'manifest.installed.json').stat().st_mtime_ns
        except OSError:
            ledger_mtime = None
        return (env, mtime, ledger_mtime)

    def resolve(self) -> Path:
        key = self._key()
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        path = slot_path(self._rel, self._exts, self._validator, self._env_var)
        self._cache = (key, path)
        return path

    def exists(self) -> bool:
        """True only for an actual FILE.

        `slot_path` falls back to the slot DIRECTORY when nothing valid is
        present, and a bare `.exists()` on that is true — which would send a
        directory to a worker expecting a tractogram. Every call site means
        "is the asset configured", so that is what this answers.
        """
        return self.resolve().is_file()

    def __str__(self) -> str:
        return str(self.resolve())

    def __fspath__(self) -> str:
        return str(self.resolve())

    def __repr__(self) -> str:
        return f"SlotRef({self._rel!r} -> {self.resolve()})"


def module_path(rel, env_var=None) -> Path:
    """Resolve one asset: explicit env override > module root.

    The asset lives at MODULE_ROOT/rel; an explicit per-asset env var (ATLAS_DIR,
    …) overrides that. There is no repo-relative fallback anymore — the assets
    were relocated under the module root, so a stale pre-move location would only
    hide a genuinely missing install.
    """
    if env_var and os.environ.get(env_var):
        return Path(os.environ[env_var])   # explicit override still wins
    return MODULE_ROOT / rel


# Where the built frontend lives (served as static at '/'), overridable via env
# for containerized deploys. NOT a module asset — it is a build output.
STATIC_DIR = Path(os.environ.get('STATIC_DIR', str(REPO_ROOT / 'frontend' / 'build')))
# Slot, not a fixed file: ANY whole-brain tractogram registered to MNI works for
# dissection — it need not be S35_1mm.trk. Drop a .trk into MODULE_ROOT/tracts/
# and it is picked up. (.tck is rejected by the validator: it carries no
# reference grid, and dissect_worker loads with reference='same'.)
GLOBAL_TRACT_FILE = SlotRef(
    'tracts', {'.trk'}, 'tractogram', 'GLOBAL_TRACT_FILE',
)
TRACT_RESULTS_DIR = Path(os.environ.get(
    'TRACT_RESULTS_DIR', str(ROOT_DIR / 'tract_results')
))
TRACT_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
WORKER_SCRIPT = ROOT_DIR / "dissect_worker.py"
DISSECT_BETWEEN_WORKER_SCRIPT = ROOT_DIR / "dissect_between_worker.py"
ROI_RESULTS_DIR = Path(os.environ.get(
    'ROI_RESULTS_DIR', str(ROOT_DIR / 'roi_results')
))
ROI_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
DICOM_RESULTS_DIR = Path(os.environ.get(
    'DICOM_RESULTS_DIR', str(ROOT_DIR / 'dicom_results')
))
DICOM_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
# DaLn mapper (lesion network mapping): compact connectome bundle + worker.
LNM_WORKER_SCRIPT = ROOT_DIR / "lnm_worker.py"
# Slot, not a fixed file: the bundle is user-supplied (HCP Data Use Terms bar us
# from shipping it) and may legitimately be a rebuild on a different substrate —
# DA-LNM_Methods names GSP1000 as the alternative where HCP terms are
# impractical. Drop any conforming .npz into MODULE_ROOT/lnm/.
LNM_BUNDLE = SlotRef(
    'lnm', {'.npz'}, 'lnm-bundle', 'LNM_BUNDLE',
)
LNM_RESULTS_DIR = Path(os.environ.get(
    'LNM_RESULTS_DIR', str(ROOT_DIR / 'lnm_results')
))
LNM_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
# One-Click Summary: orchestrates dissection + LNM + retinotopy into one ZIP.
SUMMARY_RENDER_WORKER_SCRIPT = ROOT_DIR / "summary_render_worker.py"
SUMMARY_RESULTS_DIR = Path(os.environ.get(
    'SUMMARY_RESULTS_DIR', str(ROOT_DIR / 'summary_results')
))
SUMMARY_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

# Per-job status directories for the pollable Tract Dissection / LNM jobs
# (progress-bar refactor). status.json lives here keyed by job_id, while the
# heavy result files keep living under TRACT_RESULTS_DIR / LNM_RESULTS_DIR keyed
# by result_id — the two ids are distinct so the dirs never collide.
DISSECT_JOBS_DIR = Path(os.environ.get(
    'DISSECT_JOBS_DIR', str(ROOT_DIR / 'dissect_jobs')
))
DISSECT_JOBS_DIR.mkdir(parents=True, exist_ok=True)
LNM_JOBS_DIR = Path(os.environ.get(
    'LNM_JOBS_DIR', str(ROOT_DIR / 'lnm_jobs')
))
LNM_JOBS_DIR.mkdir(parents=True, exist_ok=True)

# Content-addressed lesion-upload storage for the lqtpy-backed lesion-metrics
# endpoint (routers/lesion_metrics.py). Deliberately NOT mkdir()'d here unlike
# the job dirs above — it holds patient lesion scans, and every other
# *_jobs/*_results dir before it mkdir's unconditionally at import time, which
# means `python -c "import deps"` (a test, a lint, an editor) silently creates
# it too. Harmless for the others; here it's one more surface a privacy audit
# has to notice. The router creates it lazily on first upload instead.
LESION_JOBS_DIR = Path(os.environ.get(
    'LESION_JOBS_DIR', str(ROOT_DIR / 'lesion_jobs')
))

# UUID4 regex used for path-traversal-safe result_id validation.
_UUID4_RE = _re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')


def save_upload_nifti(upload_file, workdir, stem=None, fallback="lesion"):
    """Save an uploaded NIfTI into *workdir*, choosing the .nii vs .nii.gz
    extension from the file's ACTUAL first two bytes (0x1f 0x8b == gzip magic)
    rather than the client-supplied filename.

    NiiVue sniffs content, so the viewer loads a raw NIfTI that was mis-named
    .nii.gz just fine; nibabel trusts the extension and raises
    'is not a gzip file'. Sniffing here keeps the analysis backend as lenient
    as the viewer (and also fixes the reverse case: gzipped bytes named .nii).
    Returns the saved Path.
    """
    if stem is None:
        base = os.path.basename(getattr(upload_file, "filename", None) or fallback)
        bl = base.lower()
        stem = base[:-7] if bl.endswith(".nii.gz") else base[:-4] if bl.endswith(".nii") else base
    head = upload_file.file.read(2)
    upload_file.file.seek(0)
    ext = ".nii.gz" if head[:2] == b"\x1f\x8b" else ".nii"
    dest = Path(workdir) / f"{stem}{ext}"
    with open(dest, "wb") as dst:
        shutil.copyfileobj(upload_file.file, dst)
    return dest


def cleanup_old_tract_results(max_age_hours: int = 24) -> None:
    """Remove tract result subdirs older than max_age_hours.

    MUST NOT be called at import time. This permanently deletes user data
    (shutil.rmtree does not use the Recycle Bin), and importing a module is
    something tests, tooling and editors do freely — a `python -c "import
    server"` used to silently destroy every dissection result older than a day.
    It is now invoked once from server.py's lifespan, i.e. only when a real
    server actually starts, which was always the intent.
    """
    import time
    cutoff = time.time() - max_age_hours * 3600
    for subdir in TRACT_RESULTS_DIR.iterdir():
        if subdir.is_dir() and subdir.stat().st_mtime < cutoff:
            shutil.rmtree(subdir, ignore_errors=True)


# Backwards-compatible alias; the leading underscore implied "internal", which
# is how it ended up being called from module scope in the first place.
_cleanup_old_tract_results = cleanup_old_tract_results


# Add your routes to the router instead of directly to app




# Path to the Electron-built Windows desktop artefact. Built via:
#   cd frontend && yarn dist:win
# Env-overridable: `yarn dist:win` now writes outside the repo (see
# MRLATTE_BUILD_DIR / tools/build), so the launcher can point this at the real
# output location. Dev default is the in-tree electron-builder output.
DESKTOP_ARTIFACTS_DIR = Path(os.environ.get(
    'DESKTOP_ARTIFACTS_DIR', str(REPO_ROOT / 'frontend' / 'dist-electron')
))






# === Benson / Wang regeneration validation artefacts ===
# These are small pre-rendered figures checked into the repo under
# tools/scripts/ (they moved there with scripts/). They are NOT module payload —
# they ship with the source — so they resolve to a plain repo-relative default
# rather than through the module root. Overridable via env so the launcher can
# point them at the installed location.
VALIDATION_DIR = Path(os.environ.get(
    'VALIDATION_DIR', str(REPO_ROOT / 'tools' / 'scripts' / 'validation_plots')
))
VALIDATION_REPORT = Path(os.environ.get(
    'VALIDATION_REPORT', str(REPO_ROOT / 'tools' / 'scripts' / 'benson_validation_report.txt')
))








# === Atlas quantitative verification checks ===
ATLAS_DIR = module_path("atlases", "ATLAS_DIR")

_ATLAS_SPECS = [
    # Paths are relative to ATLAS_DIR and now carry a per-atlas-family subfolder.
    {"name": "Benson 2014 — Polar Angle",       "file": "benson14/benson14_polar_angle.nii.gz",  "vmin": 0.0,  "vmax": 360.0, "labels": None},
    {"name": "Benson 2014 — Eccentricity",       "file": "benson14/benson14_eccentricity.nii.gz", "vmin": 0.0,  "vmax": 90.0,  "labels": None},
    {"name": "Benson 2014 — Visual Areas",       "file": "benson14/benson14_visual_areas.nii.gz", "vmin": 1.0,  "vmax": 12.0,  "labels": list(range(1, 13))},
    {"name": "Wang 2015 — Max-probability ROIs", "file": "wang2015/wang2015_maxprob.nii.gz",      "vmin": 1.0,  "vmax": 25.0,  "labels": list(range(1, 26))},
]


def _run_atlas_checks(atlas_dir: Path):
    import nibabel as nib
    import numpy as np

    results = []

    vc_path = atlas_dir / "misc" / "visual_areas_v1v5.nii.gz"
    if vc_path.exists():
        vc_data = np.asarray(nib.load(str(vc_path)).dataobj).astype(bool)
        vc_mask_sum = int(vc_data.sum())
    else:
        vc_data = None
        vc_mask_sum = 0

    for spec in _ATLAS_SPECS:
        file_path = atlas_dir / spec["file"]
        if not file_path.exists():
            missing = {"pass": False, "detail": "File not found"}
            results.append({
                "name": spec["name"], "file": spec["file"], "overall_pass": False,
                "checks": {"value_range": missing, "spatial_overlap": missing,
                            "label_completeness": missing, "hemisphere_balance": missing},
            })
            continue

        data = np.asarray(nib.load(str(file_path)).dataobj, dtype=np.float32)
        nonzero = data != 0

        # 1. Value range
        if nonzero.any():
            actual_min = float(data[nonzero].min())
            actual_max = float(data[nonzero].max())
        else:
            actual_min = actual_max = 0.0
        tol = (spec["vmax"] - spec["vmin"]) * 0.05
        range_pass = actual_min <= spec["vmin"] + tol and actual_max >= spec["vmax"] - tol
        range_check = {
            "pass": range_pass,
            "detail": f"{actual_min:.2f}–{actual_max:.2f} (expected {spec['vmin']:.0f}–{spec['vmax']:.0f})",
        }

        # 2. Spatial overlap with visual cortex mask
        if vc_data is not None and vc_mask_sum > 0 and nonzero.any():
            s = tuple(min(a, b) for a, b in zip(data.shape, vc_data.shape))
            a_crop = nonzero[:s[0], :s[1], :s[2]]
            v_crop = vc_data[:s[0], :s[1], :s[2]]
            v_sum = int(v_crop.sum())
            overlap_pct = int((a_crop & v_crop).sum()) / v_sum * 100 if v_sum else 0.0
            overlap_check = {
                "pass": overlap_pct >= 50.0,
                "detail": f"{overlap_pct:.1f}% overlap with visual cortex mask",
            }
        else:
            overlap_check = {"pass": False, "detail": "Visual cortex mask unavailable"}

        # 3. Label completeness
        if spec["labels"] is not None:
            present = set(np.round(data[nonzero]).astype(np.int32).tolist())
            missing_labels = [lb for lb in spec["labels"] if lb not in present]
            label_pass = len(missing_labels) == 0
            label_check = {
                "pass": label_pass,
                "detail": (f"All {len(spec['labels'])} labels present" if label_pass
                            else f"Missing {len(missing_labels)} label(s): {missing_labels[:5]}{'…' if len(missing_labels) > 5 else ''}"),
            }
        else:
            label_check = {"pass": True, "detail": "N/A – continuous map"}

        # 4. Hemisphere balance (split at mid-x axis)
        mid = data.shape[0] // 2
        lh = int(nonzero[:mid, :, :].sum())
        rh = int(nonzero[mid:, :, :].sum())
        total = lh + rh
        if total > 0:
            lh_pct = lh / total * 100
            rh_pct = rh / total * 100
            hemi_check = {
                "pass": min(lh_pct, rh_pct) >= 10.0,
                "detail": f"LH {lh_pct:.1f}%, RH {rh_pct:.1f}%",
            }
        else:
            hemi_check = {"pass": False, "detail": "No non-zero voxels found"}

        checks = {"value_range": range_check, "spatial_overlap": overlap_check,
                  "label_completeness": label_check, "hemisphere_balance": hemi_check}
        results.append({
            "name": spec["name"], "file": spec["file"],
            "overall_pass": all(c["pass"] for c in checks.values()),
            "checks": checks,
        })

    return {"atlases": results}






# === DICOM → NIfTI conversion (dcm2niix) ===
# Robust path for clinical DICOM (series / compressed transfer syntaxes).
# Requires the `dcm2niix` binary on PATH and `python-multipart` installed.


def _largest_nifti(directory: Path):
    cands = list(directory.glob("*.nii.gz")) + list(directory.glob("*.nii"))
    if not cands:
        return None
    return max(cands, key=lambda p: p.stat().st_size)




def _dicom_series_metadata(nii_path: Path) -> dict:
    """Build a series descriptor for a dcm2niix output. Reads the BIDS JSON
    sidecar (SeriesDescription) if present and the NIfTI header for dims."""
    series_id = nii_path.name[:-7] if nii_path.name.endswith(".nii.gz") else nii_path.stem
    description = series_id
    sidecar = nii_path.with_name(series_id + ".json")
    if sidecar.exists():
        try:
            meta = json.loads(sidecar.read_text())
            description = (meta.get("SeriesDescription")
                          or meta.get("ProtocolName") or series_id)
        except Exception:  # noqa: BLE001
            pass
    dims, n_slices = None, None
    try:
        import nibabel as nib
        hdr = nib.load(str(nii_path)).header
        shape = [int(x) for x in hdr.get_data_shape()]
        dims = shape
        n_slices = shape[2] if len(shape) >= 3 else None
    except Exception:  # noqa: BLE001
        pass
    return {
        "id": series_id,
        "name": nii_path.name,
        "description": description,
        "dims": dims,
        "n_slices": n_slices,
        "bytes": nii_path.stat().st_size,
    }






# === Longitudinal comparison (SimpleITK affine register + difference map) ===
# Registers a follow-up scan to a baseline, resamples it, and returns the
# voxel-wise difference (follow-up − baseline) as a signed NIfTI plus
# change metrics in response headers. Heavy/optional: requires SimpleITK.

from starlette.concurrency import run_in_threadpool


def _run_longitudinal(baseline_path: Path, followup_path: Path, out_path: Path):
    import SimpleITK as sitk
    import numpy as np

    fixed = sitk.ReadImage(str(baseline_path), sitk.sitkFloat32)
    moving = sitk.ReadImage(str(followup_path), sitk.sitkFloat32)

    same_grid = (
        fixed.GetSize() == moving.GetSize()
        and fixed.GetSpacing() == moving.GetSpacing()
    )
    if same_grid:
        resampled = moving
        metric = 0.0
    else:
        reg = sitk.ImageRegistrationMethod()
        reg.SetMetricAsMattesMutualInformation(numberOfHistogramBins=32)
        reg.SetMetricSamplingStrategy(reg.RANDOM)
        reg.SetMetricSamplingPercentage(0.1)
        reg.SetInterpolator(sitk.sitkLinear)
        reg.SetOptimizerAsRegularStepGradientDescent(2.0, 1e-4, 200)
        reg.SetOptimizerScalesFromPhysicalShift()
        init = sitk.CenteredTransformInitializer(
            fixed, moving, sitk.AffineTransform(3),
            sitk.CenteredTransformInitializerFilter.GEOMETRY,
        )
        reg.SetInitialTransform(init, inPlace=False)
        transform = reg.Execute(fixed, moving)
        metric = float(reg.GetMetricValue())
        resampled = sitk.Resample(
            moving, fixed, transform, sitk.sitkLinear, 0.0, sitk.sitkFloat32
        )

    a = sitk.GetArrayFromImage(fixed)
    b = sitk.GetArrayFromImage(resampled)
    diff = b - a
    diff_img = sitk.GetImageFromArray(diff)
    diff_img.CopyInformation(fixed)
    sitk.WriteImage(diff_img, str(out_path))

    rng = float(np.percentile(np.abs(a), 99)) or 1.0
    changed = float(np.count_nonzero(np.abs(diff) > 0.1 * rng))
    nonzero_base = float(np.count_nonzero(a > 0.05 * rng)) or 1.0
    return {
        "registration_metric": metric,
        "same_grid": same_grid,
        "changed_voxel_pct": round(100.0 * changed / nonzero_base, 2),
    }






# === Tractography subsampling (decimate large .tck/.trk for browser viewing) ===
# NiiVue parses tractograms entirely in the WebGL renderer, so multi-GB files
# exhaust the browser's contiguous-ArrayBuffer limit. This endpoint keeps a
# uniform random subset of streamlines server-side and streams back a much
# smaller file in the same format, which the renderer can handle.


def _run_tract_subsample(in_path: Path, out_path: Path, max_streamlines: int):
    import numpy as np
    import nibabel as nib

    tgm = nib.streamlines.load(str(in_path))
    sl = tgm.streamlines
    n = len(sl)
    if max_streamlines > 0 and n > max_streamlines:
        idx = np.sort(
            np.random.default_rng(0).choice(n, size=max_streamlines, replace=False)
        )
        sub = sl[idx]
        kept = int(max_streamlines)
    else:
        sub = sl
        kept = n
    new_tgm = nib.streamlines.Tractogram(
        sub, affine_to_rasmm=tgm.tractogram.affine_to_rasmm
    )
    # Format is inferred from out_path's extension; reuse the source header so
    # the subsampled file lands in the same space/orientation.
    nib.streamlines.save(new_tgm, str(out_path), header=tgm.header)
    return {"input_streamlines": int(n), "output_streamlines": int(kept)}






# === Lesion-based virtual tract dissection ====================================
# The heavy DIPY computation runs in dissect_worker.py via subprocess so that
# a segfault or OOM in DIPY's C extensions cannot crash uvicorn.




# Atlas specs driving the tract-dissection region breakdown.
#
# This used to be a hardcoded dict of three presets, which meant only three of
# the installed atlases could ever be used for a dissection breakdown and a
# user-imported one never could. It is now resolved from the atlas registry, so
# any installed atlas is a valid `atlas=` value.
#
# The `key` a spec carries becomes a key of result["atlas_overlap"], which
# frontend/src/lib/htmlReport.js renders by name — so it must stay stable
# across the rename. Every migrated atlas lists its pre-revamp id first in
# `aliases`, and that is what is used: harvard_oxford_cort -> "ho_cort",
# hcp1065_tracts -> "hcp1065", juelich (never renamed) -> "juelich".
DEFAULT_DISSECTION_ATLAS = "harvard_oxford_cort"


def _atlas_specs_for(atlas: str):
    """[{key, nii, labels, mode?}] for a dissection atlas id, alias, or name.

    `nii`/`labels` stay RELATIVE to the atlas root: the specs are serialised
    into the worker's job payload, and a worker resolves them against its own
    ATLAS_DIR rather than trusting an absolute path from another process.

    Unknown names fall back to Harvard-Oxford cortical, preserving the old
    behaviour of `_ATLAS_PRESETS.get(..., _ATLAS_PRESETS["harvard_oxford"])`.
    """
    import atlas_registry  # local: atlas_registry imports deps lazily

    wanted = (atlas or DEFAULT_DISSECTION_ATLAS).strip()
    d = atlas_registry.resolve(wanted) or atlas_registry.resolve(DEFAULT_DISSECTION_ATLAS)
    if d is None:
        return []

    spec = {
        "key": (d["aliases"][0] if d["aliases"] else d["id"]),
        "nii": "%s/%s" % (d["id"], d["volume"]),
        "labels": "%s/%s" % (d["id"], d["labels"]),
    }
    # A tract atlas that ships a 4-D per-bundle stack is reported bundle by
    # bundle (a voxel may belong to several), not winner-take-all.
    four_d = d.get("tracts4d")
    if four_d:
        spec["mode"] = "tracts4d"
        spec["nii"] = "%s/%s" % (d["id"], four_d)
    return [spec]


def dissection_atlas_options():
    """[{value, label}] for the dissection atlas picker."""
    import atlas_registry

    return [{"value": d["id"], "label": d["name"]} for d in atlas_registry.list_atlases()]








# ---- DaLn mapper (degree-corrected lesion network mapping) --------------------







# ---- One-Click Summary -------------------------------------------------------

def _summary_set_status(job_dir: Path, **fields):
    """Merge fields into the job's status.json (source of truth for polling)."""
    status_path = job_dir / "status.json"
    current = {}
    if status_path.exists():
        try:
            current = json.loads(status_path.read_text())
        except Exception:  # noqa: BLE001
            current = {}
    current.update(fields)
    status_path.write_text(json.dumps(current))


# ---- Summary job cancellation -------------------------------------------
# _run_worker_json runs in a threadpool (see below), so cancelling the asyncio
# Task alone does not stop the underlying OS process — the actual stop
# mechanism is terminate()ing the live subprocess.Popen, tracked here per job.
_SUMMARY_TASKS: dict = {}       # job_id -> asyncio.Task (for summary_run's caller)
_SUMMARY_PROCS: dict = {}       # job_id -> Popen (only set while a worker subprocess is live)
_SUMMARY_CANCEL_FLAGS: set = set()


class SummaryCancelled(Exception):
    """Raised internally when a summary job is cancelled mid-run."""


def request_summary_cancel(job_id: str) -> bool:
    """Mark a job cancelled and kill its currently-running worker subprocess,
    if any. Returns True if a live subprocess was found and signalled."""
    _SUMMARY_CANCEL_FLAGS.add(job_id)
    task = _SUMMARY_TASKS.get(job_id)
    if task and not task.done():
        task.cancel()
    proc = _SUMMARY_PROCS.get(job_id)
    if proc and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:  # noqa: BLE001
            pass
        return True
    return False


def _is_summary_cancelled(job_id: str) -> bool:
    return job_id in _SUMMARY_CANCEL_FLAGS


def _run_worker_json(script: Path, config: dict, workdir: Path, timeout: int, job_id: str = None):
    """Run a worker subprocess (isolated) and return its parsed JSON, or None.

    Popen (not subprocess.run) in a thread — never asyncio.create_subprocess_exec,
    which raises under uvicorn --reload on Windows. Using Popen (rather than the
    simpler subprocess.run) lets a live process be tracked in _SUMMARY_PROCS and
    terminate()d from request_summary_cancel while this call is blocked in
    communicate().
    """
    # Extra sys.path entries (e.g. the optional python-reports/python-validation
    # stacks in a full packaged build) the worker subprocess would not otherwise
    # see — see worker_common.extra_sys_path_for_worker for why PYTHONPATH can't
    # carry these across the subprocess boundary instead.
    config = dict(config)
    config["sys_path"] = extra_sys_path_for_worker()
    (workdir / "config.json").write_text(json.dumps(config))
    proc = subprocess.Popen(
        [sys.executable, str(script), str(workdir / "config.json")],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if job_id:
        if _is_summary_cancelled(job_id):
            proc.kill()
            proc.communicate()
            raise SummaryCancelled()
        _SUMMARY_PROCS[job_id] = proc
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise
    finally:
        if job_id:
            _SUMMARY_PROCS.pop(job_id, None)
    if proc.returncode != 0:
        if job_id and _is_summary_cancelled(job_id):
            raise SummaryCancelled()
        # Workers signal an EXPECTED, user-meaningful failure by printing a
        # structured {"error": "..."} line on stdout and exiting non-zero (see
        # lnm_worker.py's "Lesion does not overlap the connectome brain mask"
        # path and both dissect workers' MNI-space guards). Prefer that message.
        # Falling straight through to stderr surfaced whatever happened to be
        # the last thing written there — in practice a benign SciPy
        # `affine_transform` UserWarning from worker_common.py — so the UI
        # reported "Lesion network mapping failed: UserWarning: The behavior of
        # affine_transform ..." and the real, actionable reason was lost.
        try:
            parsed = json.loads(stdout.decode(errors="replace"))
        except (ValueError, UnicodeDecodeError):
            parsed = None
        if isinstance(parsed, dict) and parsed.get("error"):
            raise RuntimeError(str(parsed["error"]))
        err = stderr.decode(errors="replace")[-1000:]
        raise RuntimeError(err or f"worker exited {proc.returncode}")
    return json.loads(stdout.decode())


def _client_overlap_fallback(payload: dict, reason: str):
    """Fall back to a client-sent `overlapModel` (DEPRECATED -- see
    summary_run's docstring in routers/summary.py) when the lqtpy engine
    can't produce one itself. `reason` is logged and returned as the
    `overlap_reason` the job status carries, so a missing/greyed-out overlap
    section in the UI always has an explanation.

    Only called from the two fail-soft paths in _summary_overlap_stage
    (lqtpy absent, or compute_metrics raising a 503-class error) -- never for
    a 4xx-class caller error (bad lesion, unknown atlas), which must fail the
    job clearly instead of silently substituting client numbers.
    """
    client_model = payload.get("overlapModel")
    if not client_model:
        logger.info("summary overlap: skipped (%s)", reason)
        return None, reason
    logger.warning(
        "summary overlap: lqtpy unavailable (%s); falling back to the "
        "deprecated client-computed overlapModel field", reason)
    client_model = dict(client_model)
    # The client (lib/lesionReport.js's resolveLesionAtlasMetrics) already
    # stamps fallback/js provenance on this model when it computed it via the
    # JS engine -- these setdefaults only backstop an older/unexpected caller
    # that sent a bare model, so the provenance pill is never blank.
    prov = dict(client_model.get("provenance") or {})
    prov.setdefault("engine", "js")
    prov.setdefault("fallback", True)
    prov.setdefault("fallbackReason", reason)
    client_model["provenance"] = prov
    return client_model, reason


async def _summary_overlap_stage(lesion_path: Path, payload: dict, stages: dict,
                                  status, check_cancelled):
    """Compute the atlas-overlap model in-process via lqtpy
    (lesion_metrics.compute_metrics), before any dissect/LNM/render worker is
    dispatched. Replaces the old flow where the browser ran the JS voxel-loop
    engine (lib/lesionReport.js, no lesionFile => always the JS fallback path
    for this caller) and shipped the result to the backend in
    payload["overlapModel"] before the job could even start.

    Returns (overlap_model, overlap_reason). overlap_model is None only when
    overlap was skipped or unavailable with nothing to fall back to;
    overlap_reason explains why whenever overlap_model is None, or is a
    client-computed fallback.

    Fail-soft policy:
      * overlap stage disabled, or no lqtpy install -> not a job failure.
        Falls back to a client-sent `overlapModel` (deprecated) if present,
        else the job proceeds with no overlap section and the reason is
        recorded in the job result.
      * lqtpy raising a 503-class error (LqtpyUnavailableError, or any other
        exception lesion_metrics.status_code_for maps to 503) is treated the
        same as lqtpy being absent.
      * Any other error (a 4xx caller error such as an empty lesion, or an
        unexpected 500) is RE-RAISED -- this stage, and therefore the whole
        job, fails with a clear message instead of silently proceeding
        without overlap numbers.
    """
    if not stages.get("overlap", True):
        return None, "overlap stage disabled"

    requested_ids = list(payload.get("atlas_ids") or [])

    status("overlap", "Computing atlas overlap…", 0.055)
    check_cancelled()

    if not lesion_metrics.available():
        return _client_overlap_fallback(
            payload, "lqtpy is not installed in this backend environment")

    import atlas_registry
    t0 = time.monotonic()
    try:
        bridged = set(lesion_metrics.bridged_atlas_ids())
        supported = [a for a in requested_ids if a in bridged]
        atlas_names = {a: (atlas_registry.resolve(a) or {}).get("name", a)
                       for a in requested_ids}

        result = await run_in_threadpool(lesion_metrics.compute_metrics,
                                         lesion_path, supported)
    except lesion_metrics.LesionMetricsError as exc:
        if exc.status_code == 503:
            return _client_overlap_fallback(payload, str(exc))
        raise
    except Exception as exc:  # noqa: BLE001 -- lqtpy's own typed errors land here
        if lesion_metrics.status_code_for(exc) == 503:
            return _client_overlap_fallback(payload, str(exc))
        raise

    if payload.get("overlapModel") is not None:
        logger.info(
            "summary overlap: ignoring deprecated client-sent overlapModel "
            "field (lqtpy computed the overlap model server-side)")

    model = lesion_metrics.build_overlap_model(result, atlas_names)
    model["excludedAtlases"] = [
        {"id": a, "name": atlas_names.get(a, a),
         "reason": "not supported by the lqtpy engine (atlas kind can't be bridged)"}
        for a in requested_ids if a not in bridged
    ]
    duration_ms = (time.monotonic() - t0) * 1000.0
    logger.info("summary overlap: computed in-process atlas_ids=%s duration_ms=%.2f",
               supported, duration_ms)
    return model, None


async def _run_summary_job(job_id: str, lesion_path: Path, payload: dict):
    """Background orchestration: dissection + LNM + retinotopy render + ZIP."""
    job_dir = SUMMARY_RESULTS_DIR / job_id
    stages = payload.get("stages") or {}
    lesion_name = payload.get("name") or lesion_path.name

    def status(stage, message, progress):
        _summary_set_status(job_dir, stage=stage, message=message,
                            progress=progress, done=False, error=None)

    def check_cancelled():
        if _is_summary_cancelled(job_id):
            raise SummaryCancelled()

    # Item 105: One-Click Summary progress bar. Each sub-worker already knows how
    # to publish real 0..1 progress to a status file (worker_common.
    # make_set_status, driven by cfg["status_path"]) — that channel is what Tract
    # Dissection's and LNM's own progress bars consume. The summary orchestrator
    # used to leave status_path unset, so its bar sat frozen at 0.2 for the whole
    # dissection and 0.5 for the whole LNM. Give each stage its own status file
    # and mirror it into the summary's status.json, rescaled into that stage's
    # band of the overall bar. The band widths are proportional to measured stage
    # cost on the real bundle (dissection ~2min, LNM ~3min, render ~30s).
    async def run_stage(script, cfg, wdir, timeout, stage, lo, hi, fallback_msg):
        sub_status = wdir / "sub_status.json"
        task = asyncio.ensure_future(run_in_threadpool(
            _run_worker_json, script, {**cfg, "status_path": str(sub_status)},
            wdir, timeout, job_id))
        try:
            while not task.done():
                # Poll rather than await the task directly so the bar keeps
                # moving; the worker runs in a threadpool and cannot push.
                await asyncio.wait({task}, timeout=0.4)
                try:
                    sub = json.loads(sub_status.read_text())
                except Exception:  # noqa: BLE001 — file may be mid-write or absent
                    continue
                frac = min(1.0, max(0.0, float(sub.get("progress") or 0.0)))
                status(stage, sub.get("message") or fallback_msg,
                       round(lo + (hi - lo) * frac, 4))
        finally:
            if not task.done():
                task.cancel()
        return await task

    dissect_ref = None
    lnm_ref = None
    try:
        status("prepare", "Preparing inputs…", 0.05)
        check_cancelled()

        # ── Atlas overlap (in-process, lqtpy) ───────────────────────────────
        # Runs BEFORE any worker is dispatched -- this used to be a client-side
        # JS compute shipped to the backend in payload["overlapModel"] (several
        # seconds of blocked-main-thread voxel loops before the job could even
        # start); now it's server-side numpy work the backend does itself,
        # typically milliseconds, against the lesion file already on disk.
        overlap_model, overlap_reason = await _summary_overlap_stage(
            lesion_path, payload, stages, status, check_cancelled)

        check_cancelled()

        # ── Tract dissection ────────────────────────────────────────────────
        if stages.get("dissect", True):
            if not GLOBAL_TRACT_FILE.exists():
                status("dissect", "Skipping dissection (tract file not configured).", 0.45)
            else:
                status("dissect", "Running tract dissection…", 0.06)
                result_id = str(uuid.uuid4())
                wdir = Path(tempfile.mkdtemp(prefix="nv_sum_dissect_"))
                try:
                    cfg = {
                        "lesion_path": str(lesion_path),
                        "result_id": result_id,
                        "global_tract_file": str(GLOBAL_TRACT_FILE),
                        "tract_results_dir": str(TRACT_RESULTS_DIR),
                        "atlas_dir": str(ATLAS_DIR),
                        "atlas_specs": _atlas_specs_for("hcp1065"),
                    }
                    info = await run_stage(WORKER_SCRIPT, cfg, wdir, 600,
                                           "dissect", 0.06, 0.45,
                                           "Running tract dissection…")
                    if "error" not in info:
                        dissect_ref = {
                            "result_dir": str(TRACT_RESULTS_DIR / result_id),
                            "info": info,
                        }
                except SummaryCancelled:
                    raise
                except Exception as e:  # noqa: BLE001 — best-effort stage
                    logger.warning("summary dissection failed: %s", e)
                finally:
                    shutil.rmtree(wdir, ignore_errors=True)

        check_cancelled()

        # ── Lesion network mapping ──────────────────────────────────────────
        if stages.get("lnm", True):
            if not LNM_BUNDLE.exists():
                status("lnm", "Skipping LNM (connectome bundle not configured).", 0.85)
            else:
                status("lnm", "Running lesion network mapping…", 0.45)
                result_id = str(uuid.uuid4())
                wdir = Path(tempfile.mkdtemp(prefix="nv_sum_lnm_"))
                try:
                    cfg = {
                        "lesion_path": str(lesion_path),
                        "result_id": result_id,
                        "bundle_path": str(LNM_BUNDLE),
                        "lnm_results_dir": str(LNM_RESULTS_DIR),
                        "atlas_dir": str(ATLAS_DIR),
                        "metric": "t",
                        "threshold": 11.0,
                        "degree_adjust": True,
                        "run_specificity": True,
                        "nperm": 100,
                        "make_html": True,
                    }
                    info = await run_stage(LNM_WORKER_SCRIPT, cfg, wdir, 900,
                                           "lnm", 0.45, 0.85,
                                           "Running lesion network mapping…")
                    if "error" not in info:
                        lnm_ref = {
                            "result_dir": str(LNM_RESULTS_DIR / result_id),
                            "info": info,
                        }
                except SummaryCancelled:
                    raise
                except Exception as e:  # noqa: BLE001
                    logger.warning("summary LNM failed: %s", e)
                finally:
                    shutil.rmtree(wdir, ignore_errors=True)

        check_cancelled()

        # ── Render (retinotopy + brainsprite + glass PNGs + artifact manifest) ──
        status("render", "Rendering report & packaging…", 0.85)
        render_cfg = {
            "job_id": job_id,
            "lesion_path": str(lesion_path),
            "lesion_name": lesion_name,
            "atlas_dir": str(ATLAS_DIR),
            "output_dir": str(job_dir),
            "stages": stages,
            "overlap_model": overlap_model,
            "disc_pngs": payload.get("discPngs"),
            "dissect": dissect_ref,
            "lnm": lnm_ref,
        }
        rdir = Path(tempfile.mkdtemp(prefix="nv_sum_render_"))
        try:
            info = await run_stage(SUMMARY_RENDER_WORKER_SCRIPT, render_cfg, rdir,
                                   600, "render", 0.85, 0.99,
                                   "Rendering report & packaging…")
        finally:
            shutil.rmtree(rdir, ignore_errors=True)

        # Item 103: pass through the render worker's data + asset URLs (not
        # just zip/report) so the frontend can compose the summary report via
        # lib/report/sections.js — the same section builders Tract Dissection
        # and LNM use — instead of consuming a server-composed report.html.
        _summary_set_status(
            job_dir, stage="done", message="Summary ready.", progress=1.0,
            done=True, error=None,
            files={
                "artifacts": info.get("artifacts"),
                "lesion_name": info.get("lesion_name"),
                "retino": info.get("retino"),
                "dissect_info": info.get("dissect_info"),
                "lnm_info": info.get("lnm_info"),
                "overlap_model": info.get("overlap_model"),
                # Reason overlap is None or a fallback (deprecated client
                # model) — see _summary_overlap_stage. None on the normal
                # lqtpy success path.
                "overlap_reason": overlap_reason,
                "assets": info.get("assets"),
            })
    except (SummaryCancelled, asyncio.CancelledError):
        logger.info("summary job %s cancelled", job_id)
        _summary_set_status(job_dir, stage="cancelled", message="Cancelled.",
                            progress=1.0, done=True, error=None)
    except Exception as e:  # noqa: BLE001
        logger.exception("summary job failed")
        _summary_set_status(job_dir, stage="error", message=str(e),
                            progress=1.0, done=True, error=str(e))
    finally:
        _SUMMARY_TASKS.pop(job_id, None)
        _SUMMARY_CANCEL_FLAGS.discard(job_id)
        _SUMMARY_PROCS.pop(job_id, None)


# ---- Generic pollable-job machinery (shared with Summary) --------------------
# The summary helpers above are already job-kind-agnostic: _summary_set_status
# takes any job_dir, _run_worker_json runs any worker while tracking its Popen
# for cancellation, and the _SUMMARY_* registries are keyed by opaque UUID
# job_ids. Rather than duplicate three near-identical stacks, Tract Dissection
# and LNM reuse the SAME machinery through these readable aliases.
set_job_status     = _summary_set_status
request_job_cancel = request_summary_cancel
JobCancelled       = SummaryCancelled
_JOB_TASKS         = _SUMMARY_TASKS
_JOB_PROCS         = _SUMMARY_PROCS


async def _run_single_worker_job(job_id: str, job_dir: Path, worker_script: Path,
                                 config: dict, timeout: int, timeout_msg: str):
    """Background orchestration for a ONE-worker pollable job (dissection or LNM).

    The worker writes fine-grained progress into job_dir/status.json at its own
    stage boundaries (via the status_path we inject here); this coroutine writes
    only the initial 'running' marker and the terminal done/error/cancelled
    state — so there is never a concurrent writer on status.json. The full
    worker result is stashed under status['result'] for the poller to consume.
    """
    try:
        set_job_status(job_dir, stage="running", message="Starting…",
                       progress=0.02, done=False, error=None)
        cfg = dict(config)
        cfg["status_path"] = str(job_dir / "status.json")
        cfg["job_id"] = job_id
        wdir = Path(tempfile.mkdtemp(prefix="nv_job_"))
        try:
            info = await run_in_threadpool(
                _run_worker_json, worker_script, cfg, wdir, timeout, job_id)
        finally:
            shutil.rmtree(wdir, ignore_errors=True)

        if isinstance(info, dict) and "error" in info:
            set_job_status(job_dir, stage="error", message=info["error"],
                           progress=1.0, done=True, error=info["error"])
        else:
            set_job_status(job_dir, stage="done", message="Complete.",
                           progress=1.0, done=True, error=None, result=info)
    except (JobCancelled, asyncio.CancelledError):
        logger.info("job %s cancelled", job_id)
        set_job_status(job_dir, stage="cancelled", message="Cancelled.",
                       progress=1.0, done=True, error=None)
    except subprocess.TimeoutExpired:
        set_job_status(job_dir, stage="error", message=timeout_msg,
                       progress=1.0, done=True, error=timeout_msg)
    except Exception as e:  # noqa: BLE001
        logger.exception("job %s failed", job_id)
        set_job_status(job_dir, stage="error", message=str(e),
                       progress=1.0, done=True, error=str(e))
    finally:
        _JOB_TASKS.pop(job_id, None)
        _SUMMARY_CANCEL_FLAGS.discard(job_id)
        _JOB_PROCS.pop(job_id, None)


def _read_job_status(jobs_dir: Path, job_id: str):
    """Parse a job's status.json or raise HTTPException (400/404)."""
    if not _UUID4_RE.match(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id.")
    status_path = jobs_dir / job_id / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="Job not found.")
    return json.loads(status_path.read_text())


def _cancel_job(jobs_dir: Path, job_id: str):
    """Cancel a running job (kill its worker subprocess). Idempotent."""
    if not _UUID4_RE.match(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id.")
    status_path = jobs_dir / job_id / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="Job not found.")
    current = json.loads(status_path.read_text())
    if current.get("done"):
        return {"ok": True, "already_done": True, "stage": current.get("stage")}
    request_job_cancel(job_id)
    return {"ok": True, "already_done": False}








# ---- Spherical ROI builder ---------------------------------------------------





# ---- Drawn-lesion persistence ------------------------------------------------
def _safe_slug(name: str) -> str:
    """Filesystem-safe slug for a user-supplied lesion/case name."""
    keep = "".join(c if (c.isalnum() or c in "-_") else "_" for c in (name or "").strip())
    keep = keep.strip("._") or "unnamed"
    return keep[:80]






# Include the router in the main app



# Serve the built React app from the same origin as the API (production /
# container). Mounted AFTER the /api router so API routes always win. This makes
# any URL path open the app and removes CORS concerns in prod. Skipped in dev
# when no build exists (the CRA dev server on :3000 serves the UI instead).

# Configure logging


# Re-export every top-level name (incl. _underscore helpers) so routers
# can `from deps import *` and reach the shared config + helpers.
__all__ = [_k for _k in list(globals()) if not _k.startswith("__")]
