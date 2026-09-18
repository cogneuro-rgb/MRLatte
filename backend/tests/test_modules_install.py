"""Phase 4 — module install / sideload / verify / uninstall.

Every test runs against an in-process FastAPI TestClient and a scratch
MRLATTE_MODULE_ROOT under tmp_path. Nothing binds a real port except the
download test, which starts `python -m http.server` on an ephemeral loopback
port; no test reaches the public internet, and no test writes into the repo.

A scratch MRLATTE_MODULE_ROOT keeps every install/uninstall confined to
tmp_path. The "refuse to delete outside the module root" guard is exercised by
pointing a per-asset env override (ATLAS_DIR, GLOBAL_TRACT_FILE) at a directory
OUTSIDE that root.
"""
import hashlib
import io
import json
import logging
import os
import socket
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import deps
import routers.modules as mods
from server import app

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_MANIFEST = REPO_ROOT / "data" / "modules" / "manifest.json"
REAL_ATLASES = REPO_ROOT / "data" / "modules" / "atlases"

RETINOTOPY = "retinotopy-benson-wang"
# Both HCP-derived assets are now `slot` modules: any conforming file, any
# name, dropped into a directory. Ids name the ROLE, not one artifact.
TRACTOGRAPHY = "tractography-whole-brain"
LNM = "lnm-connectome"


def _manifest_entry(module_id):
    data = json.loads(REAL_MANIFEST.read_text(encoding="utf-8"))
    return next(m for m in data["modules"] if m["id"] == module_id)


RETINOTOPY_ENTRY = _manifest_entry(RETINOTOPY)
RETINOTOPY_FILES = [f["path"] for f in RETINOTOPY_ENTRY["files"]]

pytestmark = pytest.mark.skipif(
    not all((REAL_ATLASES / f).exists() for f in RETINOTOPY_FILES),
    reason="retinotopy source assets are not present in this checkout",
)


# === Fixtures =================================================================

@pytest.fixture
def env(tmp_path, monkeypatch):
    """Scratch module root; every install/uninstall stays under tmp_path."""
    root = tmp_path / "module-root"
    root.mkdir()

    monkeypatch.setattr(deps, "MODULE_ROOT", root)
    monkeypatch.setenv("MRLATTE_MODULE_MANIFEST", str(REAL_MANIFEST))
    monkeypatch.setenv("MRLATTE_MODULE_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.delenv("MRLATTE_MODULE_RELEASE_BASE", raising=False)
    # Per-asset overrides would bypass the module root entirely.
    for var in ("ATLAS_DIR", "GLOBAL_TRACT_FILE", "LNM_BUNDLE",
                "VALIDATION_DIR", "VALIDATION_REPORT"):
        monkeypatch.delenv(var, raising=False)
    mods._manifest_cache["mtime"] = None

    class Env:
        pass

    e = Env()
    e.root = root
    e.tmp = tmp_path
    return e


@pytest.fixture
def client(env):
    with TestClient(app) as c:
        yield c


def snapshot(client):
    r = client.get("/api/modules")
    assert r.status_code == 200
    return r.json()


def module_state(client, module_id):
    return next(m for m in snapshot(client)["modules"] if m["id"] == module_id)


def atlas_files(root, pattern="*"):
    """Real files under the atlases dir, which is nested one folder per atlas
    family — a plain glob("*") would only see the family directories."""
    return sorted(p for p in (root / "atlases").rglob(pattern) if p.is_file())


# === Archive builders =========================================================

def _retinotopy_payload():
    return {p: (REAL_ATLASES / p).read_bytes() for p in RETINOTOPY_FILES}


def build_zip(path, members, top_dir=None):
    """members: {archive path -> bytes}."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            zf.writestr(f"{top_dir}/{name}" if top_dir else name, data)
    return path


def retinotopy_zip(path, top_dir=None, corrupt=None):
    payload = _retinotopy_payload()
    if corrupt:
        blob = bytearray(payload[corrupt])
        blob[-1] ^= 0xFF          # same length, so the size check still passes
        payload[corrupt] = bytes(blob)
    return build_zip(path, payload, top_dir=top_dir)


def upload(client, module_id, path):
    with open(path, "rb") as fh:
        return client.post(f"/api/modules/{module_id}/sideload",
                           files={"file": (path.name, fh, "application/zip")})


# === 1. Successful sideload of a multi-file module ============================

@pytest.mark.parametrize("top_dir", [None, "retinotopy-benson-wang"])
def test_sideload_multifile_installs_and_flips_capability(client, env, tmp_path, top_dir):
    before = module_state(client, RETINOTOPY)
    assert before["installed"] is False
    assert snapshot(client)["capabilities"]["retinotopy"] is False
    assert snapshot(client)["installable"] is True

    r = upload(client, RETINOTOPY, retinotopy_zip(tmp_path / "r.zip", top_dir=top_dir))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["capabilities"]["retinotopy"] is True

    # Files landed under the scratch root with byte-exact content.
    for f in RETINOTOPY_ENTRY["files"]:
        dest = env.root / "atlases" / f["path"]
        assert dest.exists(), f["path"]
        assert dest.stat().st_size == f["bytes"]
        assert hashlib.sha256(dest.read_bytes()).hexdigest() == f["sha256"]
        assert not dest.with_name(dest.name + ".part").exists()

    after = module_state(client, RETINOTOPY)
    assert after["installed"] is True
    assert after["verified"] is True
    assert after["state"] == "installed"
    assert after["path"] == str(env.root / "atlases")
    assert (env.root / "manifest.installed.json").exists()

    # Deep verify agrees.
    v = client.post(f"/api/modules/{RETINOTOPY}/verify").json()
    assert v["ok"] is True
    assert v["corrupt"] == [] and v["missing"] == []
    assert len(v["files"]) == len(RETINOTOPY_FILES)


def test_sideload_only_writes_inside_the_module_root(client, env, tmp_path):
    upload(client, RETINOTOPY, retinotopy_zip(tmp_path / "r.zip"))
    written = {p for p in env.tmp.rglob("*") if p.is_file()}
    outside = [p for p in written
               if env.root not in p.parents and p.parent != env.root
               and (env.tmp / "jobs") not in p.parents
               and p.parent != tmp_path]
    assert outside == [], outside


# === 2. Hash-mismatch rejection ===============================================

def test_hash_mismatch_is_rejected_and_names_the_file(client, env, tmp_path):
    bad = "wang2015/wang2015_maxprob.nii.gz"
    r = upload(client, RETINOTOPY,
               retinotopy_zip(tmp_path / "bad.zip", corrupt=bad))
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "sha256 mismatch"
    assert detail["file"] == bad
    expected = next(f["sha256"] for f in RETINOTOPY_ENTRY["files"] if f["path"] == bad)
    assert detail["expected"] == expected
    assert detail["actual"] != expected

    # Nothing promoted, and no .part left behind — not even for the files that
    # DID verify before the bad one was reached.
    assert module_state(client, RETINOTOPY)["installed"] is False
    assert atlas_files(env.root) == []


def test_declared_size_mismatch_is_rejected_before_decompressing(client, env, tmp_path):
    payload = _retinotopy_payload()
    payload["wang2015/wang2015_labels.json"] += b"\x00" * 64
    r = upload(client, RETINOTOPY, build_zip(tmp_path / "s.zip", payload))
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["error"] == "declared size mismatch"
    assert module_state(client, RETINOTOPY)["installed"] is False


def test_archive_missing_a_required_file_is_rejected(client, env, tmp_path):
    payload = _retinotopy_payload()
    payload.pop("misc/visual_areas_v1v5.nii.gz")
    r = upload(client, RETINOTOPY, build_zip(tmp_path / "m.zip", payload))
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["missing"] == ["misc/visual_areas_v1v5.nii.gz"]
    assert atlas_files(env.root) == []


# === 3. Zip Slip ==============================================================

EVIL_NAMES = [
    "../evil.txt",
    "../../evil.txt",
    "atlases/../../evil.txt",
    "/etc/evil.txt",
    "C:/Windows/Temp/evil.txt",
    "..\\evil.txt",
    "subdir/../../../evil.txt",
]


@pytest.mark.parametrize("evil", EVIL_NAMES)
def test_zip_slip_member_is_rejected_and_nothing_escapes(client, env, tmp_path, evil):
    payload = _retinotopy_payload()
    payload[evil] = b"pwned"
    r = upload(client, RETINOTOPY, build_zip(tmp_path / "evil.zip", payload))

    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert detail["error"].startswith("archive rejected")

    # Not one byte written, inside the root or out of it.
    assert [p for p in tmp_path.rglob("evil.txt")] == []
    assert [p for p in Path(tmp_path.anchor).glob("evil.txt")] == []
    assert module_state(client, RETINOTOPY)["installed"] is False
    assert atlas_files(env.root) == []


def test_zip_slip_directory_entry_is_rejected(client, env, tmp_path):
    path = tmp_path / "evildir.zip"
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in _retinotopy_payload().items():
            zf.writestr(name, data)
        zf.writestr("../escaped/", b"")
    r = upload(client, RETINOTOPY, path)
    assert r.status_code == 400, r.text
    assert not (tmp_path / "escaped").exists()
    assert atlas_files(env.root) == []


def test_symlink_member_is_rejected(client, env, tmp_path):
    """A zip can carry a symlink whose target is anywhere on the filesystem;
    extracting it would let a later write escape the module root."""
    path = tmp_path / "link.zip"
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in _retinotopy_payload().items():
            zf.writestr(name, data)
        info = zipfile.ZipInfo("sneaky-link")
        info.create_system = 3                      # Unix
        info.external_attr = (0o120777 << 16)       # S_IFLNK
        zf.writestr(info, str(tmp_path / "outside.txt"))
    r = upload(client, RETINOTOPY, path)
    assert r.status_code == 400, r.text
    assert "link" in json.dumps(r.json()["detail"])
    assert atlas_files(env.root) == []


def test_safe_join_unit(env):
    root = env.root
    assert mods._safe_join(root, "atlases/a.nii.gz") == root / "atlases" / "a.nii.gz"
    assert mods._safe_join(root, "./a") == root / "a"
    for bad in ("../x", "a/../../x", "/abs/x", "C:/x", "\\\\server\\share\\x",
                "a\\..\\..\\x", "a\x00b"):
        with pytest.raises(mods.BoundaryError):
            mods._safe_join(root, bad)


# === 4. Interrupted transfers ================================================

def test_orphan_part_file_is_not_treated_as_installed(client, env):
    """A `.part` from an interrupted transfer must never satisfy the installed
    check, and must never be promoted by anything other than a verified
    install."""
    atlases = env.root / "atlases"
    atlases.mkdir(parents=True)
    for name, data in _retinotopy_payload().items():
        part = atlases / (name + ".part")
        part.parent.mkdir(parents=True, exist_ok=True)
        part.write_bytes(data)                           # complete, but unverified

    state = module_state(client, RETINOTOPY)
    assert state["installed"] is False
    assert sorted(state["missing"]) == sorted(RETINOTOPY_FILES)
    for name in RETINOTOPY_FILES:
        assert not (atlases / name).exists()
    assert snapshot(client)["capabilities"]["retinotopy"] is False


def test_truncated_part_is_replaced_not_promoted(client, env, tmp_path):
    """A half-written `.part` left by a dead transfer is overwritten by the next
    sideload, and the promoted file is the verified one."""
    atlases = env.root / "atlases"
    atlases.mkdir(parents=True)
    victim = "wang2015/wang2015_labels.json"
    (atlases / victim).parent.mkdir(parents=True, exist_ok=True)
    (atlases / (victim + ".part")).write_bytes(b"truncated garbage")

    r = upload(client, RETINOTOPY, retinotopy_zip(tmp_path / "r.zip"))
    assert r.status_code == 200, r.text
    good = next(f for f in RETINOTOPY_ENTRY["files"] if f["path"] == victim)
    assert hashlib.sha256((atlases / victim).read_bytes()).hexdigest() == good["sha256"]
    assert not (atlases / (victim + ".part")).exists()


def test_corrupt_installed_file_reports_broken_and_repair_fixes_it(client, env, tmp_path):
    zip_path = retinotopy_zip(tmp_path / "r.zip")
    assert upload(client, RETINOTOPY, zip_path).status_code == 200

    victim = env.root / "atlases" / "benson14" / "benson14_visual_areas.nii.gz"
    victim.write_bytes(b"\x00" * 32)          # wrong size -> fast check trips

    state = module_state(client, RETINOTOPY)
    assert state["installed"] is False
    assert state["state"] == "broken"
    assert state["repairable"] is True

    deep = client.post(f"/api/modules/{RETINOTOPY}/verify").json()
    assert deep["ok"] is False
    assert deep["corrupt"] == ["benson14/benson14_visual_areas.nii.gz"]

    # Repair == re-run the install over the top.
    assert upload(client, RETINOTOPY, zip_path).status_code == 200
    assert module_state(client, RETINOTOPY)["state"] == "installed"
    assert client.post(f"/api/modules/{RETINOTOPY}/verify").json()["ok"] is True


# === 5. Uninstall ============================================================

def _plant_outside_root(env, monkeypatch):
    """Point per-asset env overrides at a directory OUTSIDE the module root, as
    a deployment that keeps its atlases/tractogram somewhere the installer does
    not manage would. The uninstall guard must refuse to touch these."""
    external = env.tmp / "external"
    ext_atlases = external / "atlases"
    for name, data in _retinotopy_payload().items():
        dest = ext_atlases / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    ext_trk = external / "tracts" / "some_tractogram.trk"
    ext_trk.parent.mkdir(parents=True)
    ext_trk.write_bytes(b"pretend tractogram")
    monkeypatch.setenv("ATLAS_DIR", str(ext_atlases))
    monkeypatch.setenv("GLOBAL_TRACT_FILE", str(ext_trk))
    return ext_atlases, ext_trk


def test_uninstall_refuses_to_delete_outside_the_module_root(client, env, monkeypatch):
    ext_atlases, ext_trk = _plant_outside_root(env, monkeypatch)

    state = module_state(client, RETINOTOPY)
    assert state["installed"] is True                 # resolves via the env override
    assert state["path"] == str(ext_atlases)
    assert state["uninstallable"] is False

    r = client.delete(f"/api/modules/{RETINOTOPY}")
    assert r.status_code == 409, r.text
    assert "outside the module root" in r.json()["detail"]
    for name in RETINOTOPY_FILES:
        assert (ext_atlases / name).exists(), "uninstall deleted a file outside the root"

    # The tractogram is a `slot`, not a managed `data` module: it is
    # user-supplied and validated structurally, so the app never claims to own
    # it. Uninstall must decline (404/409 — nothing installable under that id)
    # and, critically, must not touch the user-supplied file.
    r = client.delete(f"/api/modules/{TRACTOGRAPHY}")
    assert r.status_code in (404, 409), r.text
    assert ext_trk.exists(), "uninstall deleted a user-supplied slot file"
    assert ext_trk.read_bytes() == b"pretend tractogram"


def test_uninstall_refuses_when_an_env_override_points_outside_the_root(
        client, env, monkeypatch, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    for name, data in _retinotopy_payload().items():
        # Atlas payload paths now carry a per-family subfolder.
        dest = outside / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    monkeypatch.setenv("ATLAS_DIR", str(outside))

    r = client.delete(f"/api/modules/{RETINOTOPY}")
    assert r.status_code == 409, r.text
    assert "outside the module root" in r.json()["detail"]
    # Recurse: atlas payloads are nested one family subfolder deep, so
    # iterdir() would count directories rather than the files it must preserve.
    assert len([p for p in outside.rglob("*") if p.is_file()]) == len(RETINOTOPY_FILES)

    # And an override outside the root is refused for INSTALL too, rather than
    # silently writing there.
    r = upload(client, RETINOTOPY, retinotopy_zip(tmp_path / "r.zip"))
    assert r.status_code == 409, r.text
    assert "refusing to install" in r.json()["detail"]


def test_checked_in_data_module_is_not_uninstallable(client, env):
    """Files planted directly under the module root (no sideload, no ledger
    entry) simulate the repo-tracked payloads — mni152-template, atlases-core
    — that ship with a checkout. `installed` is true (the files are there),
    but `uninstallable` must be false: the store's button would otherwise
    tell the user this is deletable when `_uninstall_guard` always 409s it."""
    for rel, data in _retinotopy_payload().items():
        dest = env.root / "atlases" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)

    state = module_state(client, RETINOTOPY)
    assert state["installed"] is True
    assert state["uninstallable"] is False

    r = client.delete(f"/api/modules/{RETINOTOPY}")
    assert r.status_code == 409, r.text
    assert "no install-ledger entry" in r.json()["detail"]
    for rel in RETINOTOPY_FILES:
        assert (env.root / "atlases" / rel).exists(), "uninstall deleted checked-in data"


def test_verify_registers_a_checked_in_data_module(client, env):
    """Files present on disk with no ledger entry (same shape as the previous
    test — the mni152-template/atlases-core case) are exactly what Verify is
    for: a deep hash check against the manifest writes the ledger entry as a
    side effect (see verify_module -> _write_ledger). This is the zero-network,
    one-click way back after an accidental uninstall of a checked-in module —
    no download job, no sourceUrl, just re-hashing files that are already
    sitting there."""
    for rel, data in _retinotopy_payload().items():
        dest = env.root / "atlases" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)

    assert module_state(client, RETINOTOPY)["uninstallable"] is False

    v = client.post(f"/api/modules/{RETINOTOPY}/verify").json()
    assert v["ok"] is True, v

    state = module_state(client, RETINOTOPY)
    assert state["verified"] is True
    assert state["uninstallable"] is True


def test_data_module_uninstall_goes_through_the_recycle_bin(client, env, tmp_path):
    """A data module's uninstall used to call path.unlink() directly — a
    ledger-backed download you'd want back is gone for good, and in a dev
    checkout the same files are git-tracked, so a permanent delete needlessly
    stacks a second, harsher way to lose them. Route through _remove_payload
    (already used by slot uninstall) so it lands in the recycle bin instead."""
    assert upload(client, RETINOTOPY, retinotopy_zip(tmp_path / "r.zip")).status_code == 200

    r = client.delete(f"/api/modules/{RETINOTOPY}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["disposition"] in ("trashed", "deleted")
    assert body["bytesFreed"] > 0
    for name in RETINOTOPY_FILES:
        assert not (env.root / "atlases" / name).exists()


def test_uninstall_frees_space_and_regates(client, env, tmp_path):
    assert upload(client, RETINOTOPY, retinotopy_zip(tmp_path / "r.zip")).status_code == 200
    assert snapshot(client)["capabilities"]["retinotopy"] is True

    r = client.delete(f"/api/modules/{RETINOTOPY}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["bytesFreed"] == sum(f["bytes"] for f in RETINOTOPY_ENTRY["files"])
    assert body["capabilities"]["retinotopy"] is False
    for name in RETINOTOPY_FILES:
        assert not (env.root / "atlases" / name).exists()
    assert module_state(client, RETINOTOPY)["state"] == "missing"
    assert RETINOTOPY not in json.loads(
        (env.root / "manifest.installed.json").read_text())["modules"]


def test_uninstall_leaves_the_other_modules_sharing_the_atlases_dir(client, env, tmp_path):
    """Four modules install into `atlases`. Removing one must not remove the
    directory (or its neighbours) with it."""
    assert upload(client, RETINOTOPY, retinotopy_zip(tmp_path / "r.zip")).status_code == 200
    neighbour = env.root / "atlases" / "aal" / "aal_atlas.nii.gz"   # atlases-core's
    neighbour.parent.mkdir(parents=True, exist_ok=True)
    neighbour.write_bytes(b"neighbour")

    assert client.delete(f"/api/modules/{RETINOTOPY}").status_code == 200
    assert neighbour.exists()
    assert (env.root / "atlases").is_dir()


# === 6. Download engine, against a LOCAL http.server =========================

@pytest.fixture
def http_server(tmp_path):
    """`python -m http.server` on an ephemeral loopback port. Never the public
    internet, and never port 8001."""
    serve_dir = tmp_path / "release"
    (serve_dir / "modules-v1").mkdir(parents=True)

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    assert port > 8100 and port != 8001

    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port),
         "--bind", "127.0.0.1", "--directory", str(serve_dir)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                break
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError("http.server died on startup")
            time.sleep(0.05)
    else:
        proc.kill()
        raise RuntimeError("http.server never came up")

    class Server:
        pass

    srv = Server()
    srv.port = port
    srv.dir = serve_dir
    srv.base = f"http://127.0.0.1:{port}"
    try:
        yield srv
    finally:
        proc.kill()
        proc.wait(timeout=10)


def _await_job(client, job_id, timeout=60):
    deadline = time.monotonic() + timeout
    status = {}
    while time.monotonic() < deadline:
        r = client.get(f"/api/modules/jobs/{job_id}")
        assert r.status_code == 200, r.text
        status = r.json()
        if status.get("done"):
            return status
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish: {status}")


def test_download_install_from_local_http_server(client, env, http_server, monkeypatch):
    retinotopy_zip(http_server.dir / "modules-v1" / "retinotopy-benson-wang.zip")
    monkeypatch.setenv("MRLATTE_MODULE_RELEASE_BASE", http_server.base)

    assert module_state(client, RETINOTOPY)["downloadable"] is True
    r = client.post(f"/api/modules/{RETINOTOPY}/install", json={})
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    assert r.json()["url"] == f"{http_server.base}/modules-v1/retinotopy-benson-wang.zip"

    status = _await_job(client, job_id)
    assert status["stage"] == "done", status
    assert status["error"] is None
    assert status["bytes_total"] and status["bytes_done"] == status["bytes_total"]

    for f in RETINOTOPY_ENTRY["files"]:
        dest = env.root / "atlases" / f["path"]
        assert hashlib.sha256(dest.read_bytes()).hexdigest() == f["sha256"]
    assert snapshot(client)["capabilities"]["retinotopy"] is True
    assert module_state(client, RETINOTOPY)["verified"] is True
    # The staged download is cleaned up, and no .part survives.
    staging = env.root / ".staging"
    assert not staging.exists() or list(staging.glob("*")) == []
    assert atlas_files(env.root, "*.part") == []


def test_download_of_a_corrupt_archive_errors_and_promotes_nothing(
        client, env, http_server, monkeypatch):
    retinotopy_zip(http_server.dir / "modules-v1" / "retinotopy-benson-wang.zip",
                   corrupt="benson14/benson14_eccentricity.nii.gz")
    monkeypatch.setenv("MRLATTE_MODULE_RELEASE_BASE", http_server.base)

    job_id = client.post(f"/api/modules/{RETINOTOPY}/install", json={}).json()["job_id"]
    status = _await_job(client, job_id)
    assert status["stage"] == "error", status
    assert status["error"]["error"] == "sha256 mismatch"
    assert status["error"]["file"] == "benson14/benson14_eccentricity.nii.gz"
    assert module_state(client, RETINOTOPY)["installed"] is False
    assert atlas_files(env.root) == []


def test_download_via_explicit_source_url(client, env, http_server):
    retinotopy_zip(http_server.dir / "payload.zip")
    r = client.post(f"/api/modules/{RETINOTOPY}/install",
                    json={"sourceUrl": f"{http_server.base}/payload.zip"})
    assert r.status_code == 200, r.text
    status = _await_job(client, r.json()["job_id"])
    assert status["stage"] == "done", status
    assert module_state(client, RETINOTOPY)["installed"] is True


def test_download_404_is_reported_as_a_job_error(client, env, http_server, monkeypatch):
    monkeypatch.setenv("MRLATTE_MODULE_RELEASE_BASE", http_server.base)
    job_id = client.post(f"/api/modules/{RETINOTOPY}/install", json={}).json()["job_id"]
    status = _await_job(client, job_id)
    assert status["stage"] == "error", status
    assert "404" in str(status["error"])
    assert module_state(client, RETINOTOPY)["installed"] is False


_KEEP = object()


def _solo_manifest(tmp_path, monkeypatch, payload, sha256=_KEEP):
    """A synthetic single-file module (module-level sha256, no `files` array).

    `sha256=` overrides the declared digest: None writes an explicit null, which
    the fail-closed hash policy must refuse."""
    manifest = {
        "schemaVersion": 1,
        "modules": [{
            "id": "solo", "name": "Solo", "type": "data", "tier": "optional",
            "version": "1.0.0", "unlocks": ["solo"], "bytes": len(payload),
            "sha256": (hashlib.sha256(payload).hexdigest()
                       if sha256 is _KEEP else sha256),
            "installTo": "tracts/solo.trk",
            "license": {"redistributable": True},
            "sources": [{"type": "sideload"}],
        }],
    }
    path = tmp_path / "solo-manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setenv("MRLATTE_MODULE_MANIFEST", str(path))
    mods._manifest_cache["mtime"] = None
    return manifest["modules"][0]


def test_stale_part_is_not_appended_to_when_the_server_ignores_range(
        client, env, http_server, tmp_path, monkeypatch):
    """`http.server` answers 200 to a Range request instead of 206. Blindly
    appending the full body to the existing `.part` would produce a file that
    is both too long and wrongly hashed, so the 200-after-Range case must
    restart the write from zero."""
    payload = b"solo payload " * 20000
    _solo_manifest(tmp_path, monkeypatch, payload)
    (http_server.dir / "solo.trk").write_bytes(payload)

    part = env.root / "tracts" / "solo.trk.part"
    part.parent.mkdir(parents=True)
    part.write_bytes(payload[: len(payload) // 3])      # dead transfer

    r = client.post("/api/modules/solo/install",
                    json={"sourceUrl": f"{http_server.base}/solo.trk"})
    status = _await_job(client, r.json()["job_id"])
    assert status["stage"] == "done", status
    dest = env.root / "tracts" / "solo.trk"
    assert dest.read_bytes() == payload
    assert not part.exists()


def test_cancel_stops_a_download_and_keeps_the_part_for_resume(
        client, env, http_server, tmp_path, monkeypatch):
    payload = b"x" * (4 << 20)
    _solo_manifest(tmp_path, monkeypatch, payload)
    (http_server.dir / "solo.trk").write_bytes(payload)

    assert client.post("/api/modules/solo/cancel").status_code == 404

    job_id = "00000000-0000-4000-8000-0000000000aa"
    (mods._jobs_root() / job_id).mkdir(parents=True, exist_ok=True)
    mods._set_job(job_id, stage="queued", done=False)
    mods._JOB_CANCELLED.add(job_id)
    part = env.root / "tracts" / "solo.trk.part"
    try:
        with pytest.raises(mods.JobCancelled):
            mods._download(f"{http_server.base}/solo.trk", part, job_id, len(payload))
    finally:
        mods._JOB_CANCELLED.discard(job_id)

    # Partial bytes are kept so a later install can resume; nothing promoted.
    assert not (env.root / "tracts" / "solo.trk").exists()
    assert module_state(client, "solo")["installed"] is False


def test_non_http_source_url_is_refused(client, env):
    for url in ("file:///etc/passwd", "ftp://example.com/x.zip",
                r"\\server\share\x.zip"):
        r = client.post(f"/api/modules/{RETINOTOPY}/install", json={"sourceUrl": url})
        assert r.status_code == 400, (url, r.text)


# === 7. Sources, jobs, and out-of-scope module types =========================

def test_non_redistributable_module_is_a_slot_and_cannot_be_downloaded(client, env):
    """The two HCP-derived assets are `slot` modules: user-supplied, validated
    structurally, never fetched. Neither the store nor the installer may offer
    a download for them."""
    for mid in (TRACTOGRAPHY, LNM):
        state = module_state(client, mid)
        assert state["type"] == "slot", mid
        assert state["downloadable"] is False, mid
        assert state["sideloadable"] is False, mid
        assert state["license"]["redistributable"] is False, mid
        # The slot declares where the file goes.
        assert state["slot"]["directory"], mid
        # A slot IS installable — by path, via /slot-install — so it carries no
        # "not installable" reason. `sideloadable` stays False above because
        # that is the hash-verified UPLOAD path, which a slot never uses.
        assert state["slotInstallable"] is True, mid
        assert state["notInstallableReason"] is None, mid
        # No source may promise a download.
        assert all(s.get("type") == "sideload" for s in state["sources"]), mid

    r = client.post(f"/api/modules/{TRACTOGRAPHY}/install", json={})
    assert r.status_code in (404, 409), r.text


def test_python_package_modules_are_not_installable(client, env):
    state = module_state(client, "reports-figures")
    assert state["sideloadable"] is False
    assert state["notInstallableReason"]
    for path, kwargs in (("install", {"json": {}}), ("verify", {})):
        r = client.post(f"/api/modules/reports-figures/{path}", **kwargs)
        assert r.status_code == 409, r.text
    r = client.delete("/api/modules/reports-figures")
    assert r.status_code == 409, r.text


def test_unknown_module_is_404(client, env):
    assert client.post("/api/modules/nope/install", json={}).status_code == 404
    assert client.delete("/api/modules/nope").status_code == 404


# === 8. Slot install: a PATH, copied or registered ===========================
# Slot payloads are user-supplied, hundreds of MB, and validated structurally
# rather than by hash — so they are selected by path, not uploaded.

def make_trk(path, n_streamlines=3):
    """A minimal but genuinely VALID whole-brain-shaped .trk.

    `b"pretend tractogram"` (used elsewhere in this file, where only the guard
    is under test) would be rejected by validate_tractogram — which is exactly
    what these tests need to distinguish.
    """
    import numpy as np
    from nibabel.streamlines import Tractogram
    from nibabel.streamlines.trk import TrkFile

    affine = np.eye(4, dtype=np.float32)
    affine[:3, 3] = [-90.0, -126.0, -72.0]        # 1 mm MNI-ish corner
    lines = [np.array([[10., 10., 10.], [11., 12., 13.], [14., 15., 16.]],
                      dtype=np.float32) for _ in range(n_streamlines)]
    header = {
        "voxel_to_rasmm": affine,
        "dimensions": np.array([181, 217, 181], dtype=np.int16),
        "voxel_sizes": np.array([1.0, 1.0, 1.0], dtype=np.float32),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    TrkFile(Tractogram(lines, affine_to_rasmm=np.eye(4)), header=header).save(str(path))
    return path


def slot_install(client, module_id, path, mode="copy"):
    return client.post(f"/api/modules/{module_id}/slot-install",
                       json={"path": str(path), "mode": mode})


def test_slot_install_copy_flips_the_capability(client, env):
    src = make_trk(env.tmp / "elsewhere" / "whole_brain.trk")
    assert module_state(client, TRACTOGRAPHY)["installed"] is False
    assert snapshot(client)["capabilities"]["dissect"] is False

    r = slot_install(client, TRACTOGRAPHY, src, mode="copy")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "copy"
    assert body["capabilities"]["dissect"] is True
    assert body["details"]["streamlines"] == 3

    # Copied into the slot directory under the module root, original untouched.
    dest = env.root / "tracts" / "whole_brain.trk"
    assert dest.is_file()
    assert src.is_file()
    state = module_state(client, TRACTOGRAPHY)
    assert state["state"] == "installed"
    assert state["slotMode"] == "copy"


def test_slot_install_link_registers_without_copying(client, env):
    src = make_trk(env.tmp / "elsewhere" / "whole_brain.trk")

    r = slot_install(client, TRACTOGRAPHY, src, mode="link")
    assert r.status_code == 200, r.text
    assert r.json()["capabilities"]["dissect"] is True

    # Nothing was written into the module root.
    assert not (env.root / "tracts" / "whole_brain.trk").exists()
    state = module_state(client, TRACTOGRAPHY)
    assert state["slotMode"] == "link"
    assert state["path"] == str(src)

    # deps.slot_path must agree, or the capability would be on while every
    # worker resolved somewhere else.
    assert Path(str(deps.GLOBAL_TRACT_FILE)) == src
    assert deps.GLOBAL_TRACT_FILE.exists() is True


def test_slot_install_rejects_a_tck_with_the_validators_own_reason(client, env):
    bad = env.tmp / "elsewhere" / "streams.tck"
    bad.parent.mkdir(parents=True, exist_ok=True)
    bad.write_bytes(b"not really a tractogram")

    r = slot_install(client, TRACTOGRAPHY, bad)
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    # The extension gate fires before the validator here; either way the message
    # must name the real problem rather than a generic failure.
    assert ".tck" in json.dumps(detail) or "expected .trk" in json.dumps(detail)
    assert module_state(client, TRACTOGRAPHY)["installed"] is False


def test_slot_install_rejects_a_structurally_invalid_file(client, env):
    """Right extension, wrong contents — this reaches the validator proper."""
    bad = env.tmp / "elsewhere" / "broken.trk"
    bad.parent.mkdir(parents=True, exist_ok=True)
    bad.write_bytes(b"TRK\x00 not really")

    r = slot_install(client, TRACTOGRAPHY, bad)
    assert r.status_code == 400, r.text
    assert "reason" in r.json()["detail"]
    assert module_state(client, TRACTOGRAPHY)["installed"] is False


def test_slot_install_refuses_a_relative_path(client, env):
    r = slot_install(client, TRACTOGRAPHY, "tracts/x.trk")
    assert r.status_code == 400, r.text
    assert "absolute" in json.dumps(r.json()["detail"])


def test_slot_install_refuses_a_non_slot_module(client, env):
    src = make_trk(env.tmp / "elsewhere" / "x.trk")
    r = slot_install(client, RETINOTOPY, src)
    assert r.status_code == 409, r.text


def test_uninstalling_a_link_slot_keeps_the_users_file(client, env):
    src = make_trk(env.tmp / "elsewhere" / "whole_brain.trk")
    assert slot_install(client, TRACTOGRAPHY, src, mode="link").status_code == 200

    r = client.delete(f"/api/modules/{TRACTOGRAPHY}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["unregisteredOnly"] is True
    assert body["removed"] == []
    assert body["bytesFreed"] == 0
    # Rule 6: the user's own file was never ours to delete.
    assert src.is_file(), "uninstall deleted the user's original file"
    assert module_state(client, TRACTOGRAPHY)["installed"] is False


def test_uninstalling_a_copy_slot_removes_only_the_copy(client, env):
    src = make_trk(env.tmp / "elsewhere" / "whole_brain.trk")
    assert slot_install(client, TRACTOGRAPHY, src, mode="copy").status_code == 200
    dest = env.root / "tracts" / "whole_brain.trk"
    assert dest.is_file()

    r = client.delete(f"/api/modules/{TRACTOGRAPHY}")
    assert r.status_code == 200, r.text
    assert r.json()["bytesFreed"] > 0
    assert not dest.exists()
    assert src.is_file(), "uninstall deleted the source, not the copy"


def test_hand_dropped_slot_file_can_be_uninstalled(client, env):
    """The slot directory is a place this app tells the user to use, so it may
    clean it up — no ledger entry required. This is the one deliberate
    relaxation of rule 6, and it stays bounded to inside the module root."""
    dropped = make_trk(env.root / "tracts" / "dropped_by_hand.trk")
    state = module_state(client, TRACTOGRAPHY)
    assert state["installed"] is True
    assert state["uninstallable"] is True

    r = client.delete(f"/api/modules/{TRACTOGRAPHY}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["bytesFreed"] > 0
    assert body["disposition"] in ("trashed", "deleted")
    assert not dropped.exists()
    assert module_state(client, TRACTOGRAPHY)["installed"] is False


def test_slot_uninstall_refuses_through_an_env_override(client, env, monkeypatch):
    """An override points at storage this app does not manage — the file is not
    ours to delete no matter what the store shows."""
    outside = make_trk(env.tmp / "managed-elsewhere" / "whole_brain.trk")
    monkeypatch.setenv("GLOBAL_TRACT_FILE", str(outside))

    state = module_state(client, TRACTOGRAPHY)
    assert state["installed"] is True
    assert state["uninstallable"] is False, "would render a button that always 409s"

    r = client.delete(f"/api/modules/{TRACTOGRAPHY}")
    assert r.status_code == 409, r.text
    assert "GLOBAL_TRACT_FILE" in r.json()["detail"]
    assert outside.is_file(), "uninstall deleted a file behind an env override"


def test_a_moved_linked_file_is_broken_with_its_path_not_missing(client, env):
    src = make_trk(env.tmp / "elsewhere" / "whole_brain.trk")
    assert slot_install(client, TRACTOGRAPHY, src, mode="link").status_code == 200

    src.rename(env.tmp / "elsewhere" / "moved_away.trk")
    state = module_state(client, TRACTOGRAPHY)
    assert state["state"] == "broken"
    # "missing" would send the user hunting in the slot directory for a file
    # that was never there.
    assert str(src) in state["slot"]["reason"]


def test_a_file_added_mid_session_is_seen_without_a_restart(client, env):
    """deps resolves slots per access, so a drop-in during a running server is
    picked up on the next request rather than at the next restart."""
    assert deps.GLOBAL_TRACT_FILE.exists() is False
    assert snapshot(client)["capabilities"]["dissect"] is False

    make_trk(env.root / "tracts" / "late_arrival.trk")

    assert snapshot(client)["capabilities"]["dissect"] is True
    assert deps.GLOBAL_TRACT_FILE.exists() is True
    assert Path(str(deps.GLOBAL_TRACT_FILE)).name == "late_arrival.trk"


def test_unknown_and_malformed_job_ids(client, env):
    assert client.get("/api/modules/jobs/not-a-uuid").status_code == 400
    assert client.get(
        "/api/modules/jobs/00000000-0000-4000-8000-000000000000").status_code == 404


def test_single_file_module_sideload_raw_and_zipped(client, env, tmp_path, monkeypatch):
    """Single-file modules carry a module-level sha256 and no `files` array —
    the other manifest shape. Verified here with a synthetic manifest so the
    test does not need the real 706 MB asset."""
    payload = b"synthetic tractogram payload" * 1000
    digest = hashlib.sha256(payload).hexdigest()
    _solo_manifest(tmp_path, monkeypatch, payload)

    raw = tmp_path / "solo.trk"
    raw.write_bytes(payload)
    assert upload(client, "solo", raw).status_code == 200
    dest = env.root / "tracts" / "solo.trk"
    assert dest.read_bytes() == payload
    assert snapshot(client)["capabilities"]["solo"] is True

    # Same asset, this time inside a zip whose member name does not match.
    assert client.delete("/api/modules/solo").status_code == 200
    assert not dest.exists()
    zipped = build_zip(tmp_path / "solo.zip", {"whatever-name.trk": payload})
    assert upload(client, "solo", zipped).status_code == 200
    assert dest.read_bytes() == payload

    # And a corrupt one is refused by the module-level hash.
    bad = tmp_path / "bad.trk"
    bad.write_bytes(payload[:-1] + b"X")
    r = upload(client, "solo", bad)
    assert r.status_code == 400
    assert r.json()["detail"]["expected"] == digest
    assert dest.read_bytes() == payload            # previous install untouched
    assert not dest.with_name(dest.name + ".part").exists()


def test_multifile_module_refuses_a_bare_file_upload(client, env, tmp_path):
    raw = tmp_path / "one.nii.gz"
    raw.write_bytes((REAL_ATLASES / "wang2015" / "wang2015_labels.json").read_bytes())
    r = upload(client, RETINOTOPY, raw)
    assert r.status_code == 400
    assert "multi-file" in json.dumps(r.json()["detail"])


# === 8. Fail-closed hash policy ==============================================
# "No hash declared" must never mean "hash verified". Nothing in the shipped
# manifest is unhashed today, which is exactly why this needs a test: the bug
# only bites the day someone adds a module with `"sha256": null`.

SOLO_PAYLOAD = b"unverifiable payload " * 500
SOLO_DEST = ("tracts", "solo.trk")


def solo_dest(env):
    return env.root.joinpath(*SOLO_DEST)


def _rewrite_manifest(tmp_path, mutate):
    """Edit the synthetic manifest in place (for cases `_solo_manifest` cannot
    express, such as omitting the sha256 key entirely)."""
    path = tmp_path / "solo-manifest.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    mutate(data["modules"][0])
    path.write_text(json.dumps(data), encoding="utf-8")
    mods._manifest_cache["mtime"] = None


def assert_nothing_installed(client, env):
    dest = solo_dest(env)
    assert not dest.exists(), "unverified bytes were promoted"
    assert not dest.with_name(dest.name + ".part").exists(), "a .part survived"
    assert module_state(client, "solo")["installed"] is False
    assert snapshot(client)["capabilities"]["solo"] is False
    assert not (env.root / "manifest.installed.json").exists()


@pytest.mark.parametrize("declared", [None, "", "   ", "TODO", "deadbeef",
                                      "z" * 64])
def test_sideload_refuses_a_file_the_manifest_declares_no_usable_sha256_for(
        client, env, tmp_path, monkeypatch, declared):
    """The important one: a single-file data module with no usable hash must be
    refused outright, not installed on trust."""
    _solo_manifest(tmp_path, monkeypatch, SOLO_PAYLOAD, sha256=declared)
    raw = tmp_path / "solo.trk"
    raw.write_bytes(SOLO_PAYLOAD)

    r = upload(client, "solo", raw)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    # A readable string, so the Module Store shows the reason rather than a
    # bare "HTTP 409" — and it names both the module and the file.
    assert isinstance(detail, str), detail
    assert mods._NO_HASH in detail
    assert "'solo'" in detail and "solo.trk" in detail
    assert "manifest" in detail
    assert_nothing_installed(client, env)


def test_sideload_refuses_when_the_sha256_key_is_absent_entirely(
        client, env, tmp_path, monkeypatch):
    """An omitted key is the same claim as an explicit null — neither is
    permission."""
    _solo_manifest(tmp_path, monkeypatch, SOLO_PAYLOAD)
    _rewrite_manifest(tmp_path, lambda m: m.pop("sha256"))

    raw = tmp_path / "solo.trk"
    raw.write_bytes(SOLO_PAYLOAD)
    r = upload(client, "solo", raw)
    assert r.status_code == 409, r.text
    assert mods._NO_HASH in r.json()["detail"]
    assert_nothing_installed(client, env)


def test_zipped_sideload_of_an_unhashed_module_is_refused_too(
        client, env, tmp_path, monkeypatch):
    """Both upload shapes go through the same gate — a zip is not a way round."""
    _solo_manifest(tmp_path, monkeypatch, SOLO_PAYLOAD, sha256=None)
    zipped = build_zip(tmp_path / "solo.zip", {"solo.trk": SOLO_PAYLOAD})
    r = upload(client, "solo", zipped)
    assert r.status_code == 409, r.text
    assert mods._NO_HASH in r.json()["detail"]
    assert_nothing_installed(client, env)


def test_download_install_of_an_unhashed_module_is_refused_before_it_starts(
        client, env, tmp_path, monkeypatch):
    """Refused at request time, so no job is created and nothing is fetched —
    the URL below would fail loudly if it were ever contacted."""
    _solo_manifest(tmp_path, monkeypatch, SOLO_PAYLOAD, sha256=None)
    r = client.post("/api/modules/solo/install",
                    json={"sourceUrl": "http://127.0.0.1:1/solo.trk"})
    assert r.status_code == 409, r.text
    assert mods._NO_HASH in r.json()["detail"]
    assert "job_id" not in r.json()
    assert_nothing_installed(client, env)


def test_verify_part_is_fail_closed_on_its_own(env):
    """Unit-level: the promote gate refuses an unhashed file even if the
    pre-flight is bypassed, so a future caller cannot reintroduce the hole."""
    part = env.root / "x.part"
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(b"whatever")
    for declared in (None, "", "not-a-hash"):
        with pytest.raises(HTTPException) as ei:
            mods._verify_part({"module": "solo", "rel": "x", "sha256": declared},
                              part)
        assert ei.value.status_code == 409
        assert mods._NO_HASH in ei.value.detail
    # A real digest still verifies, and a mismatch is still a 400.
    good = {"module": "solo", "rel": "x",
            "sha256": hashlib.sha256(b"whatever").hexdigest()}
    assert mods._verify_part(good, part) == good["sha256"]


# --- the shapes that must keep working ---------------------------------------

def test_module_level_null_sha256_with_per_file_hashes_still_installs(
        client, env, tmp_path):
    """Every multi-file `data` module in the shipped manifest has
    `sha256: null` at module level and a real digest per file. That null is
    CORRECT — the per-file hashes are the source of truth — and the fail-closed
    policy must not touch it."""
    assert RETINOTOPY_ENTRY.get("sha256") is None
    assert all(mods._SHA256_RE.match(f["sha256"]) for f in RETINOTOPY_ENTRY["files"])

    r = upload(client, RETINOTOPY, retinotopy_zip(tmp_path / "r.zip"))
    assert r.status_code == 200, r.text
    state = module_state(client, RETINOTOPY)
    assert state["installed"] is True
    assert state["verified"] is True           # every file had a real digest
    v = client.post(f"/api/modules/{RETINOTOPY}/verify").json()
    assert v["ok"] is True and v["unhashed"] == []


def test_slot_and_python_package_modules_are_unaffected(client, env):
    """Neither type carries a hash, and neither reaches the installer. They must
    keep failing the way they always did (409 'not installable'), not with a
    hash complaint."""
    for mid in (TRACTOGRAPHY, LNM, "reports-figures", "validation-neuropythy"):
        r = client.post(f"/api/modules/{mid}/install", json={})
        assert r.status_code == 409, (mid, r.text)
        detail = json.dumps(r.json()["detail"])
        assert "not installable" in detail, (mid, detail)
        assert "sha256" not in detail, (mid, detail)
        assert module_state(client, mid)["state"] in ("missing", "broken", "installed")


def _multifile_manifest(tmp_path, monkeypatch, blobs, unhashed=()):
    """A synthetic multi-file module: module-level sha256 null (correct), a
    per-file digest for every file except those named in `unhashed`."""
    manifest = {
        "schemaVersion": 1,
        "modules": [{
            "id": "pack", "name": "Pack", "type": "data", "tier": "optional",
            "version": "1.0.0", "unlocks": ["pack"],
            "bytes": sum(len(b) for b in blobs.values()),
            "sha256": None,                     # correct for a multi-file module
            "installTo": "pack",
            "license": {"redistributable": True},
            "sources": [{"type": "sideload"}],
            "files": [{
                "path": rel,
                "bytes": len(blob),
                "sha256": (None if rel in unhashed
                           else hashlib.sha256(blob).hexdigest()),
            } for rel, blob in blobs.items()],
        }],
    }
    path = tmp_path / "pack-manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setenv("MRLATTE_MODULE_MANIFEST", str(path))
    mods._manifest_cache["mtime"] = None
    return manifest["modules"][0]


PACK_BLOBS = {"a/first.bin": b"first blob " * 100,
              "b/second.bin": b"second blob " * 100}


def test_multifile_module_installs_when_every_file_declares_a_hash(
        client, env, tmp_path, monkeypatch):
    _multifile_manifest(tmp_path, monkeypatch, PACK_BLOBS)
    r = upload(client, "pack", build_zip(tmp_path / "pack.zip", PACK_BLOBS))
    assert r.status_code == 200, r.text
    for rel, blob in PACK_BLOBS.items():
        assert (env.root / "pack" / rel).read_bytes() == blob
    assert module_state(client, "pack")["verified"] is True


def test_multifile_module_with_one_unhashed_file_is_refused_whole(
        client, env, tmp_path, monkeypatch):
    """One unhashed file poisons the whole install: the module is refused before
    extraction, so even the files that DID declare a digest are not promoted."""
    _multifile_manifest(tmp_path, monkeypatch, PACK_BLOBS,
                        unhashed=("b/second.bin",))
    r = upload(client, "pack", build_zip(tmp_path / "pack.zip", PACK_BLOBS))
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert mods._NO_HASH in detail
    assert "'pack'" in detail and "b/second.bin" in detail
    assert not (env.root / "pack").exists()
    assert module_state(client, "pack")["installed"] is False


# --- the explicit opt-out ----------------------------------------------------

def test_explicit_unverified_optout_installs_but_is_never_recorded_verified(
        client, env, tmp_path, monkeypatch, caplog):
    """The one way past the gate has to be written down in the manifest, and it
    buys an install — never a `verified` claim."""
    _solo_manifest(tmp_path, monkeypatch, SOLO_PAYLOAD, sha256="unverified")
    raw = tmp_path / "solo.trk"
    raw.write_bytes(SOLO_PAYLOAD)

    with caplog.at_level(logging.WARNING):
        r = upload(client, "solo", raw)
    assert r.status_code == 200, r.text
    assert solo_dest(env).read_bytes() == SOLO_PAYLOAD

    # Loud at install time, so an opt-out cannot pass unnoticed.
    assert any("UNVERIFIED" in rec.getMessage() and "solo" in rec.getMessage()
               for rec in caplog.records), caplog.text

    state = module_state(client, "solo")
    assert state["installed"] is True
    assert state["verified"] is False, "an opt-out must not claim verification"
    record = json.loads(
        (env.root / "manifest.installed.json").read_text())["modules"]["solo"]
    assert record["verified"] is False

    # ...and a deep verify still refuses to upgrade that claim.
    v = client.post("/api/modules/solo/verify").json()
    assert v["unhashed"] == ["solo.trk"]
    assert module_state(client, "solo")["verified"] is False
