#!/usr/bin/env python
"""One-shot migration of the shipped atlases to the canonical layout.

Before:  atlases/harvard_oxford/harvard_oxford_cort.nii.gz
                              /harvard_oxford_cort_labels.json   ([{index,name}])
         atlases/visfatlas/visfAtlas_maxprob.nii.gz
                          /visfAtlas_labels.json                 ({"1": "name"})
                          /visfAtlas_colormap.json               (parallel R/G/B arrays)

After:   atlases/harvard_oxford_cort/atlas.json
                                    /harvard_oxford_cort.nii.gz
                                    /harvard_oxford_cort.labels.json
         atlases/visfatlas/atlas.json
                          /visfatlas.nii.gz
                          /visfatlas.labels.json   (colours folded in)

Run once; the output is committed. Idempotent -- an atlas that already has an
atlas.json is skipped, and a source folder that is absent (a partially
installed module root) is skipped with a note rather than failing the run.

    python tools/scripts/migrate_atlases.py [--dry-run] [--module-root DIR]

Also regenerates the `files`/`bytes`/`sha256` blocks of the `atlases-core` and
`tract-atlases-hcp` entries in manifest.json, because every path in them
changes. `node tools/scripts/modules.mjs verify` is the check that it was right.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))

import atlas_labels  # noqa: E402
import atlas_ops  # noqa: E402
import atlas_validate  # noqa: E402

# --------------------------------------------------------------------------- #
# What the shipped atlases become.
#
# `aliases` carries the id each atlas was known by in atlasConfig.STANDARD_ATLASES
# so saved workspaces and layerLabelAtlas maps keep resolving. `tracts4d` names
# the 4-D per-bundle stack deps._ATLAS_PRESETS uses for dissection, which lives
# alongside the 3-D max-probability volume rather than replacing it.
# --------------------------------------------------------------------------- #
ATLASES = [
    {
        "id": "aal", "src": "aal", "volume": "aal_atlas.nii.gz",
        "labels": "aal_labels.json", "module": "atlases-core",
        "name": "AAL · Whole Brain", "short": "AAL", "kind": "parcellation",
        "opacity": 0.55,
        "description": "Automated Anatomical Labeling · cortical and subcortical regions",
        "license": {"spdx": "LicenseRef-FSL-Atlases",
                    "attribution": "Tzourio-Mazoyer et al. 2002"},
    },
    {
        "id": "harvard_oxford_cort", "src": "harvard_oxford",
        "volume": "harvard_oxford_cort.nii.gz",
        "labels": "harvard_oxford_cort_labels.json", "module": "atlases-core",
        "aliases": ["ho_cort", "harvard_oxford"],
        "name": "Harvard-Oxford · Cortical", "short": "HO Cort",
        "kind": "parcellation", "opacity": 0.55,
        "description": "48 cortical regions · max-prob threshold 25%",
        "license": {"spdx": "LicenseRef-FSL-Atlases",
                    "attribution": "Harvard CMA / FSL"},
    },
    {
        "id": "harvard_oxford_sub", "src": "harvard_oxford",
        "volume": "harvard_oxford_sub.nii.gz",
        "labels": "harvard_oxford_sub_labels.json", "module": "atlases-core",
        "aliases": ["ho_sub"],
        "name": "Harvard-Oxford · Subcortical", "short": "HO Sub",
        "kind": "parcellation", "opacity": 0.55,
        "description": "21 subcortical structures · max-prob threshold 25%",
        "license": {"spdx": "LicenseRef-FSL-Atlases",
                    "attribution": "Harvard CMA / FSL"},
    },
    {
        "id": "destrieux", "src": "destrieux", "volume": "destrieux.nii.gz",
        "labels": "destrieux_labels.json", "module": "atlases-core",
        "name": "Destrieux · FreeSurfer aparc.a2009s", "short": "Destrieux",
        "kind": "parcellation", "opacity": 0.55,
        "description": "Sulco-gyral cortical regions from the FreeSurfer 2009 parcellation",
        "license": {"spdx": "LicenseRef-FSL-Atlases",
                    "attribution": "Destrieux et al. 2010"},
    },
    {
        "id": "juelich", "src": "juelich", "volume": "juelich_atlas.nii.gz",
        "labels": "juelich_labels.json", "module": "atlases-core",
        "name": "Jülich · Cortex + White Matter", "short": "Jülich",
        "kind": "parcellation", "opacity": 0.55,
        "description": "Cyto/myelo-architectonic regions including white-matter tracts",
        "license": {"spdx": "LicenseRef-FSL-Atlases",
                    "attribution": "Eickhoff et al. 2005"},
    },
    {
        "id": "yeo7", "src": "yeo2011", "volume": "yeo2011_7networks.nii.gz",
        "labels": "yeo2011_7networks_labels.json", "module": "atlases-core",
        "aliases": ["yeo2011", "yeo"],
        "name": "Yeo-7 · Functional Networks", "short": "Yeo-7",
        "kind": "networks", "opacity": 0.55,
        "description": "Seven cortical resting-state networks (liberal mask)",
        "license": {"spdx": "CC-BY-4.0",
                    "attribution": "Yeo, Krienen et al. 2011"},
    },
    {
        "id": "visfatlas", "src": "visfatlas", "volume": "visfAtlas_maxprob.nii.gz",
        "labels": "visfAtlas_labels.json", "colormap_json": "visfAtlas_colormap.json",
        "module": "atlases-core", "aliases": ["visfAtlas"],
        "name": "visfAtlas · Maastricht Functional", "short": "visfAtlas",
        "kind": "parcellation", "opacity": 0.85,
        "description": "33 ROIs across higher visual cortex (FFA / PPA / EBA / hMT / V1-V3 d·v)",
        "license": {"spdx": "CC-BY-4.0", "attribution": "Rosenke et al. 2020"},
    },
    {
        "id": "jhu_wm", "src": "jhu", "volume": "jhu_wm_atlas.nii.gz",
        "labels": "jhu_wm_labels.json", "module": "tract-atlases-hcp",
        "aliases": ["jhu"],
        "name": "JHU · White-Matter Labels", "short": "JHU WM",
        "kind": "tracts", "opacity": 0.7,
        "description": "ICBM-DTI-81 white-matter parcellation",
        "license": {"spdx": "CC-BY-4.0", "attribution": "Mori et al."},
    },
    {
        "id": "hcp1065_tracts", "src": "hcp1065", "volume": "HCP1065_tracts.nii.gz",
        "labels": "HCP1065_tracts_labels.json",
        "tracts4d": "HCP1065_tractography.nii.gz",
        "module": "tract-atlases-hcp", "aliases": ["hcp1065"],
        "name": "HCP1065 · Named White-Matter Tracts", "short": "HCP1065",
        "kind": "tracts", "opacity": 0.7,
        "description": "DSI Studio HCP1065 population tractography atlas · 87 named bundles",
        "license": {"spdx": "CC-BY-4.0", "attribution": "Yeh et al. 2022 (DSI Studio)"},
    },
    {
        "id": "hcp842_tracts", "src": "hcp842", "volume": "HCP842_tracts.nii.gz",
        "labels": "HCP842_tracts_labels.json",
        "tracts4d": "HCP842_tractography.nii.gz",
        "module": "tract-atlases-hcp", "aliases": ["hcp842"],
        "name": "HCP842 · Named White-Matter Tracts", "short": "HCP842",
        "kind": "tracts", "opacity": 0.7,
        "description": "DSI Studio HCP842 population tractography atlas · 80 named bundles",
        "license": {"spdx": "CC-BY-4.0", "attribution": "Yeh et al. (DSI Studio)"},
    },
    {
        "id": "iit_tracts", "src": "iit", "volume": "IIT_named_tracts.nii.gz",
        "labels": "IIT_named_tracts_labels.json", "module": "tract-atlases-hcp",
        "aliases": ["iit"],
        "name": "IIT · Named White-Matter Tracts", "short": "IIT",
        "kind": "tracts", "opacity": 0.7,
        "description": "IIT Human Brain Atlas named bundles",
        "license": {"spdx": "CC-BY-4.0", "attribution": "Varentsova / Zhang"},
    },
]

MODULE_NAMES = {
    "atlases-core": (
        "Core atlases (AAL, Harvard-Oxford, Destrieux, Jülich, Yeo-7, visfAtlas)",
        "Cortical, subcortical and functional parcellations used for region "
        "labelling, the tract-dissection breakdown and lesion network mapping. "
        "Each atlas is a self-describing folder and can be removed on its own "
        "from the Atlas Manager."),
    "tract-atlases-hcp": (
        "Tract atlases (HCP1065, HCP842, IIT, JHU)",
        "Named white-matter bundle atlases used for the tract-dissection region "
        "breakdown."),
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_colormap_json(path: Path):
    """visfAtlas ships parallel R/G/B arrays indexed by label. Fold to per-region."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    r, g, b = raw.get("R") or [], raw.get("G") or [], raw.get("B") or []
    n = min(len(r), len(g), len(b))
    return {i: [int(r[i]), int(g[i]), int(b[i])] for i in range(1, n)}


def migrate_one(spec, atlas_root: Path, dry_run: bool):
    dest = atlas_root / spec["id"]
    if (dest / "atlas.json").exists():
        return "skipped (already canonical)", None

    src_dir = atlas_root / spec["src"]
    src_vol = src_dir / spec["volume"]
    src_lab = src_dir / spec["labels"]
    if not src_vol.exists():
        return "skipped (volume not present)", None
    if not src_lab.exists():
        return "skipped (labels not present)", None

    regions = atlas_labels.read_labels(src_lab)

    colours = {}
    if spec.get("colormap_json"):
        colours = load_colormap_json(src_dir / spec["colormap_json"])
    for reg in regions:
        if reg["value"] in colours:
            reg["color"] = colours[reg["value"]]

    ok, reason, details = atlas_validate.inspect_volume(src_vol)
    if not ok:
        return "FAILED validation: %s" % reason, None

    # Seed centroids so the client can navigate to a region without a
    # full-volume scan, and so a bilateral single-label region lands ON itself.
    stats = atlas_ops.region_stats(src_vol, regions)
    atlas_ops.apply_centroids(regions, stats)

    descriptor = {
        "schemaVersion": 1,
        "id": spec["id"],
        "aliases": spec.get("aliases", []),
        "name": spec["name"],
        "short": spec["short"],
        "description": spec["description"],
        "kind": spec["kind"],
        "space": "MNI152",
        "volume": "%s.nii.gz" % spec["id"],
        "labels": "%s.labels.json" % spec["id"],
        "colormap": "random",
        "opacity": spec["opacity"],
        "ignoreZeroVoxels": True,
        "lateralized": details.get("lateralized"),
        "origin": {"kind": "builtin"},
        "license": spec["license"],
    }
    if spec.get("tracts4d"):
        descriptor["tracts4d"] = "%s.tracts4d.nii.gz" % spec["id"]

    if dry_run:
        return "would migrate (%d regions, lateralized=%s)" % (
            len(regions), details.get("lateralized")), None

    dest.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src_vol), str(dest / descriptor["volume"]))
    atlas_labels.write_labels(dest / descriptor["labels"], regions)
    src_lab.unlink()
    if spec.get("tracts4d"):
        src4d = src_dir / spec["tracts4d"]
        if src4d.exists():
            shutil.move(str(src4d), str(dest / descriptor["tracts4d"]))
    if spec.get("colormap_json"):
        extra = src_dir / spec["colormap_json"]
        if extra.exists():
            extra.unlink()          # colours now live on the regions themselves
    (dest / "atlas.json").write_text(
        json.dumps(descriptor, indent=1, ensure_ascii=False), encoding="utf-8")

    # Drop the old family folder if the migration emptied it. Anything left
    # behind belongs to something else and stays.
    if src_dir.exists() and src_dir != dest and not any(src_dir.iterdir()):
        src_dir.rmdir()

    return "migrated (%d regions, lateralized=%s)" % (
        len(regions), details.get("lateralized")), descriptor


def regen_manifest(manifest_path: Path, atlas_root: Path, dry_run: bool):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    by_module = {}
    for spec in ATLASES:
        folder = atlas_root / spec["id"]
        if not (folder / "atlas.json").exists():
            continue
        for name in sorted(p.name for p in folder.iterdir() if p.is_file()):
            path = folder / name
            record = {
                "path": "%s/%s" % (spec["id"], name),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
            # atlas.json and *.labels.json are rewritten by the app whenever the
            # user renames an atlas, recolours a region or edits a region name.
            # Their shipped bytes are still hash-checked at INSTALL time; `verify`
            # skips the hash afterwards, because a mismatch there is an edit, not
            # corruption. Without this a single rename reports atlases-core CORRUPT.
            if name == "atlas.json" or name.endswith(".labels.json"):
                record["mutable"] = True
            by_module.setdefault(spec["module"], []).append(record)

    changed = []
    for entry in manifest.get("modules", []):
        files = by_module.get(entry.get("id"))
        if not files:
            continue
        entry["files"] = files
        entry["bytes"] = sum(f["bytes"] for f in files)
        name, desc = MODULE_NAMES.get(entry["id"], (None, None))
        if name:
            entry["name"] = name
            entry["description"] = desc
        changed.append("%s: %d files, %d bytes" % (entry["id"], len(files), entry["bytes"]))

    if not dry_run and changed:
        manifest_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return changed


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--module-root", default=str(REPO_ROOT / "data" / "modules"))
    args = ap.parse_args()

    module_root = Path(args.module_root).resolve()
    atlas_root = module_root / "atlases"
    if not atlas_root.is_dir():
        print("no atlas directory at %s" % atlas_root)
        return 1

    print("atlas root: %s%s" % (atlas_root, "  (dry run)" if args.dry_run else ""))
    for spec in ATLASES:
        status, _ = migrate_one(spec, atlas_root, args.dry_run)
        print("  %-22s %s" % (spec["id"], status))

    manifest_path = module_root / "manifest.json"
    if manifest_path.exists():
        print("manifest:")
        for line in regen_manifest(manifest_path, atlas_root, args.dry_run):
            print("  %s" % line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
