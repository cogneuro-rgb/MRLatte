"""App entrypoint: wires the FastAPI app, CORS, static mount, and every
per-domain router. Endpoint implementations live in routers/*.py; shared
config/models/helpers live in deps.py. Run with `uvicorn server:app`."""
import logging
import os
import warnings
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

from deps import ATLAS_DIR, STATIC_DIR, cleanup_old_tract_results

from routers.status import router as status_router
from routers.modules import router as modules_router
from routers.validation import router as validation_router
from routers.dicom import router as dicom_router
from routers.longitudinal import router as longitudinal_router
from routers.tracts import router as tracts_router
from routers.lnm import router as lnm_router
from routers.summary import router as summary_router
from routers.roi import router as roi_router
from routers.atlases import router as atlases_router
from routers.lesion_metrics import router as lesion_metrics_router

# SciPy warns, once per call, that `affine_transform` changed how it treats a
# 1-D `matrix` back in 0.18. Passing the diagonal as 1-D is deliberate in the
# resampler (worker_common.resample_to_img, and lqtpy's vendored copy): it
# selects scipy's faster zoom_shift path, which is what nilearn does too. The
# warning is therefore pure noise that would otherwise print on every overlap
# request. Filtering it belongs HERE, in the application: an app may set
# warning filters, a library may not — which is why neither resampler
# suppresses it itself (a warnings.catch_warnings() on a hot path would also
# mutate global filter state under FastAPI's threadpool).
warnings.filterwarnings(
    "ignore",
    message="The behavior of affine_transform with a 1-D array supplied",
    category=UserWarning,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Prune stale dissection results on real server startup only. This used to
    # run as an import side effect in deps.py, which meant any `import server`
    # — a test, a lint, an editor's autocomplete — permanently deleted every
    # result directory older than 24h.
    try:
        cleanup_old_tract_results()
    except OSError as exc:  # never block startup on housekeeping
        # logging is configured further down this module, so resolve the logger
        # here rather than closing over a name defined after this function.
        logging.getLogger(__name__).warning("tract-results cleanup skipped: %s", exc)

    # Warm the lqtpy atlas bridge so the first /api/lesion/metrics request
    # doesn't pay atlas-load cost. Fail-soft on every axis (lqtpy absent, an
    # atlas failing to load, or the whole pass erroring) — see
    # lesion_metrics.preload()'s docstring — and bounded so a slow/hanging
    # atlas load can never stall startup indefinitely.
    try:
        import lesion_metrics as _lesion_metrics
        import asyncio
        info = await asyncio.wait_for(
            asyncio.to_thread(_lesion_metrics.preload), timeout=30.0)
        logging.getLogger(__name__).info(
            "lesion-metrics preload: available=%s atlases=%s duration_s=%.3f%s",
            info["available"], info["atlas_ids"], info["duration_s"],
            f" error={info['error']}" if info.get("error") else "")
    except asyncio.TimeoutError:
        logging.getLogger(__name__).warning(
            "lesion-metrics preload exceeded 30s, continuing without it")
    except Exception as exc:  # noqa: BLE001 — never block startup on this
        logging.getLogger(__name__).warning(
            "lesion-metrics preload skipped: %s", exc)

    yield


app = FastAPI(lifespan=lifespan)

api_router = APIRouter(prefix="/api")
for _r in (status_router, modules_router, validation_router, dicom_router,
           longitudinal_router, tracts_router, lnm_router, summary_router,
           roi_router, atlases_router, lesion_metrics_router):
    api_router.include_router(_r)
app.include_router(api_router)

_cors_origins = os.environ.get('CORS_ORIGINS', '').split(',')
_allow_credentials = bool(_cors_origins and _cors_origins != [''])

app.add_middleware(
    CORSMiddleware,
    # Credentials (cookies/auth headers) require explicit origins — the
    # wildcard '*' is forbidden by the CORS spec when credentials are true.
    allow_credentials=_allow_credentials,
    allow_origins=_cors_origins if _allow_credentials else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    # Custom response headers must be explicitly exposed so the browser lets
    # JavaScript read them (allow_headers only governs request headers).
    expose_headers=["X-Registration-Metric", "X-Same-Grid", "X-Changed-Voxel-Pct",
                    "X-Input-Streamlines", "X-Output-Streamlines",
                    "X-Dissect-Selected", "X-Dissect-Input"],
)

# Atlases resolve under the module root (MRLATTE_MODULE_ROOT), which is outside
# STATIC_DIR, so the static mount below can no longer reach them. Serve them at
# the URL the frontend already hardcodes (frontend/src/lib/atlasConfig.js), which
# therefore needs no change.
#
# ORDER MATTERS: the "/" mount below is a catch-all and Starlette matches routes
# in registration order — this mount must stay ABOVE it or it never sees a
# request.
#
# The directory is CREATED rather than probed. This mount happens once, at
# startup, and StaticFiles raises on a missing directory — so an empty module
# root used to leave /atlases unmounted for the life of the process, and the
# first atlas installed through the Atlas Manager was unreachable until a
# restart. mkdir costs nothing and removes that whole class of bug.
ATLAS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/atlases", StaticFiles(directory=str(ATLAS_DIR)), name="atlases")

# Serve the built React app from the same origin as the API (production /
# container). Mounted AFTER the /api router so API routes always win. This makes
# any URL path open the app and removes CORS concerns in prod. Skipped in dev
# when no build exists (the CRA dev server on :3000 serves the UI instead).
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

    @app.exception_handler(404)
    async def _spa_fallback(request, exc):  # noqa: ANN001
        # API 404s stay JSON; unknown non-API GET paths fall back to index.html
        # so client-side routes resolve to the app shell.
        if request.url.path.startswith("/api"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        index = STATIC_DIR / "index.html"
        if request.method == "GET" and index.exists():
            return FileResponse(str(index))
        return JSONResponse({"detail": "Not Found"}, status_code=404)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)
