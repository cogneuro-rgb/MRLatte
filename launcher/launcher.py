"""NeuroVue offline launcher (console edition).

Runs the fully self-contained, offline NeuroVue stack on Windows with no admin
rights, no Docker, and no internet:

    1. ensure %LOCALAPPDATA%\\NeuroVue\\{db,lesions} exist
    2. start the bundled portable MongoDB (mongo\\mongod.exe) on 127.0.0.1:27117
    3. start the backend (python\\python.exe -m uvicorn server:app) on :8001,
       serving the built React app + API from one origin (mirrors
       docker-compose.local.yml, minus Docker)
    4. wait until GET /api/ answers (DB-free health probe)
    5. open the default browser at http://127.0.0.1:8001/
    6. print a friendly banner and block. Closing this console window (or Ctrl+C)
       stops everything.

Run via run.bat, which invokes the *bundled* embeddable Python:
    "%~dp0python\\python.exe" "%~dp0launcher.py"

Design notes:
  * Child processes are spawned WITHOUT CREATE_NEW_PROCESS_GROUP so they stay
    attached to this console. When the user closes the window, Windows delivers
    CTRL_CLOSE_EVENT to the whole console process group and terminates mongod +
    uvicorn too -> automatic teardown, no orphaned processes, no Task Manager
    hunting. A best-effort atexit/signal cleanup is kept as a backup.
  * Only the standard library is used, and NOT tkinter (the embeddable Python
    distro ships without tkinter). The console window itself is the UI.
"""

import atexit
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime
from pathlib import Path

# --------------------------------------------------------------------------- #
# Fixed configuration
# --------------------------------------------------------------------------- #
MONGO_PORT = 27117            # non-default: avoids colliding with a stock 27017
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8001
DB_NAME = "neurovue"
APP_URL = f"http://{BACKEND_HOST}:{BACKEND_PORT}/"
HEALTH_URL = f"http://{BACKEND_HOST}:{BACKEND_PORT}/api/"

MONGO_START_TIMEOUT = 30      # seconds to wait for mongod to accept connections
BACKEND_START_TIMEOUT = 90    # seconds to wait for uvicorn to answer /api/


def app_dir() -> Path:
    """Folder this launcher lives in (the bundle root). Uses __file__ because the
    launcher is run by the bundled python.exe, not frozen."""
    return Path(__file__).resolve().parent


APP_DIR = app_dir()
LOCALAPPDATA = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
DATA_ROOT = LOCALAPPDATA / "NeuroVue"
DB_DIR = DATA_ROOT / "db"
LESION_DIR = DATA_ROOT / "lesions"
LOG_DIR = DATA_ROOT / "logs"
LAUNCHER_LOG = LOG_DIR / "launcher.log"

_procs = []  # started child processes, for cleanup


# --------------------------------------------------------------------------- #
# Logging + console helpers
# --------------------------------------------------------------------------- #
def log(msg: str) -> None:
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LAUNCHER_LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def say(msg: str = "") -> None:
    """Print to the console (the user-facing UI)."""
    try:
        print(msg, flush=True)
    except OSError:
        pass


def die(message: str) -> None:
    """Report a fatal error to the console + log, tear down, and exit."""
    log(f"FATAL: {message}")
    say()
    say("=" * 64)
    say("  NeuroVue could not start")
    say("=" * 64)
    say(f"  {message}")
    say(f"  Details in: {LAUNCHER_LOG}")
    say("=" * 64)
    _cleanup()
    try:
        input("\nPress Enter to close this window...")
    except (EOFError, OSError):
        pass
    sys.exit(1)


# --------------------------------------------------------------------------- #
# Process helpers
# --------------------------------------------------------------------------- #
def _port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def _wait_for_port(host: str, port: int, timeout: int) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _port_open(host, port):
            return True
        time.sleep(0.4)
    return False


def _wait_for_http(url: str, timeout: int) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(0.5)
    return False


def _open_log(name: str):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    return open(LOG_DIR / name, "a", encoding="utf-8", errors="replace")


def _cleanup(*_args) -> None:
    """Best-effort teardown backup. In normal use, closing the console already
    kills the console-attached children; this handles Ctrl+C / atexit paths and
    reaps any descendants (uvicorn may spawn worker python.exe children)."""
    for proc in reversed(_procs):
        try:
            if proc.poll() is None:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
        except Exception as exc:  # noqa: BLE001 - best effort
            log(f"cleanup of pid {getattr(proc, 'pid', '?')} failed: {exc}")


# --------------------------------------------------------------------------- #
# Start MongoDB
# --------------------------------------------------------------------------- #
def start_mongo() -> None:
    mongod = APP_DIR / "mongo" / "mongod.exe"
    if not mongod.exists():
        die(f"MongoDB engine not found: {mongod}\n"
            "  The installation looks incomplete - re-install NeuroVue.")

    DB_DIR.mkdir(parents=True, exist_ok=True)
    LESION_DIR.mkdir(parents=True, exist_ok=True)

    say("  - starting database ...")
    log(f"Starting mongod (dbpath={DB_DIR}, port={MONGO_PORT})")
    proc = subprocess.Popen(
        [
            str(mongod),
            "--dbpath", str(DB_DIR),
            "--port", str(MONGO_PORT),
            "--bind_ip", "127.0.0.1",     # loopback only: never exposed off-box
        ],
        stdout=_open_log("mongod.log"),
        stderr=subprocess.STDOUT,
    )
    _procs.append(proc)
    if not _wait_for_port("127.0.0.1", MONGO_PORT, MONGO_START_TIMEOUT):
        die("The database did not start in time.\n"
            "  On older PCs this can mean the CPU lacks AVX support.\n"
            "  See mongod.log for details.")
    log("mongod is accepting connections")


# --------------------------------------------------------------------------- #
# Start backend (embedded python -m uvicorn)
# --------------------------------------------------------------------------- #
def start_backend() -> None:
    python_exe = APP_DIR / "python" / "python.exe"
    backend_dir = APP_DIR / "backend"
    site_packages = APP_DIR / "python" / "site-packages"
    if not python_exe.exists():
        die(f"Embedded Python not found: {python_exe}\n"
            "  The installation looks incomplete - re-install NeuroVue.")

    static_dir = APP_DIR / "frontend_build"
    scripts_dir = APP_DIR / "scripts"
    data_dir = APP_DIR / "data"

    env = os.environ.copy()
    # --- required by server.py at import time ---
    env["MONGO_URL"] = f"mongodb://127.0.0.1:{MONGO_PORT}"
    env["DB_NAME"] = DB_NAME
    # --- static site + atlases (same-origin serving) ---
    env["STATIC_DIR"] = str(static_dir)
    env["ATLAS_DIR"] = str(static_dir / "atlases")
    # Bundled nilearn atlas cache -> LNM region-labelling runs fully offline.
    env["NILEARN_DATA"] = str(APP_DIR / "nilearn_data")
    # --- persistent user data (under %LOCALAPPDATA%, survives re-install) ---
    env["LESION_DIR"] = str(LESION_DIR)
    # --- ephemeral compute outputs (under the data root, also user-writable) ---
    env["TRACT_RESULTS_DIR"] = str(DATA_ROOT / "tract_results")
    env["ROI_RESULTS_DIR"] = str(DATA_ROOT / "roi_results")
    env["DICOM_RESULTS_DIR"] = str(DATA_ROOT / "dicom_results")
    env["LNM_RESULTS_DIR"] = str(DATA_ROOT / "lnm_results")
    env["SUMMARY_RESULTS_DIR"] = str(DATA_ROOT / "summary_results")
    # --- bundled data files ---
    env["LNM_BUNDLE"] = str(data_dir / "lnm_bundle_d100.npz")
    env["GLOBAL_TRACT_FILE"] = str(data_dir / "tracts" / "S35_1mm.trk")
    # --- validation artefacts (see server.py env-var patch) ---
    env["VALIDATION_DIR"] = str(scripts_dir / "validation_plots")
    env["VALIDATION_REPORT"] = str(scripts_dir / "benson_validation_report.txt")
    # --- dcm2niix on PATH so shutil.which("dcm2niix") resolves in the backend ---
    env["PATH"] = str(APP_DIR / "dcm2niix") + os.pathsep + env.get("PATH", "")
    env["PYTHONUNBUFFERED"] = "1"
    # Same origin -> no CORS needed; make sure it stays unset.
    env.pop("CORS_ORIGINS", None)

    # IMPORTANT: the Windows *embeddable* Python has a python311._pth file, whose
    # presence makes Python IGNORE the PYTHONPATH env var when building sys.path.
    # So we cannot rely on PYTHONPATH to add site-packages / backend. Instead we
    # launch via a tiny "-c" bootstrap that inserts the (runtime-computed,
    # relocatable) paths into sys.path before importing uvicorn/server. This works
    # regardless of ._pth and keeps the whole bundle location-independent.
    bootstrap = (
        "import sys, os;"
        f"sys.path.insert(0, r'{site_packages}');"
        f"sys.path.insert(0, r'{backend_dir}');"
        f"os.chdir(r'{backend_dir}');"
        "import uvicorn;"
        f"uvicorn.run('server:app', host='{BACKEND_HOST}', port={BACKEND_PORT})"
    )

    say("  - starting application ...")
    log(f"Starting backend (uvicorn) on {BACKEND_HOST}:{BACKEND_PORT}")
    proc = subprocess.Popen(
        [str(python_exe), "-c", bootstrap],
        cwd=str(backend_dir),
        env=env,
        stdout=_open_log("backend.log"),
        stderr=subprocess.STDOUT,
    )
    _procs.append(proc)
    if not _wait_for_http(HEALTH_URL, BACKEND_START_TIMEOUT):
        die("The application did not respond in time.\n"
            "  See backend.log for details.")
    log("backend is healthy")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log("=" * 60)
    log(f"NeuroVue launcher starting (APP_DIR={APP_DIR})")

    atexit.register(_cleanup)
    try:
        signal.signal(signal.SIGINT, lambda *_: (_cleanup(), sys.exit(0)))
    except (ValueError, OSError):
        pass

    say()
    say("  NeuroVue - starting up, please wait ...")
    say()

    # Refuse to double-launch: if either port is already bound, another instance
    # (or a leftover process) is likely running.
    busy = [p for p in (MONGO_PORT, BACKEND_PORT) if _port_open("127.0.0.1", p)]
    if busy:
        die("NeuroVue (or a leftover process) is already using port(s) "
            f"{', '.join(map(str, busy))}.\n"
            "  Close the existing NeuroVue window first. If none is open, end any\n"
            "  stray mongod.exe / python.exe in Task Manager, or restart the PC.")

    start_mongo()
    start_backend()

    webbrowser.open(APP_URL)
    log("Browser opened; entering idle loop")

    say()
    say("=" * 64)
    say("  ✔ NeuroVue is running")
    say("=" * 64)
    say(f"  A browser tab has opened at:  {APP_URL}")
    say("  If it did not open, type that address into your web browser.")
    say()
    say("  >> KEEP THIS WINDOW OPEN while you use NeuroVue.")
    say("  >> To STOP NeuroVue, simply CLOSE this window.")
    say("=" * 64)
    say()

    # Idle until the user closes the window / Ctrl+C, or a child dies on its own.
    try:
        while True:
            time.sleep(2)
            for proc in _procs:
                if proc.poll() is not None:
                    log("A child process exited unexpectedly; shutting down")
                    say("  A NeuroVue component stopped unexpectedly. Shutting down.")
                    _cleanup()
                    try:
                        input("\nPress Enter to close this window...")
                    except (EOFError, OSError):
                        pass
                    return
    except KeyboardInterrupt:
        pass
    finally:
        _cleanup()
    log("Launcher exited cleanly")


if __name__ == "__main__":
    main()
