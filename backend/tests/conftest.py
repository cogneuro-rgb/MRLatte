"""Test bootstrap: put `backend/` on sys.path, and keep importing it from
writing anywhere near the repo tree.

pytest inserts the *test file's* directory (backend/tests) on sys.path when
there is no package __init__.py, which is not where `deps` / `server` /
`routers` live. Everything under backend/ imports its siblings flat
(`from deps import *`, `from routers.status import router`), so the backend
directory itself has to be on the path.

`deps` also mkdir()s six result/job directories at import time and runs
`_cleanup_old_tract_results()`, which deletes >24h-old subdirectories of
backend/tract_results. Merely importing the app must not touch a developer's
working tree, so every one of those roots is redirected into a throwaway temp
directory before the import happens.
"""
import os
import sys
import tempfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_SCRATCH = Path(tempfile.mkdtemp(prefix="mrlatte-tests-"))
for _var in ("TRACT_RESULTS_DIR", "ROI_RESULTS_DIR", "DICOM_RESULTS_DIR",
             "LNM_RESULTS_DIR", "SUMMARY_RESULTS_DIR", "DISSECT_JOBS_DIR",
             "LNM_JOBS_DIR"):
    os.environ.setdefault(_var, str(_SCRATCH / _var.lower()))
os.environ.setdefault("MRLATTE_MODULE_ROOT", str(_SCRATCH / "module-root"))
