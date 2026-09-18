# Auto-split from server.py — summary endpoints.
from fastapi import APIRouter, Query
from deps import *  # noqa: F401,F403 (shared config, models, helpers)

from routers.modules import module_snapshot, module_by_id

router = APIRouter()


@router.get("/summary/available")
async def summary_available():
    """Report whether the summary renderer can run (nilearn present).

    Phase 3: this is now a thin shim over /api/modules — `ok` mirrors the
    `reports-figures` module and dissect/lnm mirror the `dissect`/`lnm`
    capabilities. The response SHAPE is unchanged ({ok, dissect, lnm} on
    success, {ok: False, reason} when the plotting stack is missing) so every
    existing caller (frontend/src/lib/summary.js) keeps working untouched.
    """
    snap = module_snapshot()
    reports = module_by_id("reports-figures", snap)
    if reports is None:
        # Manifest missing or malformed — fall back to the original direct
        # import probe rather than reporting a false negative.
        try:
            import nibabel  # noqa: F401
            from nilearn import plotting  # noqa: F401
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "reason": f"Missing dependency: {e}"}
        return {"ok": True,
                "dissect": GLOBAL_TRACT_FILE.exists(),
                "lnm": LNM_BUNDLE.exists()}

    if not reports["installed"]:
        missing = ", ".join(reports.get("missing") or []) or reports["name"]
        return {"ok": False, "reason": f"Missing dependency: {missing}"}

    caps = snap["capabilities"]
    return {"ok": True,
            "dissect": bool(caps.get("dissect")),
            "lnm": bool(caps.get("lnm"))}
@router.post("/summary/run")
async def summary_run(file: UploadFile = File(...), payload: str = Form("{}")):
    """Kick off the One-Click Summary pipeline; returns a job id to poll.

    `payload` (JSON-encoded, no Pydantic model -- see deps._run_summary_job
    for every field it reads) includes:
      * `atlas_ids` (list[str]) -- atlases to overlap the lesion against.
        The backend computes the overlap model itself, in-process via lqtpy
        (backend/lesion_metrics.py), before dispatching any worker.
      * `overlapModel` -- DEPRECATED, kept for one release as a fallback ONLY
        for when lqtpy is unavailable server-side. Ignored (and logged as
        ignored) whenever lqtpy is available; do not send new client-computed
        overlap models going forward -- send `atlas_ids` instead.
    """
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
    task = asyncio.create_task(_run_summary_job(job_id, lesion_path, payload_obj))
    _SUMMARY_TASKS[job_id] = task
    return {"job_id": job_id}
@router.post("/summary/cancel/{job_id}")
async def summary_cancel(job_id: str):
    """Cancel a running summary job: kills the active worker subprocess (if
    any) and marks the job cancelled so the pipeline stops between stages.
    Idempotent — safe to call after the job has already finished."""
    if not _UUID4_RE.match(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id.")
    status_path = SUMMARY_RESULTS_DIR / job_id / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="Job not found.")
    current = json.loads(status_path.read_text())
    if current.get("done"):
        return {"ok": True, "already_done": True, "stage": current.get("stage")}
    request_summary_cancel(job_id)
    return {"ok": True, "already_done": False}
@router.get("/summary/status/{job_id}")
async def summary_status(job_id: str):
    """Poll a summary job's progress."""
    if not _UUID4_RE.match(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id.")
    status_path = SUMMARY_RESULTS_DIR / job_id / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="Job not found.")
    return JSONResponse(content=json.loads(status_path.read_text()))
@router.get("/summary/result/{job_id}/{filename:path}")
async def summary_result(job_id: str, filename: str):
    """Serve a summary artifact by raw path (brainsprite_*.html, images/…, maps/…)."""
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
def _summary_artifact_map(job_id: str) -> dict:
    """rel -> manifest entry for a job, sourced from status.json's `files`
    (persisted verbatim from the render worker's JSON result) rather than
    recomputed by walking the directory, so the manifest the picker saw and
    the files this route will actually serve can never disagree. {} if the
    job doesn't exist yet or hasn't produced a manifest."""
    status_path = SUMMARY_RESULTS_DIR / job_id / "status.json"
    if not status_path.exists():
        return {}
    try:
        current = json.loads(status_path.read_text())
    except Exception:  # noqa: BLE001
        return {}
    artifacts = (current.get("files") or {}).get("artifacts") or []
    return {a["rel"]: a for a in artifacts if a.get("rel")}
@router.get("/summary/artifacts/{job_id}")
async def summary_artifacts(job_id: str):
    """List the artifacts a summary job produced, for the frontend's
    selective-download picker (replaces the old zip-everything summary.zip)."""
    if not _UUID4_RE.match(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id.")
    status_path = SUMMARY_RESULTS_DIR / job_id / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="Job not found.")
    manifest = _summary_artifact_map(job_id)
    return {"job_id": job_id, "artifacts": list(manifest.values())}
@router.get("/summary/download/{job_id}")
async def summary_download(job_id: str, p: List[str] = Query(default=[])):
    """Selective download of summary artifacts. One `p` streams that file
    directly; two or more are zipped together and streamed as
    summary_<job_id>.zip. Every `p` must be an exact match against the job's
    artifact manifest — stronger than a path-traversal check, since it also
    rejects real files the worker never declared (the uploaded lesion input,
    status.json)."""
    if not _UUID4_RE.match(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id.")
    if not p:
        raise HTTPException(status_code=400, detail="No files requested (pass ?p=<rel>).")
    manifest = _summary_artifact_map(job_id)
    if not manifest:
        raise HTTPException(status_code=404, detail="Job not found or has no artifacts.")
    for rel in p:
        if rel not in manifest:
            raise HTTPException(status_code=404, detail=f"Unknown artifact: {rel}")

    job_dir = SUMMARY_RESULTS_DIR / job_id

    if len(p) == 1:
        rel = p[0]
        file_path = job_dir / rel
        if not file_path.exists() or not file_path.is_file():
            raise HTTPException(status_code=404, detail="Result file not found")
        if rel.endswith(".html"):
            media = "text/html"
        elif rel.endswith(".png"):
            media = "image/png"
        elif rel.endswith(".gz"):
            media = "application/gzip"
        elif rel.endswith(".csv"):
            media = "text/csv"
        else:
            media = "application/octet-stream"
        return FileResponse(path=str(file_path), media_type=media,
                            filename=os.path.basename(rel))

    # Multiple files: build the zip on disk (never fully in memory) and stream
    # it back via FileResponse, deleting the temp file once it's been sent.
    fd, tmp_name = tempfile.mkstemp(suffix=".zip", prefix=f"summary_{job_id}_")
    os.close(fd)
    tmp_path = Path(tmp_name)
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in p:
            file_path = job_dir / rel
            if file_path.exists() and file_path.is_file():
                zf.write(file_path, rel)
    return FileResponse(
        path=str(tmp_path), media_type="application/zip",
        filename=f"summary_{job_id}.zip",
        background=BackgroundTask(lambda: tmp_path.unlink(missing_ok=True)),
    )
