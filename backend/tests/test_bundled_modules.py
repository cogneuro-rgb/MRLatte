"""The installed app's bundled data modules: the template and the core atlases
ship in resources\\modules (MRLATTE_BUNDLED_MODULES) and are seeded into the
module root once each, as app installs — removable, reinstalled from that copy
without a download, and never re-seeded after a removal. Older builds seeded
copies with no ledger entry; those are adopted when every pinned file matches.

Everything runs against a scratch module root and a scratch bundled folder
built from the repo's own atlases; nothing reaches the internet."""
import json
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import deps
import routers.modules as mods
from server import app

REPO = Path(__file__).resolve().parents[2]
MANIFEST = REPO / "data" / "modules" / "manifest.json"
ATLASES = REPO / "data" / "modules" / "atlases"
ENTRIES = {e["id"]: e for e in json.loads(MANIFEST.read_text(encoding="utf-8"))["modules"]}
BUNDLED = sorted(mid for mid, e in ENTRIES.items() if e.get("bundled"))


def _copy_files(entry, dest_atlases):
    for f in entry["files"]:
        dest = dest_atlases / f["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ATLASES / f["path"], dest)


@pytest.fixture
def env(tmp_path, monkeypatch):
    root = tmp_path / "module-root"
    root.mkdir()
    bundled = tmp_path / "resources-modules"
    for mid in BUNDLED:
        _copy_files(ENTRIES[mid], bundled / "atlases")
    monkeypatch.setattr(deps, "MODULE_ROOT", root)
    monkeypatch.setattr(deps, "ATLAS_DIR", root / "atlases")
    monkeypatch.setenv("MRLATTE_MODULE_MANIFEST", str(MANIFEST))
    monkeypatch.setenv("MRLATTE_MODULE_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("MRLATTE_BUNDLED_MODULES", str(bundled))
    # A release base nothing listens on: an install that tried to download would fail.
    monkeypatch.setenv("MRLATTE_MODULE_RELEASE_BASE", "http://127.0.0.1:9/nowhere")
    monkeypatch.delenv("ATLAS_DIR", raising=False)
    monkeypatch.setitem(__import__("sys").modules, "send2trash", None)   # plain delete in tests
    mods._manifest_cache["mtime"] = None
    return type("Env", (), {"root": root, "atlases": root / "atlases", "bundled": bundled})


def _state(client, mid):
    return next(m for m in client.get("/api/modules").json()["modules"] if m["id"] == mid)


def _await(client, job_id):
    for _ in range(750):
        s = client.get(f"/api/modules/jobs/{job_id}").json()
        if s.get("done"):
            return s
        time.sleep(0.02)
    raise AssertionError("job never finished")


def test_seeds_each_bundled_module_once_and_a_removal_sticks(env):
    assert sorted(mods.seed_bundled_modules()["seeded"]) == BUNDLED
    client = TestClient(app)
    for mid in BUNDLED:
        m = _state(client, mid)
        assert m["installed"] and m["uninstallable"] and m["bundled"], mid
    assert client.delete("/api/modules/atlas-aal").status_code == 200
    assert not (env.atlases / "aal" / "aal.nii.gz").exists()
    # The next start: nothing comes back.
    assert mods.seed_bundled_modules() == {"seeded": [], "adopted": []}
    assert not (env.atlases / "aal" / "aal.nii.gz").exists()
    assert _state(client, "atlas-aal")["installed"] is False


def test_reinstall_copies_the_installers_copy_without_a_download(env):
    mods.seed_bundled_modules()
    client = TestClient(app)
    client.delete("/api/modules/mni152-template")
    m = _state(client, "mni152-template")
    assert m["installed"] is False and m["downloadable"] is True
    r = client.post("/api/modules/mni152-template/install", json={})
    assert r.status_code == 200 and r.json()["source"] == "bundled", r.text
    assert _await(client, r.json()["job_id"])["stage"] == "done"
    assert (env.atlases / "mni152" / "mni152.nii.gz").exists()
    assert _state(client, "mni152-template")["uninstallable"] is True


def test_an_older_builds_copies_are_adopted_only_when_their_pins_match(env):
    """0.4.x seeded every atlas with no ledger entry. Matching copies become
    removable; an edited atlas.json (a rename) doesn't count against them, a
    changed volume does."""
    _copy_files(ENTRIES["atlas-hcp1065"], env.atlases)
    desc = env.atlases / "hcp1065_tracts" / "atlas.json"
    desc.write_text(desc.read_text(encoding="utf-8").replace("HCP1065", "Renamed"), encoding="utf-8")
    _copy_files(ENTRIES["atlas-iit"], env.atlases)
    vol = env.atlases / "iit_tracts" / "iit_tracts.nii.gz"
    blob = bytearray(vol.read_bytes())
    blob[-1] ^= 0xFF
    vol.write_bytes(bytes(blob))
    adopted = mods.seed_bundled_modules()["adopted"]
    assert "atlas-hcp1065" in adopted and "atlas-iit" not in adopted
    client = TestClient(app)
    assert _state(client, "atlas-hcp1065")["uninstallable"] is True
    assert _state(client, "atlas-iit")["uninstallable"] is False


def test_a_checkout_seeds_and_adopts_nothing(env, monkeypatch):
    monkeypatch.delenv("MRLATTE_BUNDLED_MODULES")
    _copy_files(ENTRIES["atlas-aal"], env.atlases)
    assert mods.seed_bundled_modules() == {"seeded": [], "adopted": []}
    assert _state(TestClient(app), "atlas-aal")["uninstallable"] is False


def test_seeding_leaves_an_imported_atlas_alone(env):
    mine = env.atlases / "my_atlas"
    mine.mkdir(parents=True)
    (mine / "atlas.json").write_text('{"id": "my_atlas"}', encoding="utf-8")
    mods.seed_bundled_modules()
    assert (mine / "atlas.json").read_text(encoding="utf-8") == '{"id": "my_atlas"}'
    assert "my_atlas" not in json.dumps(mods._load_ledger())


def test_release_base_is_the_manifests_unless_overridden(monkeypatch):
    mods._manifest_cache["mtime"] = None
    monkeypatch.setenv("MRLATTE_MODULE_MANIFEST", str(MANIFEST))
    monkeypatch.delenv("MRLATTE_MODULE_RELEASE_BASE", raising=False)
    entry = ENTRIES["atlas-hcp1065"]
    assert mods._download_url_for(entry, None) == (
        "https://github.com/cogneuro-rgb/MRLatte/releases/download/modules-v1/atlas-hcp1065.zip")
    monkeypatch.setenv("MRLATTE_MODULE_RELEASE_BASE", "http://mirror.example/x")
    assert mods._download_url_for(entry, None) == "http://mirror.example/x/modules-v1/atlas-hcp1065.zip"


def test_removing_a_shipped_atlas_in_the_atlas_manager_sticks(env):
    mods.seed_bundled_modules()
    client = TestClient(app)
    r = client.delete("/api/atlases/aal")
    assert r.status_code == 200 and r.json()["module"] == "atlas-aal", r.text
    assert "atlas-aal" not in mods._load_ledger()
    mods.seed_bundled_modules()                       # the next start
    assert not (env.atlases / "aal" / "aal.nii.gz").exists()
    assert "aal" not in [a["id"] for a in client.get("/api/atlases").json()["atlases"]]
