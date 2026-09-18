#!/usr/bin/env python
"""Generate data/modules/atlas-catalog.json — the 1-click atlas catalog.

Run rarely (to refresh the pinned upstream commits); the output is committed
and shipped, so the app never queries GitHub just to render the catalog list.

    python tools/scripts/build_atlas_catalog.py [--out PATH]

Two upstreams:

  neuroparc (neurodata/neuroparc) is the backbone. Every atlas there is already
  in MNI152NLin6 at a common resolution, with a matching label CSV and a
  metadata JSON carrying per-region centroids. One URL shape, one space, one
  label format — which is the whole reason to prefer it over pulling each atlas
  from its own home in its own format.

  CBIG (ThomasYeoLab/CBIG) supplies Schaefer. neuroparc carries the Schaefer
  volumes but no names for them, so they would install as "Region 1..400".

  Tian subcortex (yetianmed/subcortex) fills the one gap that matters
  clinically: neuroparc has no dedicated subcortical parcellation beyond
  Harvard-Oxford's 21 structures.

All three are pinned to a COMMIT SHA, never a branch, so the bytes cannot change
under an install. Sizes are recorded here and checked at download time; per the
chosen integrity model there are no pre-pinned sha256 digests, and the hash of
what actually arrived is recorded in atlases.state.json instead.

Skipped deliberately: neuroparc's DS*, Slab*, CPAC200, DKT, DesikanKlein and
Talairach entries. None of them has region NAMES anywhere upstream -- neither a
label CSV nor a populated metadata JSON -- so they would install as "Region
1..N", with nothing to navigate to, nothing to put in a report, and no way for
the user to tell which region is which.
"""
from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

NEUROPARC_REPO = "neurodata/neuroparc"
NEUROPARC_SHA = "5a5e7469671e65cb58087c47b69d0edb71dc2966"
NEUROPARC_RES = "2x2x2"

CBIG_REPO = "ThomasYeoLab/CBIG"
CBIG_SHA = "e8dce1db88c28ecf81cfb1633c3de0debe935ee9"
CBIG_BASE = "stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/MNI"

TIAN_REPO = "yetianmed/subcortex"
TIAN_SHA = "dcad93421ea8021d6c5738df0a915a2223cd82aa"

RAW = "https://raw.githubusercontent.com/%s/%s/%s"

# neuroparc files its label CSVs under a shorter stem than the volume for a few
# atlases. Missing these silently falls through to the metadata JSON, whose
# `label` strings are empty for some atlases -- i.e. 48 regions all called
# "Region N". Checked against the actual directory listing, not guessed.
CSV_STEM = {
    "AICHAJoliot2015": "AICHA",
    "HarvardOxfordcort-maxprob-thr25": "HarvardOxfordcort-maxprob",
    "HarvardOxfordsub-maxprob-thr25": "HarvardOxfordsub-maxprob",
    "Princetonvisual-top": "Princetonvisual",
}

# neuroparc name -> (atlas id, display name, short, kind, description)
NEUROPARC = [
    ("AAL", "aal_neuroparc", "AAL · Whole Brain", "AAL", "parcellation",
     "Automated Anatomical Labeling · 116 cortical and subcortical regions"),
    ("AICHAJoliot2015", "aicha", "AICHA · Functional Homotopic", "AICHA", "parcellation",
     "384 functionally homotopic regions (Joliot 2015)"),
    ("Brodmann", "brodmann", "Brodmann Areas", "Brodmann", "parcellation",
     "Classical cytoarchitectonic areas"),
    ("Desikan", "desikan", "Desikan-Killiany", "Desikan", "parcellation",
     "68 cortical regions from the FreeSurfer aparc parcellation"),
    ("Destrieux", "destrieux_neuroparc", "Destrieux · aparc.a2009s", "Destrieux", "parcellation",
     "148 sulco-gyral cortical regions"),
    ("Glasser", "glasser", "Glasser · HCP-MMP1", "Glasser", "parcellation",
     "360 multimodal cortical parcels (HCP-MMP1, Glasser 2016)"),
    ("Hammersmith", "hammersmith", "Hammersmith", "Hammersmith", "parcellation",
     "83 manually delineated anatomical regions"),
    ("HarvardOxfordcort-maxprob-thr25", "harvard_oxford_cort_neuroparc",
     "Harvard-Oxford · Cortical", "HO Cort", "parcellation",
     "48 cortical regions · max-prob threshold 25%"),
    ("HarvardOxfordsub-maxprob-thr25", "harvard_oxford_sub_neuroparc",
     "Harvard-Oxford · Subcortical", "HO Sub", "parcellation",
     "21 subcortical structures · max-prob threshold 25%"),
    ("JHU", "jhu_neuroparc", "JHU · White Matter", "JHU", "tracts",
     "ICBM-DTI-81 white-matter parcellation"),
    ("Juelich", "juelich_neuroparc", "Jülich · Cyto/Myeloarchitectonic", "Jülich", "parcellation",
     "Probabilistic cyto- and myelo-architectonic regions"),
    ("Princetonvisual-top", "princeton_visual", "Princeton Visual Areas", "Princeton", "parcellation",
     "Topographic visual areas"),
    ("Yeo-7", "yeo7_neuroparc", "Yeo-7 · Functional Networks", "Yeo-7", "networks",
     "Seven cortical resting-state networks (tight mask)"),
    ("Yeo-7-liberal", "yeo7_liberal", "Yeo-7 · Functional Networks (liberal)", "Yeo-7 lib", "networks",
     "Seven cortical resting-state networks (liberal mask)"),
    ("Yeo-17", "yeo17", "Yeo-17 · Functional Networks", "Yeo-17", "networks",
     "Seventeen cortical resting-state networks (tight mask)"),
    ("Yeo-17-liberal", "yeo17_liberal", "Yeo-17 · Functional Networks (liberal)", "Yeo-17 lib", "networks",
     "Seventeen cortical resting-state networks (liberal mask)"),
]

NEUROPARC_LICENSE = {
    "spdx": "NOASSERTION",
    "attribution": ("Redistributed by neuroparc (neurodata/neuroparc). Each atlas "
                    "remains under its original authors' terms — see the source "
                    "link before publishing derived figures."),
}

# Schaefer comes from CBIG, its canonical home, NOT from neuroparc. neuroparc
# carries the volumes but no label CSV, and its metadata JSON has empty `label`
# strings for them -- 400 regions all called "Region N", which is useless for
# navigation or a report. CBIG ships a FreeSurfer LUT with the real network-
# prefixed names AND per-parcel colours, so a Schaefer atlas installs with a
# meaningful colour scheme instead of the `random` colormap.
SCHAEFER = [(200, "schaefer200"), (300, "schaefer300"),
            (400, "schaefer400"), (1000, "schaefer1000")]

SCHAEFER_LICENSE = {
    "spdx": "MIT",
    "attribution": "Schaefer, Kong, Gordon, Laumann, Zuo, Holmes, Eickhoff & Yeo 2018, Cerebral Cortex",
}

TIAN = [
    ("S1", "tian_s1", "Tian Subcortex · Scale I", "Tian S1", 16),
    ("S2", "tian_s2", "Tian Subcortex · Scale II", "Tian S2", 32),
    ("S3", "tian_s3", "Tian Subcortex · Scale III", "Tian S3", 50),
    ("S4", "tian_s4", "Tian Subcortex · Scale IV", "Tian S4", 54),
]

TIAN_LICENSE = {
    "spdx": "CC-BY-4.0",
    "attribution": "Tian, Margulies, Breakspear & Zalesky 2020, Nature Neuroscience",
}


def github_tree(repo: str, sha: str) -> dict:
    """{path: size} for every blob in a commit. One request, not one per file."""
    url = "https://api.github.com/repos/%s/git/trees/%s?recursive=1" % (repo, sha)
    req = urllib.request.Request(url, headers={"User-Agent": "mrlatte-catalog"})
    with urllib.request.urlopen(req, timeout=60) as fh:
        data = json.load(fh)
    if data.get("truncated"):
        raise SystemExit("GitHub truncated the tree for %s; cannot size files" % repo)
    return {e["path"]: e.get("size", 0) for e in data.get("tree", [])
            if e.get("type") == "blob"}


def build_neuroparc(sizes):
    base = "atlases/label/Human"
    out = []
    for name, atlas_id, display, short, kind, description in NEUROPARC:
        vol = "%s/%s_space-MNI152NLin6_res-%s.nii.gz" % (base, name, NEUROPARC_RES)
        lab = "%s/Anatomical-labels-csv/%s.csv" % (base, CSV_STEM.get(name, name))
        meta = "%s/Metadata-json/%s_space-MNI152NLin6_res-%s.json" % (base, name, NEUROPARC_RES)
        if vol not in sizes:
            print("  ! skipping %s — no volume at the pinned commit" % name)
            continue
        entry = {
            "catalogId": atlas_id,
            "atlasId": atlas_id,
            "name": display,
            "short": short,
            "kind": kind,
            "description": description,
            "space": "MNI152NLin6",
            "source": "neuroparc",
            "sourceUrl": "https://github.com/%s" % NEUROPARC_REPO,
            "license": NEUROPARC_LICENSE,
            "volume": {"url": RAW % (NEUROPARC_REPO, NEUROPARC_SHA, vol),
                       "bytes": sizes[vol]},
        }
        if lab in sizes:
            entry["labels"] = {"url": RAW % (NEUROPARC_REPO, NEUROPARC_SHA, lab),
                               "bytes": sizes[lab], "format": "csv"}
        if meta in sizes:
            # Region centroids, so the client can jump to a region without a
            # full-volume scan the first time it is asked to.
            entry["metadata"] = {"url": RAW % (NEUROPARC_REPO, NEUROPARC_SHA, meta),
                                 "bytes": sizes[meta], "format": "neuroparc-json"}
        entry["bytes"] = sum(part["bytes"] for part in
                             (entry["volume"], entry.get("labels"), entry.get("metadata"))
                             if part)
        out.append(entry)
    return out


def build_schaefer(sizes):
    out = []
    for n, atlas_id in SCHAEFER:
        vol = "%s/Schaefer2018_%dParcels_7Networks_order_FSLMNI152_2mm.nii.gz" % (CBIG_BASE, n)
        lut = "%s/freeview_lut/Schaefer2018_%dParcels_7Networks_order.txt" % (CBIG_BASE, n)
        if vol not in sizes or lut not in sizes:
            print("  ! skipping Schaefer %d — not at the pinned commit" % n)
            continue
        entry = {
            "catalogId": atlas_id,
            "atlasId": atlas_id,
            "name": "Schaefer %d · 7 Networks" % n,
            "short": "Schaefer %d" % n,
            "kind": "parcellation",
            "description": "%d cortical parcels grouped into the Yeo-7 networks" % n,
            "space": "MNI152NLin6",
            "source": "cbig",
            "sourceUrl": "https://github.com/%s/tree/master/%s" % (CBIG_REPO, CBIG_BASE),
            "license": SCHAEFER_LICENSE,
            "volume": {"url": RAW % (CBIG_REPO, CBIG_SHA, vol), "bytes": sizes[vol]},
            "labels": {"url": RAW % (CBIG_REPO, CBIG_SHA, lut),
                       "bytes": sizes[lut], "format": "lut"},
        }
        entry["bytes"] = entry["volume"]["bytes"] + entry["labels"]["bytes"]
        out.append(entry)
    return out


def build_tian(sizes):
    base = "Group-Parcellation/3T/Subcortex-Only"
    out = []
    for scale, atlas_id, display, short, n_regions in TIAN:
        vol = "%s/Tian_Subcortex_%s_3T_1mm.nii.gz" % (base, scale)
        lab = "%s/Tian_Subcortex_%s_3T_label.txt" % (base, scale)
        if vol not in sizes or lab not in sizes:
            print("  ! skipping Tian %s — not at the pinned commit" % scale)
            continue
        entry = {
            "catalogId": atlas_id,
            "atlasId": atlas_id,
            "name": display,
            "short": short,
            "kind": "parcellation",
            "description": "%d subcortical structures · Melbourne Subcortical Atlas" % n_regions,
            "space": "MNI152NLin6",
            "source": "subcortex",
            "sourceUrl": "https://github.com/%s" % TIAN_REPO,
            "license": TIAN_LICENSE,
            "volume": {"url": RAW % (TIAN_REPO, TIAN_SHA, vol), "bytes": sizes[vol]},
            "labels": {"url": RAW % (TIAN_REPO, TIAN_SHA, lab),
                       "bytes": sizes[lab], "format": "text"},
        }
        entry["bytes"] = entry["volume"]["bytes"] + entry["labels"]["bytes"]
        out.append(entry)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(REPO_ROOT / "data" / "modules" / "atlas-catalog.json"))
    args = ap.parse_args()

    print("neuroparc @ %s" % NEUROPARC_SHA[:12])
    entries = build_neuroparc(github_tree(NEUROPARC_REPO, NEUROPARC_SHA))
    print("  %d atlases" % len(entries))

    print("CBIG (Schaefer) @ %s" % CBIG_SHA[:12])
    schaefer = build_schaefer(github_tree(CBIG_REPO, CBIG_SHA))
    print("  %d atlases" % len(schaefer))
    entries.extend(schaefer)

    print("subcortex @ %s" % TIAN_SHA[:12])
    tian = build_tian(github_tree(TIAN_REPO, TIAN_SHA))
    print("  %d atlases" % len(tian))
    entries.extend(tian)

    payload = {
        "schemaVersion": 1,
        "generated": "built by tools/scripts/build_atlas_catalog.py",
        "notes": [
            "Every URL is pinned to a commit SHA, never a branch: the bytes an "
            "install downloads cannot change after this file was generated.",
            "`bytes` is checked against what actually arrives (with tolerance); "
            "there are no pre-pinned sha256 digests. The observed hash is "
            "recorded in atlases.state.json at install time so a later verify "
            "can still detect local corruption.",
            "`atlasId` is the folder the atlas installs into. Entries whose id "
            "ends in _neuroparc are a second copy of an atlas MRLatte already "
            "ships, in a different space/resolution — installing one does not "
            "replace the shipped atlas.",
        ],
        "atlases": entries,
    }
    out = Path(args.out)
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote %s (%d atlases, %.1f MB total)"
          % (out, len(entries), sum(e["bytes"] for e in entries) / 1e6))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
