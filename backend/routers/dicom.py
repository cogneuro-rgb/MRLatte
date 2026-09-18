# Auto-split from server.py — dicom endpoints.
from fastapi import APIRouter
from deps import *  # noqa: F401,F403 (shared config, models, helpers)

router = APIRouter()


@router.get("/convert/dicom/available")
async def dicom_convert_available():
    """Report whether server-side DICOM conversion is usable."""
    exe = shutil.which("dcm2niix")
    return {"available": bool(exe), "dcm2niix": exe}
@router.post("/convert/dicom")
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
@router.get("/convert/dicom/result/{job_id}/{series_id}")
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
