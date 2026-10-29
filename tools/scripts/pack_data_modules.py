"""Build the release assets for the data modules: one <id>.zip per data module.

    python tools/scripts/pack_data_modules.py [--out DIR]

Each zip holds the module's declared files at their manifest paths (relative to
its `installTo`), taken from data/modules and checked against the manifest's
pinned size and sha256 first — a file that does not match its pin stops the
run, because the app refuses it at install time. The zips are reproducible
(fixed timestamps, sorted members), so re-running gives identical bytes.

They go to <MRLATTE_BUILD_DIR>\\module-assets (default ..\\MRLatte-build), to
be uploaded to the GitHub release the manifest's sources name (tag modules-v1),
where the app downloads them from `<releaseBase>/<tag>/<asset>`.
"""
import argparse
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MODULES = REPO / "data" / "modules"


def main():
    default_out = Path(os.environ.get("MRLATTE_BUILD_DIR") or REPO.parent / "MRLatte-build") / "module-assets"
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(default_out))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    manifest = json.loads((MODULES / "manifest.json").read_text(encoding="utf-8"))
    tags, rows = set(), []
    for entry in manifest["modules"]:
        if (entry.get("type") or "data") != "data" or not entry.get("files"):
            continue
        rel = next((s for s in entry.get("sources") or [] if s.get("type") == "github-release"), None)
        if rel is None:
            continue
        base = MODULES / (entry.get("installTo") or "")
        for f in entry["files"]:
            data = (base / f["path"]).read_bytes()
            if len(data) != f["bytes"] or hashlib.sha256(data).hexdigest() != f["sha256"]:
                sys.exit(f"{entry['id']}: {f['path']} does not match its pin in manifest.json")
        target = out / rel["asset"]
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(entry["files"], key=lambda f: f["path"]):
                info = zipfile.ZipInfo(f["path"], date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                zf.writestr(info, (base / f["path"]).read_bytes())
        tags.add(rel.get("tag"))
        rows.append((rel["asset"], target.stat().st_size, len(entry["files"])))

    width = max(len(a) for a, _, _ in rows)
    for asset, size, n in rows:
        print(f"  {asset:{width}}  {size / 1e6:7.2f} MB  {n} files")
    print(f"\n{len(rows)} assets, {sum(s for _, s, _ in rows) / 1e6:.1f} MB, in {out}")
    print(f"Upload them all to the GitHub release tagged {', '.join(sorted(t for t in tags if t))} at")
    print(f"{manifest.get('releaseBase', '').replace('/releases/download', '/releases')}")


if __name__ == "__main__":
    main()
