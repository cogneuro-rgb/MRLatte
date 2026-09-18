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
    try:
        scripts_dir = str(Path(__file__).parent.parent / "scripts")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        from validate_round_trip import run as _rt_run
        return await run_in_threadpool(_rt_run, ATLAS_DIR)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Round-trip validation failed: {e}")
