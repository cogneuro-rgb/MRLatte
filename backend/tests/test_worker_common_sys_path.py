"""Regression net for the worker sys.path propagation fix.

Workers are spawned as fresh subprocesses of the same interpreter
([sys.executable, script, config_json]); a child never inherits its parent's
sys.path, and PYTHONPATH can't carry it either once the embeddable Python's
._pth switches sys.path to isolated mode. worker_common.extra_sys_path_for_worker
is the parent-side half of the fix: it must report what the parent has beyond
a plain interpreter's own baseline, so the caller can hand it to the worker via
config["sys_path"]. See worker_common.py's "Cross-process sys.path
propagation" section for the full story.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import worker_common  # noqa: E402


def test_compute_extra_sys_path_empty_when_current_is_subset_of_baseline():
    """No extras when the parent's sys.path is fully covered by the baseline
    plus its own directory — the normal dev-venv case."""
    baseline = ["/std/lib", "/site-packages"]
    current = ["/std/lib", "/site-packages", "/backend"]
    assert worker_common._compute_extra_sys_path(current, baseline, "/backend") == []


def test_compute_extra_sys_path_surfaces_unusual_directory():
    """A directory present on the parent's live sys.path but absent from the
    baseline (and not the worker's own directory) must be surfaced — this is
    the python-reports/python-validation case in a full packaged build."""
    baseline = ["/std/lib", "/site-packages"]
    current = ["/python-validation", "/python-reports", "/backend",
               "/site-packages", "/std/lib"]
    extra = worker_common._compute_extra_sys_path(current, baseline, "/backend")
    assert extra == ["/python-validation", "/python-reports"]


def test_compute_extra_sys_path_deduplicates_and_ignores_blank_entries():
    baseline = ["/std/lib"]
    current = ["", "/extra", "/extra", "/std/lib"]
    assert worker_common._compute_extra_sys_path(current, baseline, None) == ["/extra"]


def test_compute_extra_sys_path_is_case_and_separator_insensitive():
    """Windows paths that differ only by case or slash direction must not be
    reported as extra (os.path.normcase/normpath handles both)."""
    baseline = ["C:\\Std\\Lib"]
    current = ["c:/std/lib"]
    assert worker_common._compute_extra_sys_path(current, baseline, None) == []


def test_extra_sys_path_for_worker_is_empty_under_a_plain_dev_launch():
    """The real, end-to-end helper — exercised in a fresh subprocess that
    mimics the actual dev launch shape (`cd backend && uvicorn server:app`,
    which puts backend/ on sys.path and nothing else unusual), rather than
    calling it in-process under pytest: pytest inserts backend/tests onto
    sys.path itself (see conftest.py's docstring), which would make this
    process's own sys.path look "extra" relative to a bare child and produce
    a false positive unrelated to the fix. Must be empty: dev is
    byte-for-byte unaffected."""
    backend_dir = str(Path(__file__).resolve().parents[1])
    probe = (
        "import sys, json; "
        f"sys.path.insert(0, {backend_dir!r}); "
        "import worker_common; "
        "print(json.dumps(worker_common.extra_sys_path_for_worker()))"
    )
    result = subprocess.run([sys.executable, "-c", probe],
                             capture_output=True, text=True, cwd=backend_dir)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == []


def test_worker_subprocess_cannot_import_a_path_only_reachable_via_injection():
    """Stronger end-to-end proof: a bare subprocess of this interpreter (no
    injection) cannot import a module that lives only in an arbitrary extra
    directory, but a subprocess that receives that directory via the same
    sys.path.insert loop every worker script runs (see e.g.
    lnm_worker.py) can. This reproduces, at the subprocess boundary, exactly
    the failure summary_render_worker.py's _brainsprite_html hits today when
    the optional reports stack lives outside the worker's own sys.path."""
    import tempfile

    with tempfile.TemporaryDirectory() as extra_dir:
        marker = Path(extra_dir) / "mrlatte_test_only_reachable_via_injection.py"
        marker.write_text("VALUE = 42\n")

        probe = "import sys; import mrlatte_test_only_reachable_via_injection as m; print(m.VALUE)"

        # Without the extra directory on sys.path, the import fails.
        bare = subprocess.run([sys.executable, "-c", probe],
                               capture_output=True, text=True)
        assert bare.returncode != 0

        # With it injected the same way a worker injects cfg["sys_path"],
        # the import succeeds — mirroring each worker's
        # `for _p in cfg.get("sys_path") or []: sys.path.insert(0, _p)` loop.
        injected_probe = (
            f"import sys; sys.path.insert(0, {str(extra_dir)!r}); " + probe
        )
        injected = subprocess.run([sys.executable, "-c", injected_probe],
                                   capture_output=True, text=True)
        assert injected.returncode == 0, injected.stderr
        assert injected.stdout.strip() == "42"
