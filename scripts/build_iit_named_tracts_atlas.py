#!/usr/bin/env python3
"""Collapse the IIT Human Brain Atlas v5.0 named white-matter fiber bundles
(IIT_bundles, FSL MNI152 1mm space, from NITRC) into a single integer-labeled
3D atlas that NeuroVue's existing atlas infrastructure can consume directly —
same shape as AAL / Harvard-Oxford / Destrieux / Juelich
(frontend/src/lib/atlasConfig.js STANDARD_ATLASES entries).

Why this exists
----------------
The bundle files are 42 separate per-tract streamline-density maps (integer
counts, not binary masks), each named for a clinically-recognized white-matter
tract (CST, SLF, AF, IFOF, ILF, UF, cingulum, corpus callosum + forceps, optic
radiation, cerebellar peduncles, brainstem tracts...). They overlap heavily
(e.g. CST_L intersects the corpus callosum in tens of thousands of voxels)
because each file is a probabilistic/density map of its own tract in isolation,
not a mutually-exclusive parcellation. This script reduces them to a single
max-density-wins integer parcellation, the standard way to turn a set of
probabilistic tract maps into a clean label volume for anatomical lookup.

Registration
------------
These bundle files carry the correct FSL MNI152 1mm affine
([[-1,0,0,90],[0,1,0,-126],[0,0,1,-72],[0,0,0,1]], shape 182x218x182), so the
atlas is written out with each bundle's own affine — no external template or
derived/guessed registration is needed. NiiVue (frontend overlay) and nilearn
`resample_to_img` (backend tract dissection) both align it by affine.

Tract set (index assignment and labels) is driven by the bundle *filenames*
actually present in --bundles-dir: each `<stem>.nii.gz` is discovered, sorted,
assigned a 1-based label index, and mapped to a curated display name via
TRACT_NAMES (falling back to the raw stem for any unrecognized file).

Usage
-----
    python scripts/build_iit_named_tracts_atlas.py \
        [--bundles-dir IIT_bundles/IIT_bundles] \
        [--out-dir     frontend/public/atlases]

Output
------
    IIT_named_tracts.nii.gz         int16 label volume, 1..N (0 = background)
    IIT_named_tracts_labels.json    [{"index": int, "name": str}, ...]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import nibabel as nib

# ===== filename stem -> clinical tract name =====
# Index assignment is deterministic (sorted by stem) so the NIfTI label values
# and the labels JSON always stay in sync.
TRACT_NAMES = {
    "AC":               "Anterior Commissure (AC)",
    "AF_L":             "Arcuate Fasciculus (AF, L)",
    "AF_R":             "Arcuate Fasciculus (AF, R)",
    "AST_L":            "Acoustic Radiation (AST, L)",
    "AST_R":            "Acoustic Radiation (AST, R)",
    "C_L":               "Cingulum (C, L)",
    "C_R":               "Cingulum (C, R)",
    "CC":               "Corpus Callosum (CC)",
    "CCMid":            "Corpus Callosum — Body (CCMid)",
    "CC_ForcepsMajor":  "Forceps Major (occipital)",
    "CC_ForcepsMinor":  "Forceps Minor (frontal)",
    "CST_L":            "Corticospinal Tract (CST, L)",
    "CST_R":            "Corticospinal Tract (CST, R)",
    "F_L_R":            "Fornix (F)",
    "FPT_L":            "Fronto-Pontine Tract (FPT, L)",
    "FPT_R":            "Fronto-Pontine Tract (FPT, R)",
    "ICP_L":            "Inferior Cerebellar Peduncle (ICP, L)",
    "ICP_R":            "Inferior Cerebellar Peduncle (ICP, R)",
    "IFOF_L":           "Inferior Fronto-Occipital Fasciculus (IFOF, L)",
    "IFOF_R":           "Inferior Fronto-Occipital Fasciculus (IFOF, R)",
    "ILF_L":            "Inferior Longitudinal Fasciculus (ILF, L)",
    "ILF_R":            "Inferior Longitudinal Fasciculus (ILF, R)",
    "MCP":              "Middle Cerebellar Peduncle (MCP)",
    "MdLF_L":           "Middle Longitudinal Fasciculus (MdLF, L)",
    "MdLF_R":           "Middle Longitudinal Fasciculus (MdLF, R)",
    "ML_L":             "Medial Lemniscus (ML, L)",
    "ML_R":             "Medial Lemniscus (ML, R)",
    "OPT_L":            "Occipito-Pontine Tract (OPT, L)",
    "OPT_R":            "Occipito-Pontine Tract (OPT, R)",
    "OR_L":             "Optic Radiation (OR, L)",
    "OR_R":             "Optic Radiation (OR, R)",
    "PPT_L":            "Parieto-Pontine Tract (PPT, L)",
    "PPT_R":            "Parieto-Pontine Tract (PPT, R)",
    "SCP":              "Superior Cerebellar Peduncle (SCP)",
    "SLF_L":            "Superior Longitudinal Fasciculus (SLF, L)",
    "SLF_R":            "Superior Longitudinal Fasciculus (SLF, R)",
    "STT_L":            "Spinothalamic Tract (STT, L)",
    "STT_R":            "Spinothalamic Tract (STT, R)",
    "UF_L":             "Uncinate Fasciculus (UF, L)",
    "UF_R":             "Uncinate Fasciculus (UF, R)",
    "VOF_L":            "Vertical Occipital Fasciculus (VOF, L)",
    "VOF_R":            "Vertical Occipital Fasciculus (VOF, R)",
}

# Whole corpus callosum fully contains CCMid / ForcepsMajor / ForcepsMinor.
# Give it lowest priority so those more specific labels are never overwritten
# by the generic "Corpus Callosum" label even where CC's own density is higher.
LOW_PRIORITY_STEMS = {"CC"}


def discover_stems(bundles_dir: str) -> list[str]:
    """Every `<stem>.nii.gz` in bundles_dir becomes a tract, sorted for a stable
    index assignment. macOS cruft (.DS_Store, __MACOSX) is skipped by extension."""
    stems = []
    for entry in os.listdir(bundles_dir):
        if entry.endswith(".nii.gz") and os.path.isfile(os.path.join(bundles_dir, entry)):
            stems.append(entry[:-len(".nii.gz")])
    if not stems:
        sys.exit(f"No <stem>.nii.gz bundle files found in {bundles_dir}")
    return sorted(stems)


def build(bundles_dir: str, out_dir: str) -> None:
    stems = discover_stems(bundles_dir)

    affine = None
    shape = None
    label_vol = None
    density_vol = None

    ordered_stems = [s for s in stems if s not in LOW_PRIORITY_STEMS] + \
                     [s for s in stems if s in LOW_PRIORITY_STEMS]

    stem_to_index = {stem: i + 1 for i, stem in enumerate(stems)}

    for stem in ordered_stems:
        path = os.path.join(bundles_dir, f"{stem}.nii.gz")
        img = nib.load(path)
        data = np.asanyarray(img.dataobj).astype(np.float64)

        if shape is None:
            shape = data.shape
            affine = img.affine  # bundles carry the correct FSL MNI152 1mm affine
            label_vol = np.zeros(shape, dtype=np.int16)
            density_vol = np.zeros(shape, dtype=np.float64)
        else:
            if data.shape != shape:
                sys.exit(f"{stem}: shape {data.shape} != expected {shape}")
            if not np.allclose(img.affine, affine):
                sys.exit(f"{stem}: affine differs from the first bundle — mixed spaces")

        idx = stem_to_index[stem]
        mask = data > 0

        if stem in LOW_PRIORITY_STEMS:
            # Only claim voxels no other (higher-priority) tract has claimed.
            claim = mask & (label_vol == 0)
        else:
            claim = mask & (data > density_vol)

        label_vol[claim] = idx
        density_vol[claim] = data[claim]

    os.makedirs(out_dir, exist_ok=True)

    out_img = nib.Nifti1Image(label_vol, affine)
    out_img.header.set_data_dtype(np.int16)
    nii_path = os.path.join(out_dir, "IIT_named_tracts.nii.gz")
    nib.save(out_img, nii_path)

    labels = [{"index": 0, "name": "Background"}]
    for stem in stems:
        labels.append({"index": stem_to_index[stem], "name": TRACT_NAMES.get(stem, stem)})
    labels_path = os.path.join(out_dir, "IIT_named_tracts_labels.json")
    with open(labels_path, "w") as f:
        json.dump(labels, f, indent=2)

    print(f"Wrote {nii_path}  shape={label_vol.shape}  dtype=int16")
    print(f"Wrote {labels_path}  ({len(labels)} labels incl. background)")
    print()
    print(f"{'tract':40s} {'voxels':>8s}")
    empty = []
    for stem in stems:
        idx = stem_to_index[stem]
        n = int((label_vol == idx).sum())
        print(f"{TRACT_NAMES.get(stem, stem):40s} {n:8d}")
        if n == 0:
            empty.append(stem)
    if empty:
        print()
        print(f"WARNING: {len(empty)} tract(s) ended up with zero voxels: {empty}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bundles-dir", default="IIT_bundles/IIT_bundles")
    ap.add_argument("--out-dir", default="frontend/public/atlases")
    args = ap.parse_args()
    build(args.bundles_dir, args.out_dir)


if __name__ == "__main__":
    main()
