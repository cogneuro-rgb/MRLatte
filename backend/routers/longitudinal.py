# Auto-split from server.py — longitudinal endpoints.
from fastapi import APIRouter
from deps import *  # noqa: F401,F403 (shared config, models, helpers)

router = APIRouter()


@router.get("/longitudinal/available")
async def longitudinal_available():
    # Looked up, not imported: opening the panel must not put the module in use.
    if package_present("SimpleITK"):
        return {"available": True}
    return {"available": False, "reason": SIMPLEITK_MISSING}
@router.post("/longitudinal/register")
async def longitudinal_register(
    baseline: UploadFile = File(...), followup: UploadFile = File(...)
):
    if not package_present("SimpleITK"):
        raise HTTPException(status_code=503, detail=SIMPLEITK_MISSING)

    workdir = Path(tempfile.mkdtemp(prefix="nv_long_"))

    def _cleanup():
        shutil.rmtree(workdir, ignore_errors=True)

    try:
        bpath = workdir / (os.path.basename(baseline.filename or "baseline.nii.gz"))
        fpath = workdir / (os.path.basename(followup.filename or "followup.nii.gz"))
        bpath.write_bytes(await baseline.read())
        fpath.write_bytes(await followup.read())
        out_path = workdir / "difference.nii.gz"
        metrics = await run_in_threadpool(
            _run_worker_json, LONGITUDINAL_WORKER_SCRIPT,
            {"baseline": str(bpath), "followup": str(fpath), "out": str(out_path)},
            workdir, 600)
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
