"""scripts/modules.mjs — the dev-side installer, driven as a real subprocess.

The Node CLI and the FastAPI installer are two implementations of one policy, so
the fail-closed hash rule has to hold in both. These tests shell out to `node`
against a synthetic manifest and a loopback http.server started in-process on an
ephemeral port: nothing reaches the public internet, nothing binds 8001, and
MRLATTE_MODULE_ROOT is always a tmp_path so the CLI never writes into the repo.

Skipped wholesale when `node` is not on PATH — a Python-only checkout should not
fail the suite over a JS tool.
"""
import hashlib
import json
import os
import shutil
import subprocess
import threading
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI = REPO_ROOT / "tools" / "scripts" / "modules.mjs"

NODE = shutil.which("node")
pytestmark = [
    pytest.mark.skipif(NODE is None, reason="node is not on PATH"),
    pytest.mark.skipif(not CLI.exists(), reason=f"{CLI} is missing"),
]


# === Loopback release host ====================================================

@pytest.fixture
def host(tmp_path):
    """A file server on 127.0.0.1:<ephemeral>, recording every path it is asked
    for — which is how the tests prove a refusal happened BEFORE any download."""
    served = tmp_path / "release"
    served.mkdir()
    asked = []

    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self):                       # noqa: N802 (stdlib naming)
            asked.append(self.path)
            super().do_GET()

        def log_message(self, *_a):             # keep pytest output clean
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0),
                              partial(Handler, directory=str(served)))
    port = srv.server_address[1]
    assert port != 8001, "must not collide with the dev backend"
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield SimpleNamespace(dir=served, base=f"http://127.0.0.1:{port}",
                              asked=asked)
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join(timeout=10)


# === Manifests ================================================================

_KEEP = object()


def solo_manifest(tmp_path, payload, sha256=_KEEP, asset="solo.bin"):
    """Single-file data module: module-level sha256, no `files` array."""
    entry = {
        "id": "solo", "name": "Solo", "type": "data", "tier": "optional",
        "version": "1.0.0", "unlocks": ["solo"], "bytes": len(payload),
        "sha256": (hashlib.sha256(payload).hexdigest()
                   if sha256 is _KEEP else sha256),
        "installTo": "tracts/solo.bin",
        "license": {"redistributable": True},
        "sources": [{"type": "github-release", "asset": asset}],
    }
    return _write_manifest(tmp_path, entry)


def pack_manifest(tmp_path, blobs, unhashed=(), asset="pack.zip"):
    """Multi-file data module: module-level sha256 NULL (which is correct and
    must keep working) plus a per-file digest, except where `unhashed` says."""
    entry = {
        "id": "pack", "name": "Pack", "type": "data", "tier": "optional",
        "version": "1.0.0", "unlocks": ["pack"],
        "bytes": sum(len(b) for b in blobs.values()),
        "sha256": None,
        "installTo": "pack",
        "license": {"redistributable": True},
        "sources": [{"type": "github-release", "asset": asset}],
        "files": [{"path": rel, "bytes": len(blob),
                   "sha256": (None if rel in unhashed
                              else hashlib.sha256(blob).hexdigest())}
                  for rel, blob in blobs.items()],
    }
    return _write_manifest(tmp_path, entry)


def _write_manifest(tmp_path, entry):
    path = tmp_path / f"{entry['id']}-manifest.json"
    path.write_text(json.dumps({"schemaVersion": 1, "modules": [entry]}),
                    encoding="utf-8")
    return path


# === Running the CLI ==========================================================

@pytest.fixture
def root(tmp_path):
    """Scratch module root. Never the repo's data/modules."""
    return tmp_path / "module-root"


def cli(args, manifest, root, base=None, extra_env=None):
    env = dict(os.environ)
    env.update({
        "MRLATTE_MODULE_MANIFEST": str(manifest),
        "MRLATTE_MODULE_ROOT": str(root),
        "NO_COLOR": "1",
    })
    env.pop("MRLATTE_MODULE_RELEASE_BASE", None)
    if base:
        env["MRLATTE_MODULE_RELEASE_BASE"] = base
    env.update(extra_env or {})
    return subprocess.run([NODE, str(CLI), *args], capture_output=True,
                          text=True, env=env, cwd=str(REPO_ROOT), timeout=180)


def files_under(root):
    return sorted(p.relative_to(root).as_posix()
                  for p in root.rglob("*") if p.is_file()) if root.exists() else []


PAYLOAD = b"unverifiable payload " * 500
BLOBS = {"a/first.bin": b"first blob " * 200,
         "b/second.bin": b"second blob " * 200}


def build_zip(path, members):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return path


def ledger(root):
    return json.loads((root / "manifest.installed.json").read_text())["modules"]


# === 1. Fail closed on a missing hash ========================================

@pytest.mark.parametrize("declared", [None, "", "TODO", "deadbeef"])
def test_add_refuses_a_module_with_no_usable_sha256(tmp_path, root, host, declared):
    """The important one, CLI side: no declared hash means no install — and the
    refusal lands before a single byte is fetched."""
    (host.dir / "solo.bin").write_bytes(PAYLOAD)
    manifest = solo_manifest(tmp_path, PAYLOAD, sha256=declared)

    r = cli(["add", "solo"], manifest, root, base=host.base)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "refusing to install solo" in r.stderr
    assert "sha256" in r.stderr and "solo.bin" in r.stderr
    assert "refused 1" in r.stdout

    assert host.asked == [], f"the CLI downloaded before refusing: {host.asked}"
    assert files_under(root) == []


def test_add_refuses_when_the_sha256_key_is_absent(tmp_path, root, host):
    (host.dir / "solo.bin").write_bytes(PAYLOAD)
    manifest = solo_manifest(tmp_path, PAYLOAD)
    data = json.loads(manifest.read_text())
    data["modules"][0].pop("sha256")            # omitted, not null
    manifest.write_text(json.dumps(data), encoding="utf-8")

    r = cli(["add", "solo"], manifest, root, base=host.base)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "declares no sha256" in r.stderr
    assert host.asked == []
    assert files_under(root) == []


def test_add_refuses_a_multifile_module_when_one_file_has_no_hash(
        tmp_path, root, host):
    """One unhashed file refuses the whole module, so the files that DID declare
    a digest are not installed either."""
    build_zip(host.dir / "pack.zip", BLOBS)
    manifest = pack_manifest(tmp_path, BLOBS, unhashed=("b/second.bin",))

    r = cli(["add", "pack"], manifest, root, base=host.base)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "refusing to install pack" in r.stderr
    assert "b/second.bin" in r.stderr
    assert host.asked == []
    assert files_under(root) == []


# === 2. The shapes that must keep working ====================================

def test_add_installs_a_single_file_module_with_a_declared_hash(
        tmp_path, root, host):
    """Positive control: the refusal above is about the missing hash, not about
    the CLI being broken."""
    (host.dir / "solo.bin").write_bytes(PAYLOAD)
    manifest = solo_manifest(tmp_path, PAYLOAD)

    r = cli(["add", "solo"], manifest, root, base=host.base)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (root / "tracts" / "solo.bin").read_bytes() == PAYLOAD
    assert files_under(root) == ["manifest.installed.json", "tracts/solo.bin"]
    assert ledger(root)["solo"]["verified"] is True
    assert host.asked == ["/solo.bin"]


def test_add_installs_a_multifile_module_whose_module_level_sha256_is_null(
        tmp_path, root, host):
    """Every shipped multi-file module looks like this: `sha256: null` at module
    level, real digests in `files[]`. That null is correct and must not trip the
    fail-closed check."""
    build_zip(host.dir / "pack.zip", BLOBS)
    manifest = pack_manifest(tmp_path, BLOBS)
    assert json.loads(manifest.read_text())["modules"][0]["sha256"] is None

    r = cli(["add", "pack"], manifest, root, base=host.base)
    assert r.returncode == 0, r.stdout + r.stderr
    for rel, blob in BLOBS.items():
        assert (root / "pack" / rel).read_bytes() == blob
    assert ledger(root)["pack"]["verified"] is True
    assert not list(root.rglob("*.part"))

    v = cli(["verify", "pack", "--json"], manifest, root)
    assert v.returncode == 0, v.stdout + v.stderr
    report = json.loads(v.stdout)[0]
    assert report["verdict"] == "OK"
    assert all(f["hashed"] and f["ok"] for f in report["files"])


def test_a_corrupt_download_is_still_rejected_by_the_hash(tmp_path, root, host):
    (host.dir / "solo.bin").write_bytes(PAYLOAD[:-1] + b"X")
    manifest = solo_manifest(tmp_path, PAYLOAD)     # digest of the GOOD payload

    r = cli(["add", "solo"], manifest, root, base=host.base)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "sha256 mismatch" in r.stderr
    assert files_under(root) == []                  # not promoted, .part cleaned


# === 3. The explicit opt-out =================================================

def test_explicit_unverified_optout_installs_loudly_and_is_not_verified(
        tmp_path, root, host):
    (host.dir / "solo.bin").write_bytes(PAYLOAD)
    manifest = solo_manifest(tmp_path, PAYLOAD, sha256="unverified")

    r = cli(["add", "solo"], manifest, root, base=host.base)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (root / "tracts" / "solo.bin").read_bytes() == PAYLOAD
    # Announced on stderr, in the imperative: an opt-out is never silent.
    assert "unverified" in r.stderr and "WITHOUT integrity verification" in r.stderr
    assert ledger(root)["solo"]["verified"] is False


# === 4. remove still refuses to leave the module root ========================

def test_remove_still_refuses_anything_outside_the_module_root(tmp_path, root):
    """Regression guard for the property this CLI exists to preserve: it must
    never delete files outside the module root. A per-asset env override can
    point a module at such a location (e.g. user-supplied data that cannot be
    re-downloaded); exercised here through an override so the test never goes
    near the repo's own files."""
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    victim = outside / "solo.bin"
    victim.write_bytes(PAYLOAD)

    manifest = solo_manifest(tmp_path, PAYLOAD)
    data = json.loads(manifest.read_text())
    data["modules"][0]["envVar"] = "SOLO_PATH"
    manifest.write_text(json.dumps(data), encoding="utf-8")

    r = cli(["remove", "solo"], manifest, root,
            extra_env={"SOLO_PATH": str(victim)})
    assert r.returncode == 1, r.stdout + r.stderr
    assert "refusing to remove solo" in r.stderr
    assert "outside the module root" in r.stderr
    assert victim.read_bytes() == PAYLOAD, "remove deleted a file outside the root"
