# Auto-split from server.py — validation endpoints.
from fastapi import APIRouter
from deps import *  # noqa: F401,F403 (shared config, models, helpers)

router = APIRouter()


@router.get("/validation/report")
async def get_validation_report():
    """Return the text validation report comparing produced vs expected ranges."""
    if not VALIDATION_REPORT.exists():
        raise HTTPException(status_code=404, detail="Validation report not found.")
    return FileResponse(
        path=str(VALIDATION_REPORT),
        media_type="text/plain",
        filename=VALIDATION_REPORT.name,
    )
@router.get("/validation/plots")
async def list_validation_plots():
    """List the validation plot PNGs (surface vs MNI projection side-by-side)."""
    if not VALIDATION_DIR.exists():
        return {"plots": []}
    files = sorted([p.name for p in VALIDATION_DIR.glob("*.png")])
    return {"plots": files, "endpoint_template": "/api/validation/plots/{name}"}
@router.get("/validation/plots/{name}")
async def get_validation_plot(name: str):
    safe = (VALIDATION_DIR / name).resolve()
    if VALIDATION_DIR.resolve() not in safe.parents or not safe.exists():
        raise HTTPException(status_code=404, detail="Plot not found.")
    return FileResponse(path=str(safe), media_type="image/png", filename=name)
@router.get("/validation/check")
async def run_atlas_validation():
    """Run quantitative pass/fail checks on each MNI152 atlas .nii.gz file."""
    try:
        return await run_in_threadpool(_run_atlas_checks, ATLAS_DIR)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Atlas check failed: {e}")
@router.get("/validation/round-trip")
async def run_round_trip_validation():
    """Round-trip fidelity + neuropythy reference validation (runs in ~10-30 s)."""
    # In a worker: neuropythy and nilearn are one-click modules, and importing
    # them here would keep them in use until restart (validation_worker.py).
    workdir = Path(tempfile.mkdtemp(prefix="nv_validate_"))
    try:
        # validate_round_trip.py sits beside validation_plots/: tools/scripts in
        # a checkout, resources/scripts in an install (both set VALIDATION_DIR).
        scripts_dir = str(VALIDATION_DIR.parent)
        return await run_in_threadpool(
            _run_worker_json, VALIDATION_WORKER_SCRIPT,
            {"scripts_dir": scripts_dir, "atlas_dir": str(ATLAS_DIR)}, workdir, 300)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Round-trip validation failed: {e}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
