# Auto-split from server.py — status / desktop-download endpoints.
from fastapi import APIRouter
from deps import *  # noqa: F401,F403 (shared config, models, helpers)

router = APIRouter()


@router.get("/")
async def root():
    return {"message": "Hello World"}
@router.get("/download/desktop")
async def download_desktop_zip():
    """Stream the latest Windows desktop build (.zip) to the browser."""
    if not DESKTOP_ARTIFACTS_DIR.exists():
        raise HTTPException(status_code=404, detail="No desktop build found. Run `yarn dist:win` in /app/frontend.")
    candidates = sorted(DESKTOP_ARTIFACTS_DIR.glob("MRLatte-*-x64.zip"))
    if not candidates:
        raise HTTPException(status_code=404, detail="Windows .zip artefact not found in dist-electron/.")
    artefact = candidates[-1]  # latest by name (version order)
    return FileResponse(
        path=str(artefact),
        media_type="application/zip",
        filename=artefact.name,
    )
@router.get("/download/desktop/info")
async def download_desktop_info():
    """Lightweight metadata about the available desktop build."""
    if not DESKTOP_ARTIFACTS_DIR.exists():
        return {"available": False, "reason": "dist-electron/ not found"}
    candidates = sorted(DESKTOP_ARTIFACTS_DIR.glob("MRLatte-*-x64.zip"))
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
