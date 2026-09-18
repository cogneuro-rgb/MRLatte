# Auto-split from server.py — lnm endpoints.
from fastapi import APIRouter
from deps import *  # noqa: F401,F403 (shared config, models, helpers)

router = APIRouter()


@router.get("/lnm/available")
async def lnm_available():
    """Report whether the DaLn mapper can run (deps + bundle present)."""
    try:
        import numpy  # noqa: F401
        import nibabel  # noqa: F401
        from worker_common import resample_to_img  # noqa: F401
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"Missing dependency: {e}"}
    if not LNM_BUNDLE.exists():
        return {"ok": False, "reason": "Connectome bundle not found. Set LNM_BUNDLE env var.",
                "bundle_present": False}
    return {"ok": True, "bundle_present": True}
@router.post("/lnm/compute")
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
        lesion_path = save_upload_nifti(file, workdir)

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
            # Extra sys.path entries the worker subprocess wouldn't otherwise
            # see — see worker_common.extra_sys_path_for_worker.
            "sys_path":        extra_sys_path_for_worker(),
        }
        (workdir / "config.json").write_text(json.dumps(config))

        # PERF-TODO: reloads the connectome bundle (.npz) per request; same
        # subprocess-isolation caveat as the tract worker — an in-process
        # lru_cache load is the fix once the bundle is available to benchmark.
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
# ── Pollable job variant (progress bar) ──────────────────────────────────────
# Same compute as /lnm/compute, but run as a background job whose worker streams
# staged progress (including the specificity permutation %) into status.json.
# The frontend polls /lnm/status/{job_id} for a progress bar, then reads the
# full result (identical shape to /lnm/compute) from status['result'] on done.
@router.post("/lnm/start")
async def lnm_start(
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
    if not LNM_BUNDLE.exists():
        raise HTTPException(status_code=503,
            detail="Connectome bundle not configured. Set LNM_BUNDLE env var.")
    filename = os.path.basename(file.filename or "lesion.nii.gz").lower()
    if not (filename.endswith(".nii") or filename.endswith(".nii.gz")):
        raise HTTPException(status_code=400, detail="Lesion file must be .nii or .nii.gz")
    if metric not in ("t", "z"):
        raise HTTPException(status_code=400, detail="metric must be 't' or 'z'")

    job_id    = str(uuid.uuid4())
    result_id = str(uuid.uuid4())
    job_dir   = LNM_JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    lesion_path = save_upload_nifti(file, job_dir)

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
    set_job_status(job_dir, stage="queued", message="Queued…",
                   progress=0.0, done=False, error=None)
    task = asyncio.create_task(_run_single_worker_job(
        job_id, job_dir, LNM_WORKER_SCRIPT, config, 900,
        "Lesion network mapping timed out (>15 min). Try lowering nperm or switching to the z metric."))
    _JOB_TASKS[job_id] = task
    return {"job_id": job_id}
@router.get("/lnm/status/{job_id}")
async def lnm_status(job_id: str):
    """Poll an LNM job's progress (stage, progress, done, result?)."""
    return JSONResponse(content=_read_job_status(LNM_JOBS_DIR, job_id))
@router.post("/lnm/cancel/{job_id}")
async def lnm_cancel(job_id: str):
    """Cancel a running LNM job (kills the worker subprocess)."""
    return _cancel_job(LNM_JOBS_DIR, job_id)
@router.get("/lnm/result/{result_id}/{filename}")
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
