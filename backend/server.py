from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from starlette.datastructures import UploadFile as StarletteUploadFile
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import json
import os
import re as _re
import sys
import shutil
import tempfile
import subprocess
import zipfile
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional
import uuid
from datetime import datetime, timezone


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection — fail fast with a clear message instead of a raw KeyError.
mongo_url = os.environ.get('MONGO_URL')
db_name = os.environ.get('DB_NAME')
if not mongo_url or not db_name:
    raise RuntimeError(
        "MONGO_URL and DB_NAME must be set (via env or backend/.env). "
        f"Got MONGO_URL={'set' if mongo_url else 'MISSING'}, "
        f"DB_NAME={'set' if db_name else 'MISSING'}."
    )
client = AsyncIOMotorClient(mongo_url)
db = client[db_name]

# Where the built frontend lives (served as static at '/') and where drawn
# lesions are persisted. Both overridable via env for containerized deploys.
STATIC_DIR = Path(os.environ.get('STATIC_DIR', str(ROOT_DIR.parent / 'frontend' / 'build')))
LESION_DIR = Path(os.environ.get('LESION_DIR', str(ROOT_DIR / 'lesion_store')))
GLOBAL_TRACT_FILE = Path(os.environ.get(
    'GLOBAL_TRACT_FILE',
    str(ROOT_DIR / 'tracts' / 'S35_1mm.trk')
))
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
LNM_BUNDLE = Path(os.environ.get(
    'LNM_BUNDLE', str(ROOT_DIR.parent / 'DaLnm' / 'lnm_bundle_d100.npz')
))
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

# UUID4 regex used for path-traversal-safe result_id validation.
_UUID4_RE = _re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')


def _cleanup_old_tract_results(max_age_hours: int = 24) -> None:
    """Remove tract result subdirs older than max_age_hours."""
    import time
    cutoff = time.time() - max_age_hours * 3600
    for subdir in TRACT_RESULTS_DIR.iterdir():
        if subdir.is_dir() and subdir.stat().st_mtime < cutoff:
            shutil.rmtree(subdir, ignore_errors=True)


_cleanup_old_tract_results()


# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models
class StatusCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")  # Ignore MongoDB's _id field
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str

# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.model_dump()
    status_obj = StatusCheck(**status_dict)
    
    # Convert to dict and serialize datetime to ISO string for MongoDB
    doc = status_obj.model_dump()
    doc['timestamp'] = doc['timestamp'].isoformat()
    
    _ = await db.status_checks.insert_one(doc)
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    # Exclude MongoDB's _id field from the query results
    status_checks = await db.status_checks.find({}, {"_id": 0}).to_list(1000)
    
    # Convert ISO string timestamps back to datetime objects
    for check in status_checks:
        if isinstance(check['timestamp'], str):
            check['timestamp'] = datetime.fromisoformat(check['timestamp'])
    
    return status_checks


# Path to the Electron-built Windows desktop artefact. Built via:
#   cd /app/frontend && yarn dist:win
DESKTOP_ARTIFACTS_DIR = Path("/app/frontend/dist-electron")


@api_router.get("/download/desktop")
async def download_desktop_zip():
    """Stream the latest Windows desktop build (.zip) to the browser."""
    if not DESKTOP_ARTIFACTS_DIR.exists():
        raise HTTPException(status_code=404, detail="No desktop build found. Run `yarn dist:win` in /app/frontend.")
    candidates = sorted(DESKTOP_ARTIFACTS_DIR.glob("NeuroVue-*-x64.zip"))
    if not candidates:
        raise HTTPException(status_code=404, detail="Windows .zip artefact not found in dist-electron/.")
    artefact = candidates[-1]  # latest by name (version order)
    return FileResponse(
        path=str(artefact),
        media_type="application/zip",
        filename=artefact.name,
    )


@api_router.get("/download/desktop/info")
async def download_desktop_info():
    """Lightweight metadata about the available desktop build."""
    if not DESKTOP_ARTIFACTS_DIR.exists():
        return {"available": False, "reason": "dist-electron/ not found"}
    candidates = sorted(DESKTOP_ARTIFACTS_DIR.glob("NeuroVue-*-x64.zip"))
    if not candidates:
        return {"available": False, "reason": "no .zip artefact"}
    artefact = candidates[-1]
    stat = artefact.stat()
    return {
        "available": True,
        "filename": artefact.name,
        "size_bytes": stat.st_size,
        "size_mb": round(stat.st_size / (1024 * 1024), 1),
        "built_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "download_url": "/api/download/desktop",
    }


# === Benson / Wang regeneration validation artefacts ===
# Default to the repo/bundle-relative scripts/ dir (sibling of backend/). The
# hardcoded "/app/..." paths only worked inside the Docker image; on Windows
# (offline installer) they resolve to a bogus C:\app\... and 404 these endpoints.
# Overridable via env so the launcher can point them at the installed location.
VALIDATION_DIR = Path(os.environ.get(
    'VALIDATION_DIR', str(ROOT_DIR.parent / 'scripts' / 'validation_plots')))
VALIDATION_REPORT = Path(os.environ.get(
    'VALIDATION_REPORT', str(ROOT_DIR.parent / 'scripts' / 'benson_validation_report.txt')))


@api_router.get("/validation/report")
async def get_validation_report():
    """Return the text validation report comparing produced vs expected ranges."""
    if not VALIDATION_REPORT.exists():
        raise HTTPException(status_code=404, detail="Validation report not found.")
    return FileResponse(
        path=str(VALIDATION_REPORT),
        media_type="text/plain",
        filename=VALIDATION_REPORT.name,
    )


@api_router.get("/validation/plots")
async def list_validation_plots():
    """List the validation plot PNGs (surface vs MNI projection side-by-side)."""
    if not VALIDATION_DIR.exists():
        return {"plots": []}
    files = sorted([p.name for p in VALIDATION_DIR.glob("*.png")])
    return {"plots": files, "endpoint_template": "/api/validation/plots/{name}"}


@api_router.get("/validation/plots/{name}")
async def get_validation_plot(name: str):
    safe = (VALIDATION_DIR / name).resolve()
    if VALIDATION_DIR.resolve() not in safe.parents or not safe.exists():
        raise HTTPException(status_code=404, detail="Plot not found.")
    return FileResponse(path=str(safe), media_type="image/png", filename=name)


# === Atlas quantitative verification checks ===
ATLAS_DIR = Path(os.environ.get(
    "ATLAS_DIR",
    str(Path(__file__).parent.parent / "frontend" / "public" / "atlases"),
))

_ATLAS_SPECS = [
    {"name": "Benson 2014 — Polar Angle",       "file": "benson14_polar_angle.nii.gz",  "vmin": 0.0,  "vmax": 360.0, "labels": None},
    {"name": "Benson 2014 — Eccentricity",       "file": "benson14_eccentricity.nii.gz", "vmin": 0.0,  "vmax": 90.0,  "labels": None},
    {"name": "Benson 2014 — Visual Areas",       "file": "benson14_visual_areas.nii.gz", "vmin": 1.0,  "vmax": 12.0,  "labels": list(range(1, 13))},
    {"name": "Wang 2015 — Max-probability ROIs", "file": "wang2015_maxprob.nii.gz",      "vmin": 1.0,  "vmax": 25.0,  "labels": list(range(1, 26))},
]


def _run_atlas_checks(atlas_dir: Path):
    import nibabel as nib
    import numpy as np

    results = []

    vc_path = atlas_dir / "visual_areas_v1v5.nii.gz"
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


@api_router.get("/validation/check")
async def run_atlas_validation():
    """Run quantitative pass/fail checks on each MNI152 atlas .nii.gz file."""
    try:
        return await run_in_threadpool(_run_atlas_checks, ATLAS_DIR)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Atlas check failed: {e}")


@api_router.get("/validation/round-trip")
async def run_round_trip_validation():
    """Round-trip fidelity + neuropythy reference validation (runs in ~10-30 s)."""
    try:
        scripts_dir = str(Path(__file__).parent.parent / "scripts")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        from validate_round_trip import run as _rt_run
        return await run_in_threadpool(_rt_run, ATLAS_DIR)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Round-trip validation failed: {e}")


# === DICOM → NIfTI conversion (dcm2niix) ===
# Robust path for clinical DICOM (series / compressed transfer syntaxes).
# Requires the `dcm2niix` binary on PATH and `python-multipart` installed.


def _largest_nifti(directory: Path):
    cands = list(directory.glob("*.nii.gz")) + list(directory.glob("*.nii"))
    if not cands:
        return None
    return max(cands, key=lambda p: p.stat().st_size)


@api_router.get("/convert/dicom/available")
async def dicom_convert_available():
    """Report whether server-side DICOM conversion is usable."""
    exe = shutil.which("dcm2niix")
    return {"available": bool(exe), "dcm2niix": exe}


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


@api_router.post("/convert/dicom")
async def convert_dicom(request: Request):
    """Convert an uploaded DICOM folder (loose files or a .zip) to NIfTI and
    return the list of series produced. dcm2niix splits multi-series studies
    into separate NIfTIs; the client picks one to load via
    /api/convert/dicom/result/{job_id}/{series_id}.

    We parse the multipart form manually so we can raise Starlette's default
    file cap (max_files=1000, which surfaces as "Too many files. Maximum number
    of files is 1000."). Whole-study DICOM folders routinely exceed 1000 slices,
    and compute here is cheap, so allow up to 10,000 files/fields.
    """
    if not shutil.which("dcm2niix"):
        raise HTTPException(
            status_code=503,
            detail="dcm2niix not installed on the server. Install it or use NIfTI input.",
        )

    form = await request.form(max_files=10000, max_fields=10000)
    # request.form() yields Starlette UploadFile objects; fastapi.UploadFile is a
    # subclass, so match the base class to avoid filtering real files out. Plain
    # string form fields (if any) are ignored.
    files = [f for f in form.getlist("files") if isinstance(f, StarletteUploadFile)]
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded.")

    # Best-effort TTL cleanup of stale job dirs (>6h) so results don't pile up.
    try:
        import time
        cutoff = time.time() - 6 * 3600
        for d in DICOM_RESULTS_DIR.iterdir():
            if d.is_dir() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
    except Exception:  # noqa: BLE001
        pass

    job_id = str(uuid.uuid4())
    out_dir = DICOM_RESULTS_DIR / job_id
    workdir = Path(tempfile.mkdtemp(prefix="nv_dcm_"))
    in_dir = workdir / "in"
    in_dir.mkdir()
    out_dir.mkdir(parents=True, exist_ok=True)

    def _cleanup_in():
        shutil.rmtree(workdir, ignore_errors=True)

    try:
        for uf in files:
            raw = await uf.read()
            name = os.path.basename(uf.filename or "file.dcm")
            if name.lower().endswith(".zip"):
                zpath = in_dir / name
                zpath.write_bytes(raw)
                with zipfile.ZipFile(zpath) as zf:
                    zf.extractall(in_dir)
                zpath.unlink(missing_ok=True)
            else:
                (in_dir / name).write_bytes(raw)

        # -b y writes BIDS JSON sidecars (SeriesDescription); %s_%d names outputs
        # per series/description so multi-series studies stay separate.
        proc = subprocess.run(
            ["dcm2niix", "-z", "y", "-b", "y", "-f", "%s_%d",
             "-o", str(out_dir), str(in_dir)],
            capture_output=True, text=True, timeout=300,
        )
        _cleanup_in()

        niftis = sorted(out_dir.glob("*.nii.gz"))
        if not niftis:
            shutil.rmtree(out_dir, ignore_errors=True)
            raise HTTPException(
                status_code=422,
                detail=f"dcm2niix produced no NIfTI. {proc.stderr[-500:] if proc.stderr else ''}",
            )

        series = [_dicom_series_metadata(p) for p in niftis]
        series.sort(key=lambda s: s["bytes"], reverse=True)
        return {"job_id": job_id, "series": series}
    except HTTPException:
        raise
    except subprocess.TimeoutExpired:
        _cleanup_in()
        shutil.rmtree(out_dir, ignore_errors=True)
        raise HTTPException(status_code=504, detail="DICOM conversion timed out.")
    except Exception as e:  # noqa: BLE001
        _cleanup_in()
        shutil.rmtree(out_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Conversion failed: {e}")


@api_router.get("/convert/dicom/result/{job_id}/{series_id}")
async def convert_dicom_result(job_id: str, series_id: str):
    """Stream a converted DICOM series (.nii.gz) chosen from the series list."""
    if not _UUID4_RE.match(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id.")
    # series_id comes from our own filenames; strip any path components defensively.
    safe_series = os.path.basename(series_id)
    fpath = (DICOM_RESULTS_DIR / job_id / f"{safe_series}.nii.gz")
    if not fpath.exists():
        raise HTTPException(status_code=404, detail="Series not found (job may have expired).")
    return FileResponse(
        path=str(fpath),
        media_type="application/gzip",
        filename=f"{safe_series}.nii.gz",
    )


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


@api_router.get("/longitudinal/available")
async def longitudinal_available():
    try:
        import SimpleITK  # noqa: F401
        return {"available": True}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "reason": str(e)}


@api_router.post("/longitudinal/register")
async def longitudinal_register(
    baseline: UploadFile = File(...), followup: UploadFile = File(...)
):
    try:
        import SimpleITK  # noqa: F401
    except Exception:
        raise HTTPException(
            status_code=503,
            detail="SimpleITK not installed on the server.",
        )

    workdir = Path(tempfile.mkdtemp(prefix="nv_long_"))

    def _cleanup():
        shutil.rmtree(workdir, ignore_errors=True)

    try:
        bpath = workdir / (os.path.basename(baseline.filename or "baseline.nii.gz"))
        fpath = workdir / (os.path.basename(followup.filename or "followup.nii.gz"))
        bpath.write_bytes(await baseline.read())
        fpath.write_bytes(await followup.read())
        out_path = workdir / "difference.nii.gz"
        metrics = await run_in_threadpool(_run_longitudinal, bpath, fpath, out_path)
        return FileResponse(
            path=str(out_path),
            media_type="application/gzip",
            filename="difference.nii.gz",
            headers={
                "X-Registration-Metric": str(metrics["registration_metric"]),
                "X-Same-Grid": str(metrics["same_grid"]),
                "X-Changed-Voxel-Pct": str(metrics["changed_voxel_pct"]),
            },
            background=BackgroundTask(_cleanup),
        )
    except HTTPException:
        _cleanup()
        raise
    except Exception as e:  # noqa: BLE001
        _cleanup()
        raise HTTPException(status_code=500, detail=f"Registration failed: {e}")


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


@api_router.get("/tracts/subsample/available")
async def tract_subsample_available():
    try:
        import nibabel  # noqa: F401
        return {"available": True}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "reason": str(e)}


@api_router.post("/tracts/subsample")
async def tract_subsample(
    file: UploadFile = File(...),
    max_streamlines: int = Form(200000),
):
    """Subsample a large tractogram (.tck/.trk) so it fits in the browser's
    WebGL renderer, and stream the smaller file back in the same format."""
    try:
        import nibabel  # noqa: F401
    except Exception:
        raise HTTPException(
            status_code=503, detail="nibabel not installed on the server."
        )

    name = os.path.basename(file.filename or "tractogram.tck")
    lname = name.lower()
    if lname.endswith(".tck"):
        ext = ".tck"
    elif lname.endswith(".trk"):
        ext = ".trk"
    else:
        raise HTTPException(
            status_code=400,
            detail="Only .tck and .trk tractograms can be subsampled.",
        )

    workdir = Path(tempfile.mkdtemp(prefix="nv_tck_"))

    def _cleanup():
        shutil.rmtree(workdir, ignore_errors=True)

    try:
        in_path = workdir / name
        # Stream the upload to disk in chunks instead of buffering it all in RAM.
        with open(in_path, "wb") as dst:
            shutil.copyfileobj(file.file, dst)
        out_path = workdir / f"subsampled{ext}"
        info = await run_in_threadpool(
            _run_tract_subsample, in_path, out_path, max_streamlines
        )
        return FileResponse(
            path=str(out_path),
            media_type="application/octet-stream",
            filename=f"subsampled{ext}",
            headers={
                "X-Input-Streamlines": str(info["input_streamlines"]),
                "X-Output-Streamlines": str(info["output_streamlines"]),
            },
            background=BackgroundTask(_cleanup),
        )
    except HTTPException:
        _cleanup()
        raise
    except Exception as e:  # noqa: BLE001
        _cleanup()
        raise HTTPException(status_code=500, detail=f"Subsampling failed: {e}")


# === Lesion-based virtual tract dissection ====================================
# The heavy DIPY computation runs in dissect_worker.py via subprocess so that
# a segfault or OOM in DIPY's C extensions cannot crash uvicorn.


@api_router.get("/tracts/dissect/available")
async def tract_dissect_available():
    """Report whether dipy is installed and the global tract file is present."""
    try:
        import nibabel as nib  # noqa: F401
        from dipy.tracking.utils import target, density_map  # noqa: F401
    except Exception as e:
        return {"ok": False, "dipy": False, "reason": str(e)}

    if not GLOBAL_TRACT_FILE.exists():
        return {
            "ok": False,
            "dipy": True,
            "tract_file_present": False,
            "tract_file_path": str(GLOBAL_TRACT_FILE),
            "reason": f"Global tract file not found: {GLOBAL_TRACT_FILE}",
        }
    try:
        import nibabel as nib
        lazy = nib.streamlines.load(str(GLOBAL_TRACT_FILE), lazy_load=True)
        # nibabel returns nb_streamlines as a numpy.int32, which FastAPI's
        # jsonable_encoder cannot serialize — cast to a plain int or the whole
        # endpoint 500s (and the frontend panel then hides its uploader).
        n_raw = lazy.header.get("nb_streamlines")
        n = int(n_raw) if n_raw is not None else "?"
        dims = [int(x) for x in lazy.header.get("dimensions", [])]
        voxel_sizes = [float(x) for x in lazy.header.get("voxel_sizes", [])]
        return {
            "ok": True,
            "dipy": True,
            "tract_file_present": True,
            "n_streamlines": n,
            "dimensions": dims,
            "voxel_sizes": voxel_sizes,
        }
    except Exception as e:
        return {"ok": False, "dipy": True, "tract_file_present": True, "reason": str(e)}


# Atlas presets driving the tract-dissection region breakdown. The default
# ("harvard_oxford") preserves the legacy ho_cort result key.
_ATLAS_PRESETS = {
    "harvard_oxford": [
        {"key": "ho_cort", "nii": "harvard_oxford_cort.nii.gz",
         "labels": "harvard_oxford_cort_labels.json"},
    ],
    "hcp1065": [
        {"key": "hcp1065", "mode": "tracts4d",
         "nii": "HCP1065_tractography.nii.gz",
         "labels": "HCP1065_tracts_labels.json"},
    ],
    "juelich": [
        {"key": "juelich", "nii": "juelich_atlas.nii.gz",
         "labels": "juelich_labels.json"},
    ],
}


def _atlas_specs_for(atlas: str):
    return _ATLAS_PRESETS.get((atlas or "harvard_oxford").strip().lower(),
                              _ATLAS_PRESETS["harvard_oxford"])


@api_router.post("/tracts/dissect")
async def tract_dissect(
    file: UploadFile = File(...),
    name: str = Form(""),
    atlas: str = Form("harvard_oxford"),
):
    """Virtual dissection: find streamlines passing through the lesion mask.

    The computation runs in dissect_worker.py via subprocess — DIPY crashes or
    OOM kills affect only the worker process, never uvicorn.
    """
    if not GLOBAL_TRACT_FILE.exists():
        raise HTTPException(status_code=503,
            detail="Global tract file not configured. Set GLOBAL_TRACT_FILE env var.")

    filename = os.path.basename(file.filename or "lesion.nii.gz").lower()
    if not (filename.endswith(".nii") or filename.endswith(".nii.gz")):
        raise HTTPException(status_code=400, detail="Lesion file must be .nii or .nii.gz")

    workdir   = Path(tempfile.mkdtemp(prefix="nv_dissect_"))
    result_id = str(uuid.uuid4())

    def _cleanup():
        shutil.rmtree(workdir, ignore_errors=True)

    try:
        lesion_path = workdir / os.path.basename(file.filename or "lesion.nii.gz")
        with open(lesion_path, "wb") as dst:
            shutil.copyfileobj(file.file, dst)

        config = {
            "lesion_path":       str(lesion_path),
            "result_id":         result_id,
            "global_tract_file": str(GLOBAL_TRACT_FILE),
            "tract_results_dir": str(TRACT_RESULTS_DIR),
            "atlas_dir":         str(ATLAS_DIR),
            "atlas_specs":       _atlas_specs_for(atlas),
        }
        (workdir / "config.json").write_text(json.dumps(config))

        # Run the worker as a blocking subprocess inside a worker thread. This
        # works on any event loop: asyncio.create_subprocess_exec raises
        # NotImplementedError under uvicorn --reload on Windows (its
        # SelectorEventLoop has no subprocess support), whereas subprocess.run
        # does not depend on the asyncio child watcher. Process isolation — a
        # DIPY crash/OOM killing only the worker — is preserved either way.
        def _run_worker():
            return subprocess.run(
                [sys.executable, str(WORKER_SCRIPT), str(workdir / "config.json")],
                capture_output=True, timeout=600,
            )

        try:
            completed = await run_in_threadpool(_run_worker)
        except subprocess.TimeoutExpired:
            _cleanup()
            raise HTTPException(status_code=504,
                detail="Dissection timed out (>10 min). The tractogram may be too large for available RAM.")

        if completed.returncode != 0:
            err = completed.stderr.decode(errors="replace")[-1000:]
            _cleanup()
            raise HTTPException(status_code=500, detail=f"Dissection worker failed: {err}")

        info = json.loads(completed.stdout.decode())
        # Worker signals MNI-space validation failure via an error key
        if "error" in info:
            _cleanup()
            raise HTTPException(status_code=422, detail=info["error"])

        _cleanup()
        return JSONResponse(content=info)

    except HTTPException:
        raise
    except Exception as e:
        _cleanup()
        raise HTTPException(status_code=500, detail=f"Dissection failed: {e}")


@api_router.post("/tracts/dissect/between")
async def tract_dissect_between(
    file_a: UploadFile = File(...),
    file_b: UploadFile = File(...),
    mode_a: str = Form("through"),
    mode_b: str = Form("through"),
    atlas: str = Form("harvard_oxford"),
):
    """Find streamlines that connect two lesion masks (pass through both).

    Runs dissect_between_worker.py in a subprocess for crash isolation.
    Result files (connecting_tracts.nii.gz, .trk) are served by the
    existing /api/tracts/dissect/result/{result_id}/{filename} endpoint.
    """
    if not GLOBAL_TRACT_FILE.exists():
        raise HTTPException(status_code=503,
            detail="Global tract file not configured. Set GLOBAL_TRACT_FILE env var.")

    def _valid_ext(fname: str) -> bool:
        n = os.path.basename(fname or "x").lower()
        return n.endswith(".nii") or n.endswith(".nii.gz")

    if not _valid_ext(file_a.filename) or not _valid_ext(file_b.filename):
        raise HTTPException(status_code=400,
            detail="Both lesion files must be .nii or .nii.gz")

    workdir   = Path(tempfile.mkdtemp(prefix="nv_between_"))
    result_id = str(uuid.uuid4())

    def _cleanup():
        shutil.rmtree(workdir, ignore_errors=True)

    try:
        base_a = os.path.basename(file_a.filename or "lesion_a.nii.gz")
        base_b = os.path.basename(file_b.filename or "lesion_b.nii.gz")
        # Avoid name collision if both files share the same basename
        if base_a == base_b:
            base_b = "b_" + base_b
        path_a = workdir / base_a
        path_b = workdir / base_b
        with open(path_a, "wb") as dst:
            shutil.copyfileobj(file_a.file, dst)
        with open(path_b, "wb") as dst:
            shutil.copyfileobj(file_b.file, dst)

        # "starts at"/"terminates at" both mean an endpoint lies in the ROI
        # (streamlines are undirected); anything else is treated as pass-through.
        def _norm_mode(m: str) -> str:
            return "end" if (m or "").strip().lower() in ("start", "terminate", "end") else "through"

        config = {
            "lesion_path_a":    str(path_a),
            "lesion_path_b":    str(path_b),
            "result_id":        result_id,
            "global_tract_file": str(GLOBAL_TRACT_FILE),
            "tract_results_dir": str(TRACT_RESULTS_DIR),
            "atlas_dir":         str(ATLAS_DIR),
            "atlas_specs":       _atlas_specs_for(atlas),
            "mode_a":           _norm_mode(mode_a),
            "mode_b":           _norm_mode(mode_b),
        }
        (workdir / "config.json").write_text(json.dumps(config))

        def _run_worker():
            return subprocess.run(
                [sys.executable, str(DISSECT_BETWEEN_WORKER_SCRIPT),
                 str(workdir / "config.json")],
                capture_output=True, timeout=600,
            )

        try:
            completed = await run_in_threadpool(_run_worker)
        except subprocess.TimeoutExpired:
            _cleanup()
            raise HTTPException(status_code=504,
                detail="Between-dissection timed out (>10 min).")

        if completed.returncode != 0:
            err = completed.stderr.decode(errors="replace")[-1000:]
            _cleanup()
            raise HTTPException(status_code=500,
                detail=f"Between-dissection worker failed: {err}")

        info = json.loads(completed.stdout.decode())
        if "error" in info:
            _cleanup()
            raise HTTPException(status_code=422, detail=info["error"])

        _cleanup()
        return JSONResponse(content=info)

    except HTTPException:
        raise
    except Exception as e:
        _cleanup()
        raise HTTPException(status_code=500, detail=f"Between-dissection failed: {e}")


@api_router.get("/tracts/dissect/result/{result_id}/{filename}")
async def tract_dissect_result(result_id: str, filename: str):
    """Serve a persisted dissection result (NIfTI or .trk) for download."""
    # Sanitize to prevent path traversal (including Windows backslash bypass)
    if not _UUID4_RE.match(result_id):
        raise HTTPException(status_code=400, detail="Invalid result id.")
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    file_path = TRACT_RESULTS_DIR / result_id / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Result file not found")
    media = "application/gzip" if filename.endswith(".gz") else "application/octet-stream"
    return FileResponse(path=str(file_path), media_type=media, filename=filename)


# ---- DaLn mapper (degree-corrected lesion network mapping) --------------------

@api_router.get("/lnm/available")
async def lnm_available():
    """Report whether the DaLn mapper can run (deps + bundle present)."""
    try:
        import numpy  # noqa: F401
        import nibabel  # noqa: F401
        from nilearn.image import resample_to_img  # noqa: F401
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"Missing dependency: {e}"}
    if not LNM_BUNDLE.exists():
        return {"ok": False, "reason": "Connectome bundle not found. Set LNM_BUNDLE env var.",
                "bundle_present": False}
    return {"ok": True, "bundle_present": True}


@api_router.post("/lnm/compute")
async def lnm_compute(
    file: UploadFile = File(...),
    name: str = Form(""),
    metric: str = Form("t"),
    threshold: float = Form(11.0),
    zthr: float = Form(0.2),
    pthr: Optional[float] = Form(None),
    degree_adjust: bool = Form(True),
    run_specificity: bool = Form(True),
    nperm: int = Form(100),
    alpha: float = Form(0.05),
    fdr: bool = Form(False),
    make_html: bool = Form(True),
):
    """Run degree-adjusted lesion network mapping (DA-LNM) on a lesion mask.

    Runs lnm_worker.py in a subprocess for crash isolation. Output NIfTIs and
    the HTML report are served by /api/lnm/result/{result_id}/{filename}.
    """
    if not LNM_BUNDLE.exists():
        raise HTTPException(status_code=503,
            detail="Connectome bundle not configured. Set LNM_BUNDLE env var.")

    filename = os.path.basename(file.filename or "lesion.nii.gz").lower()
    if not (filename.endswith(".nii") or filename.endswith(".nii.gz")):
        raise HTTPException(status_code=400, detail="Lesion file must be .nii or .nii.gz")

    if metric not in ("t", "z"):
        raise HTTPException(status_code=400, detail="metric must be 't' or 'z'")

    workdir   = Path(tempfile.mkdtemp(prefix="nv_lnm_"))
    result_id = str(uuid.uuid4())

    def _cleanup():
        shutil.rmtree(workdir, ignore_errors=True)

    try:
        lesion_path = workdir / os.path.basename(file.filename or "lesion.nii.gz")
        with open(lesion_path, "wb") as dst:
            shutil.copyfileobj(file.file, dst)

        config = {
            "lesion_path":     str(lesion_path),
            "result_id":       result_id,
            "bundle_path":     str(LNM_BUNDLE),
            "lnm_results_dir": str(LNM_RESULTS_DIR),
            "atlas_dir":       str(ATLAS_DIR),
            "metric":          metric,
            "threshold":       float(threshold),
            "zthr":            float(zthr),
            "pthr":            (float(pthr) if pthr is not None else None),
            "degree_adjust":   bool(degree_adjust),
            "run_specificity": bool(run_specificity),
            "nperm":           int(nperm),
            "alpha":           float(alpha),
            "fdr":             bool(fdr),
            "make_html":       bool(make_html),
        }
        (workdir / "config.json").write_text(json.dumps(config))

        def _run_worker():
            return subprocess.run(
                [sys.executable, str(LNM_WORKER_SCRIPT), str(workdir / "config.json")],
                capture_output=True, timeout=900,
            )

        try:
            completed = await run_in_threadpool(_run_worker)
        except subprocess.TimeoutExpired:
            _cleanup()
            raise HTTPException(status_code=504,
                detail="Lesion network mapping timed out (>15 min). "
                       "Try lowering nperm or switching to the z metric.")

        if completed.returncode != 0:
            err = completed.stderr.decode(errors="replace")[-1000:]
            _cleanup()
            raise HTTPException(status_code=500, detail=f"LNM worker failed: {err}")

        info = json.loads(completed.stdout.decode())
        if "error" in info:
            _cleanup()
            raise HTTPException(status_code=422, detail=info["error"])

        _cleanup()
        return JSONResponse(content=info)

    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        _cleanup()
        raise HTTPException(status_code=500, detail=f"Lesion network mapping failed: {e}")


@api_router.get("/lnm/result/{result_id}/{filename}")
async def lnm_result(result_id: str, filename: str):
    """Serve a persisted DaLn mapper output (NIfTI) for download / overlay."""
    if not _UUID4_RE.match(result_id):
        raise HTTPException(status_code=400, detail="Invalid result id.")
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    file_path = LNM_RESULTS_DIR / result_id / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Result file not found")
    if filename.endswith(".gz"):
        media = "application/gzip"
    elif filename.endswith(".html"):
        media = "text/html"
    else:
        media = "application/octet-stream"
    return FileResponse(path=str(file_path), media_type=media, filename=filename)


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


def _run_worker_json(script: Path, config: dict, workdir: Path, timeout: int):
    """Run a worker subprocess (isolated) and return its parsed JSON, or None.

    subprocess.run in a thread — never asyncio.create_subprocess_exec, which
    raises under uvicorn --reload on Windows.
    """
    (workdir / "config.json").write_text(json.dumps(config))
    completed = subprocess.run(
        [sys.executable, str(script), str(workdir / "config.json")],
        capture_output=True, timeout=timeout,
    )
    if completed.returncode != 0:
        err = completed.stderr.decode(errors="replace")[-1000:]
        raise RuntimeError(err or f"worker exited {completed.returncode}")
    return json.loads(completed.stdout.decode())


async def _run_summary_job(job_id: str, lesion_path: Path, payload: dict):
    """Background orchestration: dissection + LNM + retinotopy render + ZIP."""
    job_dir = SUMMARY_RESULTS_DIR / job_id
    stages = payload.get("stages") or {}
    lesion_name = payload.get("name") or lesion_path.name

    def status(stage, message, progress):
        _summary_set_status(job_dir, stage=stage, message=message,
                            progress=progress, done=False, error=None)

    dissect_ref = None
    lnm_ref = None
    try:
        status("prepare", "Preparing inputs…", 0.05)

        # ── Tract dissection ────────────────────────────────────────────────
        if stages.get("dissect", True):
            if not GLOBAL_TRACT_FILE.exists():
                status("dissect", "Skipping dissection (tract file not configured).", 0.2)
            else:
                status("dissect", "Running tract dissection…", 0.2)
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
                    info = await run_in_threadpool(
                        _run_worker_json, WORKER_SCRIPT, cfg, wdir, 600)
                    if "error" not in info:
                        dissect_ref = {
                            "result_dir": str(TRACT_RESULTS_DIR / result_id),
                            "info": info,
                        }
                except Exception as e:  # noqa: BLE001 — best-effort stage
                    logger.warning("summary dissection failed: %s", e)
                finally:
                    shutil.rmtree(wdir, ignore_errors=True)

        # ── Lesion network mapping ──────────────────────────────────────────
        if stages.get("lnm", True):
            if not LNM_BUNDLE.exists():
                status("lnm", "Skipping LNM (connectome bundle not configured).", 0.5)
            else:
                status("lnm", "Running lesion network mapping…", 0.5)
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
                    info = await run_in_threadpool(
                        _run_worker_json, LNM_WORKER_SCRIPT, cfg, wdir, 900)
                    if "error" not in info:
                        lnm_ref = {
                            "result_dir": str(LNM_RESULTS_DIR / result_id),
                            "info": info,
                        }
                except Exception as e:  # noqa: BLE001
                    logger.warning("summary LNM failed: %s", e)
                finally:
                    shutil.rmtree(wdir, ignore_errors=True)

        # ── Render (retinotopy + brainsprite + glass PNGs + report + ZIP) ────
        status("render", "Rendering report & packaging…", 0.8)
        render_cfg = {
            "job_id": job_id,
            "lesion_path": str(lesion_path),
            "lesion_name": lesion_name,
            "atlas_dir": str(ATLAS_DIR),
            "output_dir": str(job_dir),
            "stages": stages,
            "overlap_model": payload.get("overlapModel"),
            "disc_pngs": payload.get("discPngs"),
            "dissect": dissect_ref,
            "lnm": lnm_ref,
        }
        rdir = Path(tempfile.mkdtemp(prefix="nv_sum_render_"))
        try:
            info = await run_in_threadpool(
                _run_worker_json, SUMMARY_RENDER_WORKER_SCRIPT, render_cfg, rdir, 600)
        finally:
            shutil.rmtree(rdir, ignore_errors=True)

        _summary_set_status(
            job_dir, stage="done", message="Summary ready.", progress=1.0,
            done=True, error=None,
            files={"zip": info.get("zip"), "report": info.get("report")})
    except Exception as e:  # noqa: BLE001
        logger.exception("summary job failed")
        _summary_set_status(job_dir, stage="error", message=str(e),
                            progress=1.0, done=True, error=str(e))


@api_router.get("/summary/available")
async def summary_available():
    """Report whether the summary renderer can run (nilearn present)."""
    try:
        import nibabel  # noqa: F401
        from nilearn import plotting  # noqa: F401
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"Missing dependency: {e}"}
    return {"ok": True,
            "dissect": GLOBAL_TRACT_FILE.exists(),
            "lnm": LNM_BUNDLE.exists()}


@api_router.post("/summary/run")
async def summary_run(file: UploadFile = File(...), payload: str = Form("{}")):
    """Kick off the One-Click Summary pipeline; returns a job id to poll."""
    filename = os.path.basename(file.filename or "lesion.nii.gz").lower()
    if not (filename.endswith(".nii") or filename.endswith(".nii.gz")):
        raise HTTPException(status_code=400, detail="Lesion file must be .nii or .nii.gz")

    try:
        payload_obj = json.loads(payload or "{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid payload JSON.")

    job_id = str(uuid.uuid4())
    job_dir = SUMMARY_RESULTS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    lesion_path = job_dir / os.path.basename(file.filename or "lesion.nii.gz")
    with open(lesion_path, "wb") as dst:
        shutil.copyfileobj(file.file, dst)

    _summary_set_status(job_dir, stage="queued", message="Queued…",
                        progress=0.0, done=False, error=None)
    asyncio.create_task(_run_summary_job(job_id, lesion_path, payload_obj))
    return {"job_id": job_id}


@api_router.get("/summary/status/{job_id}")
async def summary_status(job_id: str):
    """Poll a summary job's progress."""
    if not _UUID4_RE.match(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id.")
    status_path = SUMMARY_RESULTS_DIR / job_id / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="Job not found.")
    return JSONResponse(content=json.loads(status_path.read_text()))


@api_router.get("/summary/result/{job_id}/{filename:path}")
async def summary_result(job_id: str, filename: str):
    """Serve a summary artifact (summary.zip, report.html, images/…)."""
    if not _UUID4_RE.match(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id.")
    if "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    file_path = SUMMARY_RESULTS_DIR / job_id / filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Result file not found")
    if filename.endswith(".zip"):
        media = "application/zip"
    elif filename.endswith(".html"):
        media = "text/html"
    elif filename.endswith(".png"):
        media = "image/png"
    elif filename.endswith(".gz"):
        media = "application/gzip"
    else:
        media = "application/octet-stream"
    return FileResponse(path=str(file_path), media_type=media,
                        filename=os.path.basename(filename))


# ---- Spherical ROI builder ---------------------------------------------------

@api_router.post("/roi/sphere")
async def roi_sphere(
    x: float = Form(...),
    y: float = Form(...),
    z: float = Form(...),
    radius: float = Form(...),
    label: str = Form("roi"),
):
    """Rasterize a spherical ROI onto the bundled MNI152 grid and persist it.

    X/Y/Z are world (MNI) millimeters; radius is in millimeters. The mask is
    served by GET /api/roi/result/{result_id}/{filename} for download and for
    loading as an overlay in the viewer.
    """
    if radius <= 0:
        raise HTTPException(status_code=400, detail="Radius must be greater than 0.")

    ref_path = ATLAS_DIR / "mni152.nii.gz"
    if not ref_path.exists():
        raise HTTPException(status_code=503,
            detail="MNI152 reference template not found on server.")

    result_id = str(uuid.uuid4())
    slug = _safe_slug(label)
    filename = f"roi_{slug}.nii.gz"

    def _build():
        import numpy as np
        import nibabel as nib

        ref = nib.load(str(ref_path))
        affine = ref.affine
        shape = tuple(int(d) for d in ref.shape[:3])
        inv = np.linalg.inv(affine)

        center_vox = inv.dot(np.array([x, y, z, 1.0]))[:3]
        # Voxel size (mm) per axis, to bound the search box around the center.
        vox_sizes = np.sqrt((affine[:3, :3] ** 2).sum(axis=0))
        pad = np.ceil(radius / np.maximum(vox_sizes, 1e-6)).astype(int) + 1

        lo = np.maximum(np.floor(center_vox - pad).astype(int), 0)
        hi = np.minimum(np.ceil(center_vox + pad).astype(int), np.array(shape) - 1)
        if np.any(lo > hi):
            return None, 0  # sphere entirely outside the volume

        mask = np.zeros(shape, dtype=np.int16)
        ii, jj, kk = np.meshgrid(
            np.arange(lo[0], hi[0] + 1),
            np.arange(lo[1], hi[1] + 1),
            np.arange(lo[2], hi[2] + 1),
            indexing="ij",
        )
        vox = np.stack([ii.ravel(), jj.ravel(), kk.ravel(), np.ones(ii.size)], axis=0)
        world = affine.dot(vox)[:3].T  # (N, 3) in mm
        dist = np.sqrt(((world - np.array([x, y, z])) ** 2).sum(axis=1))
        inside = dist <= radius
        n_vox = int(inside.sum())
        if n_vox > 0:
            sel = vox[:3, inside].astype(int)
            mask[sel[0], sel[1], sel[2]] = 1

        result_dir = ROI_RESULTS_DIR / result_id
        result_dir.mkdir(parents=True, exist_ok=True)
        nib.save(nib.Nifti1Image(mask, affine), str(result_dir / filename))
        return str(result_dir / filename), n_vox

    try:
        saved_path, n_vox = await run_in_threadpool(_build)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ROI creation failed: {e}")

    if saved_path is None or n_vox == 0:
        raise HTTPException(status_code=422,
            detail="Sphere falls entirely outside the MNI152 volume — check the coordinates.")

    return {
        "id": result_id,
        "label": label,
        "voxels": n_vox,
        "file": f"/api/roi/result/{result_id}/{filename}",
    }


@api_router.get("/roi/result/{result_id}/{filename}")
async def roi_result(result_id: str, filename: str):
    """Serve a persisted spherical-ROI NIfTI for download / overlay loading."""
    if not _UUID4_RE.match(result_id):
        raise HTTPException(status_code=400, detail="Invalid result id.")
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    file_path = ROI_RESULTS_DIR / result_id / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Result file not found.")
    media = "application/gzip" if filename.endswith(".gz") else "application/octet-stream"
    return FileResponse(path=str(file_path), media_type=media, filename=filename)


# ---- Drawn-lesion persistence ------------------------------------------------
def _safe_slug(name: str) -> str:
    """Filesystem-safe slug for a user-supplied lesion/case name."""
    keep = "".join(c if (c.isalnum() or c in "-_") else "_" for c in (name or "").strip())
    keep = keep.strip("._") or "unnamed"
    return keep[:80]


@api_router.post("/lesions")
async def save_lesion(
    file: UploadFile = File(...),
    name: str = Form(...),
    base: str = Form(None),
):
    """Persist a drawn lesion (.nii.gz) uploaded from the browser. The bytes are
    stored on disk under LESION_DIR/<slug>/ and a metadata record is written to
    the MongoDB 'lesions' collection."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty lesion file.")

    slug = _safe_slug(name)
    dest_dir = LESION_DIR / slug
    dest_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    fpath = dest_dir / f"lesion_{ts}.nii.gz"
    fpath.write_bytes(data)

    doc = {
        "id": str(uuid.uuid4()),
        "name": name,
        "slug": slug,
        "base": base,
        "file": str(fpath),
        "bytes": len(data),
        "savedAt": datetime.now(timezone.utc).isoformat(),
    }
    await db.lesions.insert_one(dict(doc))  # copy: insert_one mutates with _id
    return {"ok": True, "id": doc["id"], "path": str(fpath), "bytes": len(data)}


@api_router.get("/lesions")
async def list_lesions():
    """List stored lesion metadata, most recent first."""
    cursor = db.lesions.find({}, {"_id": 0}).sort("savedAt", -1)
    return await cursor.to_list(length=1000)


# Include the router in the main app
app.include_router(api_router)

_cors_origins = os.environ.get('CORS_ORIGINS', '').split(',')
_allow_credentials = bool(_cors_origins and _cors_origins != [''])

app.add_middleware(
    CORSMiddleware,
    # Credentials (cookies/auth headers) require explicit origins — the
    # wildcard '*' is forbidden by the CORS spec when credentials are true.
    allow_credentials=_allow_credentials,
    allow_origins=_cors_origins if _allow_credentials else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    # Custom response headers must be explicitly exposed so the browser lets
    # JavaScript read them (allow_headers only governs request headers).
    expose_headers=["X-Registration-Metric", "X-Same-Grid", "X-Changed-Voxel-Pct",
                    "X-Input-Streamlines", "X-Output-Streamlines",
                    "X-Dissect-Selected", "X-Dissect-Input"],
)

# Serve the built React app from the same origin as the API (production /
# container). Mounted AFTER the /api router so API routes always win. This makes
# any URL path open the app and removes CORS concerns in prod. Skipped in dev
# when no build exists (the CRA dev server on :3000 serves the UI instead).
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

    @app.exception_handler(404)
    async def _spa_fallback(request, exc):  # noqa: ANN001
        # API 404s stay JSON; unknown non-API GET paths fall back to index.html
        # so client-side routes resolve to the app shell.
        if request.url.path.startswith("/api"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        index = STATIC_DIR / "index.html"
        if request.method == "GET" and index.exists():
            return FileResponse(str(index))
        return JSONResponse({"detail": "Not Found"}, status_code=404)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()