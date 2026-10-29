"""One-click python-package modules (e.g. longitudinal-simpleitk): install from a
pinned wheel, refuse a bad hash or an escaping archive, put the folder on
sys.path, and remove only what this app installed.

Everything runs against a scratch MRLATTE_MODULE_ROOT and a scratch manifest;
the download is replaced by a local copy, so nothing reaches the internet.
"""
import hashlib
import io
import json
import re
import shutil
import sys
import tarfile
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import deps
import routers.modules as mods
from server import app

PKG = "mrl_fake_wheel_pkg"
PKG_B = "mrl_fake_wheel_pkg_b"
SDIST_PKG = "mrl_fake_sdist_pkg"
MOD = "fake-python-module"


def _wheel(path, members):
    with zipfile.ZipFile(path, "w") as zf:
        for name, text in members.items():
            zf.writestr(name, text)
    return path


def _sdist(path, members, links=()):
    """A .tar.gz source package; `links` adds symlink members (name -> target)."""
    with tarfile.open(path, "w:gz") as tf:
        for name, text in members.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        for name, target in links:
            info = tarfile.TarInfo(name)
            info.type, info.linkname = tarfile.SYMTYPE, target
            tf.addfile(info)
    return path


def _src(kind, path, url, **extra):
    return {"type": kind, "url": url, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "bytes": path.stat().st_size, **extra}


@pytest.fixture
def env(tmp_path, monkeypatch):
    root = tmp_path / "module-root"
    root.mkdir()
    wheel = _wheel(tmp_path / "fake.whl", {
        f"{PKG}/__init__.py": "VALUE = 42\n",
        f"{PKG}-1.0.dist-info/METADATA": "Name: mrl-fake-wheel-pkg\n",
    })

    def manifest(sha):
        m = {"schemaVersion": 1, "modules": [{
            "id": MOD, "name": "Fake", "type": "python-package", "tier": "optional",
            "version": "1.0", "unlocks": ["fake"], "bytes": wheel.stat().st_size,
            "sha256": None, "installTo": "python/fake", "pythonPackages": [PKG],
            "sources": [{"type": "wheel", "url": "https://example.invalid/fake.whl",
                         "sha256": sha, "bytes": wheel.stat().st_size}],
        }]}
        p = tmp_path / "manifest.json"
        p.write_text(json.dumps(m), encoding="utf-8")
        mods._manifest_cache["mtime"] = None
        return p

    def manifest_with(sources, packages=(PKG,)):
        m = {"schemaVersion": 1, "modules": [{
            "id": MOD, "name": "Fake", "type": "python-package", "tier": "optional",
            "version": "1.0", "unlocks": ["fake"], "bytes": 1, "sha256": None,
            "installTo": "python/fake", "pythonPackages": list(packages), "sources": sources,
        }]}
        p = tmp_path / "manifest.json"
        p.write_text(json.dumps(m), encoding="utf-8")
        mods._manifest_cache["mtime"] = None
        return p

    good = hashlib.sha256(wheel.read_bytes()).hexdigest()
    monkeypatch.setattr(deps, "MODULE_ROOT", root)
    monkeypatch.setenv("MRLATTE_MODULE_MANIFEST", str(manifest(good)))
    monkeypatch.setenv("MRLATTE_MODULE_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setattr(sys, "path", list(sys.path))          # restored after the test
    served = {"file": wheel, "by_url": {}}

    def fake_download(url, part, job_id, expected_bytes=None, **_progress):
        part.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(served["by_url"].get(url, served["file"]), part)
        return part.stat().st_size

    monkeypatch.setattr(mods, "_download", fake_download)
    yield type("Env", (), {"root": root, "wheel": wheel, "served": served,
                           "manifest": manifest, "manifest_with": manifest_with, "tmp": tmp_path})
    for name in (PKG, PKG_B, SDIST_PKG):
        sys.modules.pop(name, None)


def _install(client):
    r = client.post(f"/api/modules/{MOD}/install")
    assert r.status_code == 200, r.text
    job = r.json()["job_id"]
    # Returns as soon as the job is done; the 15 s ceiling only matters on a
    # loaded machine (a 4 s one made this flaky in a full-suite run).
    for _ in range(750):
        s = client.get(f"/api/modules/jobs/{job}").json()
        if s.get("done"):
            return s
        time.sleep(0.02)
    raise AssertionError("install job never finished")


def _module(client):
    return next(m for m in client.get("/api/modules").json()["modules"] if m["id"] == MOD)


def test_installs_the_wheel_and_it_imports_without_a_restart(env):
    client = TestClient(app)
    assert _module(client)["downloadable"] is True
    status = _install(client)
    assert status["stage"] == "done", status
    target = env.root / "python" / "fake"
    assert (target / PKG / "__init__.py").exists()
    assert str(target) in sys.path
    assert __import__(PKG).VALUE == 42
    m = _module(client)
    assert m["installed"] and m["uninstallable"]


def test_a_wrong_hash_installs_nothing(env):
    env.manifest("0" * 64)
    status = _install(TestClient(app))
    assert status["stage"] == "error" and "sha256 mismatch" in json.dumps(status["error"])
    assert not (env.root / "python" / "fake").exists()


def test_an_archive_that_escapes_is_refused(env):
    bad = _wheel(env.tmp / "bad.whl", {"../escaped.py": "x = 1\n", f"{PKG}/__init__.py": ""})
    env.served["file"] = bad
    env.manifest(hashlib.sha256(bad.read_bytes()).hexdigest())
    status = _install(TestClient(app))
    assert status["stage"] == "error"
    assert not (env.root / "python" / "fake").exists()
    assert not (env.root / "python" / "escaped.py").exists()


def test_a_folder_it_did_not_install_is_never_replaced_or_removed(env):
    (env.root / "python" / "fake").mkdir(parents=True)
    client = TestClient(app)
    assert client.post(f"/api/modules/{MOD}/install").status_code == 409
    assert client.delete(f"/api/modules/{MOD}").status_code == 409
    assert (env.root / "python" / "fake").exists()


def test_remove_after_install(env, monkeypatch):
    client = TestClient(app)
    _install(client)
    target = env.root / "python" / "fake"
    monkeypatch.setitem(sys.modules, "send2trash", None)   # no Recycle Bin in tests: plain delete
    r = client.delete(f"/api/modules/{MOD}")
    assert r.status_code == 200, r.text
    assert r.json()["disposition"] == "deleted"
    assert not target.exists() and str(target) not in sys.path
    assert MOD not in mods._load_ledger()


def test_remove_waits_for_a_running_job_then_is_immediate(env, monkeypatch):
    """In use = a worker that needs the package is running. Not before (the
    panel only looked it up), not after (the worker exited)."""
    client = TestClient(app)
    _install(client)
    target = env.root / "python" / "fake"
    with deps.using_packages(PKG):                     # a job is running
        r = client.delete(f"/api/modules/{MOD}")
        assert r.status_code == 409 and "still running" in r.json()["detail"]
        assert target.exists()
    monkeypatch.setitem(sys.modules, "send2trash", None)
    r = client.delete(f"/api/modules/{MOD}")          # the job is done
    assert r.status_code == 200 and r.json()["disposition"] == "deleted"
    assert not target.exists()


def test_removing_a_module_in_use_finishes_at_the_next_start(env, monkeypatch):
    """One click either way: Windows keeps a loaded module's files locked, so
    one in use this session is marked and removed when MRLatte next starts."""
    client = TestClient(app)
    _install(client)
    target = env.root / "python" / "fake"
    __import__(PKG)                                    # in use this session
    r = client.delete(f"/api/modules/{MOD}")
    assert r.status_code == 200, r.text
    assert r.json()["disposition"] == "on-restart" and "next time MRLatte starts" in r.json()["message"]
    assert target.exists() and str(target) not in sys.path      # off the path for new workers
    m = _module(client)
    assert m["pendingRemoval"] is True and m["uninstallable"] is False
    sys.modules.pop(PKG, None)
    monkeypatch.setitem(sys.modules, "send2trash", None)
    with TestClient(app):                                         # the next start
        assert not target.exists()
        assert str(target) not in sys.path
    assert MOD not in mods._load_ledger()


def test_startup_never_removes_what_it_did_not_install(env, monkeypatch):
    """A pending mark on something without an install record, or outside the
    module's own folder, is ignored."""
    folder = env.root / "python" / "fake"
    (folder / PKG).mkdir(parents=True)
    (folder / PKG / "__init__.py").write_text("VALUE = 1\n")
    monkeypatch.setitem(sys.modules, "send2trash", None)
    with TestClient(app):
        pass
    assert folder.exists()                                        # no ledger entry: untouched


@pytest.mark.parametrize("mode,ok", [(0o644, True), (0o120777, False)])
def test_a_wheel_member_with_permission_bits_only_is_a_file_but_a_link_is_refused(env, mode, ok):
    """Some wheel builders record a file's permissions without its type (pint's
    METADATA is 0o644); that is a plain file. A symlink's type bits are refused."""
    path = env.tmp / "modes.whl"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(f"{PKG}/__init__.py", "VALUE = 42\n")
        info = zipfile.ZipInfo(f"{PKG}-1.0.dist-info/METADATA")
        info.create_system, info.external_attr = 3, mode << 16
        zf.writestr(info, "Name: x\n")
    env.served["file"] = path
    env.manifest(hashlib.sha256(path.read_bytes()).hexdigest())
    status = _install(TestClient(app))
    assert (status["stage"] == "done") is ok, status


def _multi(env):
    """Two wheels and a pure-Python source package (src layout, as neuropythy's)."""
    w2 = _wheel(env.tmp / "b.whl", {f"{PKG_B}/__init__.py": "VALUE = 2\n"})
    sd = _sdist(env.tmp / "c.tar.gz", {
        "c-1.0/setup.py": "raise SystemExit('never run')\n",
        f"c-1.0/src/{SDIST_PKG}/__init__.py": "VALUE = 3\n",
        f"c-1.0/src/{SDIST_PKG}/lib/data.json": "{}\n",
        f"c-1.0/src/{SDIST_PKG}.egg-info/PKG-INFO": "Name: c\nVersion: 1.0\n",
    })
    env.served["by_url"] = {"https://example.invalid/a.whl": env.wheel,
                            "https://example.invalid/b.whl": w2,
                            "https://example.invalid/c.tar.gz": sd}
    return [_src("wheel", env.wheel, "https://example.invalid/a.whl"),
            _src("wheel", w2, "https://example.invalid/b.whl"),
            _src("sdist", sd, "https://example.invalid/c.tar.gz",
                 extract=[f"c-1.0/src/{SDIST_PKG}", f"c-1.0/src/{SDIST_PKG}.egg-info"])]


def test_several_wheels_and_a_source_package_install_together(env):
    env.manifest_with(_multi(env), packages=(PKG, PKG_B, SDIST_PKG))
    client = TestClient(app)
    assert _module(client)["downloadable"] is True
    status = _install(client)
    assert status["stage"] == "done", status
    target = env.root / "python" / "fake"
    assert (__import__(PKG).VALUE, __import__(PKG_B).VALUE, __import__(SDIST_PKG).VALUE) == (42, 2, 3)
    # Only the named folders of the source package: its data comes along, its
    # build script and the rest of the archive do not.
    assert (target / SDIST_PKG / "lib" / "data.json").exists()
    assert (target / f"{SDIST_PKG}.egg-info" / "PKG-INFO").exists()
    assert not (target / "setup.py").exists() and not (target / "src").exists()
    assert _module(client)["installed"]


def test_one_bad_hash_among_several_installs_nothing(env):
    sources = _multi(env)
    sources[1]["sha256"] = "0" * 64
    env.manifest_with(sources, packages=(PKG, PKG_B, SDIST_PKG))
    status = _install(TestClient(app))
    assert status["stage"] == "error" and "sha256 mismatch" in json.dumps(status["error"])
    assert not (env.root / "python" / "fake").exists()


@pytest.mark.parametrize("bad", ["link", "escape"])
def test_a_link_or_escaping_member_in_a_source_package_is_refused(env, bad):
    members = {f"c-1.0/src/{SDIST_PKG}/__init__.py": ""}
    links = ()
    if bad == "link":
        links = [(f"c-1.0/src/{SDIST_PKG}/evil.py", "../../../../outside.py")]
    else:
        members[f"c-1.0/src/{SDIST_PKG}/../../../../outside.py"] = "x = 1\n"
    sd = _sdist(env.tmp / "bad.tar.gz", members, links)
    env.served["by_url"] = {"https://example.invalid/bad.tar.gz": sd}
    env.manifest_with([_src("sdist", sd, "https://example.invalid/bad.tar.gz",
                            extract=[f"c-1.0/src/{SDIST_PKG}"])], packages=(SDIST_PKG,))
    status = _install(TestClient(app))
    assert status["stage"] == "error"
    assert not (env.root / "python" / "fake").exists()
    assert not list(env.root.rglob("outside.py"))


def test_a_bundled_package_in_use_does_not_block_removal(env, monkeypatch):
    """The reports module lists nibabel, which the app itself always has loaded.
    Only something imported from the module's own folder locks it."""
    env.served["by_url"] = {"https://example.invalid/a.whl": env.wheel}
    env.manifest_with([_src("wheel", env.wheel, "https://example.invalid/a.whl")],
                      packages=("json", PKG))
    client = TestClient(app)
    assert _install(client)["stage"] == "done"
    assert "json" in sys.modules
    monkeypatch.setitem(sys.modules, "send2trash", None)
    r = client.delete(f"/api/modules/{MOD}")
    assert r.status_code == 200, r.text


def test_shipped_python_modules_pin_files_and_never_duplicate_the_bundle():
    """The real manifest: every one-click python module pins hashed PyPI files,
    and none of them carries a package the bundled Python already has — module
    folders go first on sys.path, so a second numpy would shadow the bundled one."""
    repo = Path(__file__).resolve().parents[2]
    manifest = json.loads((repo / "data" / "modules" / "manifest.json").read_text(encoding="utf-8"))
    norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()
    bundled = {norm(re.split(r"[<>=!~;@ \[]", line.strip(), maxsplit=1)[0])
               for line in (repo / "backend" / "requirements-frozen.txt").read_text().splitlines()
               if line.strip() and not line.lstrip().startswith("#")}
    for m in manifest["modules"]:
        if m.get("type") != "python-package":
            continue
        pinned = [s for s in m.get("sources") or [] if s.get("type") in ("wheel", "sdist")]
        assert pinned, f"{m['id']} has nothing to install from"
        for s in pinned:
            assert s["url"].startswith("https://files.pythonhosted.org/"), s
            assert re.fullmatch(r"[0-9a-f]{64}", s["sha256"]), s
            assert s.get("bytes", 0) > 0, s
            name = s["url"].rsplit("/", 1)[1]
            project = norm(re.split(r"-\d", name, maxsplit=1)[0])
            assert project not in bundled, f"{m['id']} duplicates bundled {project}"
            if s["type"] == "sdist":
                assert s.get("extract"), s
        assert m["bytes"] == sum(s["bytes"] for s in pinned), m["id"]


def test_a_second_install_while_one_runs_is_refused(env, monkeypatch):
    """Two jobs would race on the same folder. The store's button is disabled
    while one runs; the API refuses too."""
    import threading
    gate = threading.Event()

    def slow_download(url, part, job_id, expected_bytes=None, **_progress):
        gate.wait(5)
        part.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(env.wheel, part)
        return part.stat().st_size

    monkeypatch.setattr(mods, "_download", slow_download)
    client = TestClient(app)
    first = client.post(f"/api/modules/{MOD}/install")
    assert first.status_code == 200, first.text
    second = client.post(f"/api/modules/{MOD}/install")
    assert second.status_code == 409 and "already being installed" in second.text
    gate.set()
    for _ in range(200):
        if client.get(f"/api/modules/jobs/{first.json()['job_id']}").json().get("done"):
            break
        time.sleep(0.02)
    assert (env.root / "python" / "fake" / PKG / "__init__.py").exists()


def test_reinstalling_a_module_in_use_is_refused(env):
    """Windows keeps a loaded module's files locked: replacing them would fail
    halfway and leave a broken install."""
    client = TestClient(app)
    assert _install(client)["stage"] == "done"
    __import__(PKG)
    r = client.post(f"/api/modules/{MOD}/install")
    assert r.status_code == 409 and "Restart MRLatte" in r.text
    assert (env.root / "python" / "fake" / PKG / "__init__.py").exists()


def test_startup_puts_installed_folders_on_sys_path(env):
    (env.root / "python" / "alpha").mkdir(parents=True)
    (env.root / "python" / "beta.installing").mkdir(parents=True)
    added = deps.add_installed_python_modules(env.root)
    assert added == [str(env.root / "python" / "alpha")]
    assert deps.add_installed_python_modules(env.root) == []       # idempotent


def test_server_startup_adds_installed_module_folders(env):
    """The real lifespan, not just the helper: an installed module must import
    after a restart (this once failed on a missing import in server.py)."""
    folder = env.root / "python" / "fake"
    (folder / PKG).mkdir(parents=True)
    (folder / PKG / "__init__.py").write_text("VALUE = 7\n")
    with TestClient(app):                          # runs startup
        assert str(folder) in sys.path
        assert __import__(PKG).VALUE == 7
