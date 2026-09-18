# Auto-split from server.py — longitudinal endpoints.
from fastapi import APIRouter
from deps import *  # noqa: F401,F403 (shared config, models, helpers)

router = APIRouter()


@router.get("/longitudinal/available")
async def longitudinal_available():
    try:
        import SimpleITK  # noqa: F401
        return {"available": True}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "reason": str(e)}
@router.post("/longitudinal/register")
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
