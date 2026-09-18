"""Lesion-metrics HTTP surface: lqtpy-backed volume + atlas-overlap numbers.

This is the fast, in-process replacement for the JavaScript lesion-metrics
math (frontend/src/lib/lesionReport.js, volumeAnalysis.js) — no subprocess
worker, no job/poll dance (contrast routers/tracts.py, routers/lnm.py): the
numpy work here is milliseconds per call, not minutes, so it runs directly on
FastAPI's threadpool. See backend/lesion_metrics.py for the engine
(atlas bridging, lqtpy call, exception mapping) this router is a thin HTTP
wrapper over.

Handlers below are declared `def`, not `async def`, on purpose: FastAPI runs
a sync path-operation function in its threadpool automatically, which keeps
lqtpy's numpy/scipy work off the asyncio event loop without any explicit
run_in_threadpool call — the same reasoning as the sync `_build()` closures
in routers/roi.py, just without the extra indirection since there's no
long-lived job to track.
"""
import hashlib
import logging
import os
import re
import time
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from deps import LESION_JOBS_DIR

import lesion_metrics as engine

router = APIRouter()
logger = logging.getLogger(__name__)

# sha256 hex digest — the content-addressed lesion id. Same "validate with a
# regex before it ever touches a path" idiom as deps._UUID4_RE / result_id.
_LESION_ID_RE = re.compile(r'^[0-9a-f]{64}$')


def _resolve_lesion_path(lesion_id: str) -> Path:
    if not _LESION_ID_RE.match(lesion_id or ""):
        raise HTTPException(status_code=400, detail="Invalid lesion id.")
    for ext in (".nii.gz", ".nii"):
        p = LESION_JOBS_DIR / f"{lesion_id}{ext}"
        if p.exists():
            return p
    raise HTTPException(status_code=404, detail="Unknown lesion id.")


@router.post("/lesion/upload")
def lesion_upload(file: UploadFile = File(...)):
    """Store an uploaded NIfTI content-addressed by sha256 of its raw bytes.

    Re-uploading identical bytes returns the same lesion_id without
    rewriting the file (write is skip-if-exists, not merely idempotent —
    avoids re-writing a possibly-large file that's already on disk byte for
    byte). Extension (.nii vs .nii.gz) is sniffed from the gzip magic bytes,
    the same way deps.save_upload_nifti does it, not trusted from the
    client-supplied filename.
    """
    data = file.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    digest = hashlib.sha256(data).hexdigest()
    ext = ".nii.gz" if data[:2] == b"\x1f\x8b" else ".nii"

    LESION_JOBS_DIR.mkdir(parents=True, exist_ok=True)
    dest = LESION_JOBS_DIR / f"{digest}{ext}"
    if not dest.exists():
        # Write-then-rename: a half-written file from a crashed/duplicate
        # upload can never be mistaken for a complete one under this id.
        tmp = dest.with_name(dest.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, dest)

    return {"lesion_id": digest, "bytes": len(data), "filename": dest.name}


class LesionMetricsRequest(BaseModel):
    lesion_id: str
    atlas_ids: List[str] = []
    threshold: Optional[float] = None


@router.post("/lesion/metrics")
def lesion_metrics_endpoint(payload: LesionMetricsRequest):
    """Lesion morphometry + per-atlas overlap, computed by lqtpy.

    Status codes: 404 unknown lesion_id, 400 invalid lesion_id / unknown
    atlas_id / lqtpy caller error (bad lesion input), 503 lqtpy not
    installed, 500 lqtpy environment error (missing data file/dependency).
    """
    lesion_path = _resolve_lesion_path(payload.lesion_id)
    threshold = (payload.threshold if payload.threshold is not None
                 else engine.DEFAULT_THRESHOLD)

    t0 = time.monotonic()
    error_status = None
    try:
        result = engine.compute_metrics(lesion_path, payload.atlas_ids, threshold)
        return result
    except engine.LqtpyUnavailableError as exc:
        error_status = 503
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except engine.LesionMetricsError as exc:
        error_status = exc.status_code
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — lqtpy's own typed errors land here
        error_status = engine.status_code_for(exc)
        raise HTTPException(status_code=error_status, detail=str(exc)) from exc
    finally:
        # Per-request timing log — the plan requires MEASURED latency, not an
        # assumption that "in-process" implies fast.
        duration_ms = (time.monotonic() - t0) * 1000.0
        logger.info(
            "lesion metrics lesion_id=%s atlas_ids=%s threshold=%s "
            "duration_ms=%.2f status=%s",
            payload.lesion_id, payload.atlas_ids, threshold,
            duration_ms, error_status or 200,
        )


class ReportFragmentsRequest(BaseModel):
    lesion_id: str
    atlas_ids: List[str] = []
    sections: List[str]
    threshold: Optional[float] = None
    theme: Optional[dict] = None


@router.post("/lesion/report-fragments")
def lesion_report_fragments_endpoint(payload: ReportFragmentsRequest):
    """lqtpy's embeddable HTML fragments (morphometry detail, network rollup,
    streamline disconnection, and -- if a caller asks -- parcel damage /
    tract-overlap proxy) for sections MRLatte doesn't render itself. See
    backend/lesion_metrics.py::build_report_fragments for the engine.

    Status codes mirror /lesion/metrics: 404 unknown lesion_id, 400 invalid
    lesion_id / unknown section id / unknown atlas id / bad theme colour /
    lqtpy caller error (bad lesion input), 503 lqtpy not installed, 500 lqtpy
    environment error (missing data file/dependency).
    """
    lesion_path = _resolve_lesion_path(payload.lesion_id)
    threshold = (payload.threshold if payload.threshold is not None
                 else engine.DEFAULT_THRESHOLD)

    t0 = time.monotonic()
    error_status = None
    try:
        result = engine.build_report_fragments(
            lesion_path, payload.atlas_ids, payload.sections,
            threshold=threshold, theme=payload.theme,
        )
        return result
    except engine.LqtpyUnavailableError as exc:
        error_status = 503
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except engine.LesionMetricsError as exc:
        error_status = exc.status_code
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — lqtpy's own typed errors land here
        error_status = engine.status_code_for(exc)
        raise HTTPException(status_code=error_status, detail=str(exc)) from exc
    finally:
        duration_ms = (time.monotonic() - t0) * 1000.0
        logger.info(
            "lesion report-fragments lesion_id=%s atlas_ids=%s sections=%s threshold=%s "
            "duration_ms=%.2f status=%s",
            payload.lesion_id, payload.atlas_ids, payload.sections, threshold,
            duration_ms, error_status or 200,
        )


@router.get("/lesion/capabilities")
def lesion_capabilities():
    """Whether the lqtpy engine is usable right now, and on what atlases."""
    if not engine.available():
        return {
            "available": False,
            "version": None,
            "disconnection_index_available": False,
            "atlas_ids": [],
            "reason": str(engine.import_error()) if engine.import_error() else None,
        }
    return {
        "available": True,
        "version": engine.version(),
        "disconnection_index_available": engine.disconnection_index_available(),
        "atlas_ids": engine.bridged_atlas_ids(),
    }
