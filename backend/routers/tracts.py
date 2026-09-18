# Auto-split from server.py — tracts endpoints.
from fastapi import APIRouter
from deps import *  # noqa: F401,F403 (shared config, models, helpers)

router = APIRouter()


@router.get("/tracts/subsample/available")
async def tract_subsample_available():
    try:
        import nibabel  # noqa: F401
        return {"available": True}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "reason": str(e)}
@router.post("/tracts/subsample")
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
@router.get("/tracts/dissect/available")
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
@router.post("/tracts/dissect")
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
        lesion_path = save_upload_nifti(file, workdir)

        config = {
            "lesion_path":       str(lesion_path),
            "result_id":         result_id,
            "global_tract_file": str(GLOBAL_TRACT_FILE),
            "tract_results_dir": str(TRACT_RESULTS_DIR),
            "atlas_dir":         str(ATLAS_DIR),
            "atlas_specs":       _atlas_specs_for(atlas),
            # Extra sys.path entries the worker subprocess wouldn't otherwise
            # see — see worker_common.extra_sys_path_for_worker.
            "sys_path":          extra_sys_path_for_worker(),
        }
        (workdir / "config.json").write_text(json.dumps(config))

        # Run the worker as a blocking subprocess inside a worker thread. This
        # works on any event loop: asyncio.create_subprocess_exec raises
        # NotImplementedError under uvicorn --reload on Windows (its
        # SelectorEventLoop has no subprocess support), whereas subprocess.run
        # does not depend on the asyncio child watcher. Process isolation — a
        # DIPY crash/OOM killing only the worker — is preserved either way.
        # PERF-TODO: this worker reloads the global tractogram (.trk) from disk on
        # every request. Since it runs as a fresh subprocess there is no cross-
        # request cache; caching would require pulling the load into the long-lived
        # uvicorn process (lru_cache + in-process compute). Deferred until the real
        # data files are available to benchmark against. See the perf report.
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
@router.post("/tracts/dissect/between")
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
        # Distinct stems avoid collision when both uploads share a basename;
        # each extension (.nii/.nii.gz) is chosen from the file's real magic bytes.
        path_a = save_upload_nifti(file_a, workdir, stem="lesion_a")
        path_b = save_upload_nifti(file_b, workdir, stem="lesion_b")

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
            # Extra sys.path entries the worker subprocess wouldn't otherwise
            # see — see worker_common.extra_sys_path_for_worker.
            "sys_path":         extra_sys_path_for_worker(),
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
# ── Pollable job variants (progress bar) ─────────────────────────────────────
# Same compute as /tracts/dissect and /tracts/dissect/between, but run as a
# background job whose worker streams staged progress into status.json. The
# frontend polls /status/{job_id} for a progress bar, then reads the full result
# (identical shape to the synchronous endpoints) from status['result'] on done.
@router.post("/tracts/dissect/start")
async def tract_dissect_start(
    file: UploadFile = File(...),
    name: str = Form(""),
    atlas: str = Form("harvard_oxford"),
):
    if not GLOBAL_TRACT_FILE.exists():
        raise HTTPException(status_code=503,
            detail="Global tract file not configured. Set GLOBAL_TRACT_FILE env var.")
    filename = os.path.basename(file.filename or "lesion.nii.gz").lower()
    if not (filename.endswith(".nii") or filename.endswith(".nii.gz")):
        raise HTTPException(status_code=400, detail="Lesion file must be .nii or .nii.gz")

    job_id    = str(uuid.uuid4())
    result_id = str(uuid.uuid4())
    job_dir   = DISSECT_JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    lesion_path = save_upload_nifti(file, job_dir)

    config = {
        "lesion_path":       str(lesion_path),
        "result_id":         result_id,
        "global_tract_file": str(GLOBAL_TRACT_FILE),
        "tract_results_dir": str(TRACT_RESULTS_DIR),
        "atlas_dir":         str(ATLAS_DIR),
        "atlas_specs":       _atlas_specs_for(atlas),
    }
    set_job_status(job_dir, stage="queued", message="Queued…",
                   progress=0.0, done=False, error=None)
    task = asyncio.create_task(_run_single_worker_job(
        job_id, job_dir, WORKER_SCRIPT, config, 600,
        "Dissection timed out (>10 min). The tractogram may be too large for available RAM."))
    _JOB_TASKS[job_id] = task
    return {"job_id": job_id}
@router.post("/tracts/dissect/between/start")
async def tract_dissect_between_start(
    file_a: UploadFile = File(...),
    file_b: UploadFile = File(...),
    mode_a: str = Form("through"),
    mode_b: str = Form("through"),
    atlas: str = Form("harvard_oxford"),
):
    if not GLOBAL_TRACT_FILE.exists():
        raise HTTPException(status_code=503,
            detail="Global tract file not configured. Set GLOBAL_TRACT_FILE env var.")

    def _valid_ext(fname: str) -> bool:
        n = os.path.basename(fname or "x").lower()
        return n.endswith(".nii") or n.endswith(".nii.gz")

    if not _valid_ext(file_a.filename) or not _valid_ext(file_b.filename):
        raise HTTPException(status_code=400,
            detail="Both lesion files must be .nii or .nii.gz")

    def _norm_mode(m: str) -> str:
        return "end" if (m or "").strip().lower() in ("start", "terminate", "end") else "through"

    job_id    = str(uuid.uuid4())
    result_id = str(uuid.uuid4())
    job_dir   = DISSECT_JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    path_a = save_upload_nifti(file_a, job_dir, stem="lesion_a")
    path_b = save_upload_nifti(file_b, job_dir, stem="lesion_b")

    config = {
        "lesion_path_a":     str(path_a),
        "lesion_path_b":     str(path_b),
        "result_id":         result_id,
        "global_tract_file": str(GLOBAL_TRACT_FILE),
        "tract_results_dir": str(TRACT_RESULTS_DIR),
        "atlas_dir":         str(ATLAS_DIR),
        "atlas_specs":       _atlas_specs_for(atlas),
        "mode_a":            _norm_mode(mode_a),
        "mode_b":            _norm_mode(mode_b),
    }
    set_job_status(job_dir, stage="queued", message="Queued…",
                   progress=0.0, done=False, error=None)
    task = asyncio.create_task(_run_single_worker_job(
        job_id, job_dir, DISSECT_BETWEEN_WORKER_SCRIPT, config, 600,
        "Between-dissection timed out (>10 min)."))
    _JOB_TASKS[job_id] = task
    return {"job_id": job_id}
@router.get("/tracts/dissect/status/{job_id}")
async def tract_dissect_status(job_id: str):
    """Poll a dissection job's progress (stage, progress, done, result?)."""
    return JSONResponse(content=_read_job_status(DISSECT_JOBS_DIR, job_id))
@router.post("/tracts/dissect/cancel/{job_id}")
async def tract_dissect_cancel(job_id: str):
    """Cancel a running dissection job (kills the worker subprocess)."""
    return _cancel_job(DISSECT_JOBS_DIR, job_id)
@router.get("/tracts/dissect/result/{result_id}/{filename}")
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
