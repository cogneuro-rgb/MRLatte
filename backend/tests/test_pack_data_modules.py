"""Every release zip tools/scripts/pack_data_modules.py builds installs through
the app's own install path, and the installed module is complete and verified.
This is what the owner uploads to the modules-v1 release."""
import json
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

import deps
import routers.modules as mods
from server import app

REPO = Path(__file__).resolve().parents[2]
MANIFEST = REPO / "data" / "modules" / "manifest.json"


def test_every_packed_module_installs_and_verifies(tmp_path, monkeypatch):
    out = tmp_path / "assets"
    subprocess.run([sys.executable, str(REPO / "tools" / "scripts" / "pack_data_modules.py"),
                    "--out", str(out)], check=True, capture_output=True)
    root = tmp_path / "module-root"
    root.mkdir()
    monkeypatch.setattr(deps, "MODULE_ROOT", root)
    monkeypatch.setenv("MRLATTE_MODULE_MANIFEST", str(MANIFEST))
    monkeypatch.setenv("MRLATTE_MODULE_JOBS_DIR", str(tmp_path / "jobs"))
    for var in ("ATLAS_DIR", "MRLATTE_BUNDLED_MODULES"):
        monkeypatch.delenv(var, raising=False)
    mods._manifest_cache["mtime"] = None
    client = TestClient(app)

    data_ids = [e["id"] for e in json.loads(MANIFEST.read_text(encoding="utf-8"))["modules"]
                if (e.get("type") or "data") == "data"]
    assert sorted(p.stem for p in out.glob("*.zip")) == sorted(data_ids)
    for mid in data_ids:
        with open(out / f"{mid}.zip", "rb") as fh:
            r = client.post(f"/api/modules/{mid}/sideload", files={"file": (f"{mid}.zip", fh)})
        assert r.status_code == 200, (mid, r.text)
        assert client.post(f"/api/modules/{mid}/verify").json()["ok"] is True, mid
    states = {m["id"]: m for m in client.get("/api/modules").json()["modules"]}
    assert all(states[mid]["installed"] and states[mid]["uninstallable"] for mid in data_ids)
