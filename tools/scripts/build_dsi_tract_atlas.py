#!/usr/bin/env python3
"""Turn a DSI Studio population tractography atlas into the 3D integer-labeled
atlas + labels JSON that MRLatte's atlas infrastructure consumes (same shape as
AAL / Harvard-Oxford / Destrieux / Juelich — frontend/src/lib/atlasConfig.js
STANDARD_ATLASES), plus a 4D per-tract binary stack for the dissection backend.

Two input flavors are supported (pick exactly one):

  --src-4d <file.nii.gz>   A single 4D NIfTI, one binary frame per tract, with a
                           companion --src-names "<index>\\t<Name>" txt.
                           (DSI Studio HCP842 ships this way.)

  --src-dir <dir>          A directory (searched recursively) of per-tract
                           NIfTIs, one file per tract. Tract names come from the
                           filenames, optionally enriched via --names-xlsx
                           (abbreviation -> full name, e.g. HCP1065's
                           abbreviation.xlsx). Probability maps are binarized at
                           --threshold. (DSI Studio HCP1065 ships this way, as
                           0.5mm per-tract volumes in category subfolders.)

Collapse rule: smallest-tract-wins
----------------------------------
The per-tract masks overlap heavily, so a single label-per-voxel parcellation
must pick a winner. We paint tracts from LARGEST to SMALLEST volume, so a smaller
tract overwrites a larger one wherever they overlap — keeping thin, clinically
critical tracts (CST, cranial nerves, fornix, optic radiation) visible instead of
being buried under broad structures (corpus callosum, U-fibers). The written
label value is the tract's fixed sorted index + 1, aligned with the labels JSON.

Registration / grid
--------------------
Sources carry an MNI affine. With --resample-to <ref.nii.gz> (e.g. the app's
mni152.nii.gz base) every tract mask is resampled (nearest-neighbour) onto that
grid up front, so BOTH the 3D label volume and the 4D stack come out on the base
grid — cheap for NiiVue display and for the backend overlap. Without it, the
native source grid is used. Resampling changes only the sampling grid, not the
MNI world alignment.

Usage
-----
    # HCP1065 (per-tract dir), onto the app base grid:
    python tools/scripts/build_dsi_tract_atlas.py --prefix HCP1065 \\
        --src-dir HCP1065/tracts --names-xlsx HCP1065/abbreviation.xlsx \\
        --resample-to data/modules/atlases/mni152/mni152.nii.gz

    # HCP842 (4D file), reproduce the existing build:
    python tools/scripts/build_dsi_tract_atlas.py --prefix HCP842 \\
        --src-4d HCP824/HCP842_tractography.nii.gz \\
        --src-names HCP824/HCP842_tractography.txt \\
        --resample-to data/modules/atlases/mni152/mni152.nii.gz

Output (into --out-dir, which defaults to the per-family folder under ATLAS_DIR
shared by frontend + backend, e.g. data/modules/atlases/hcp1065)
------
    <prefix>_tracts.nii.gz         int16 label volume, 1..N (0 = background)
    <prefix>_tracts_labels.json    [{"index": int, "name": str}, ...]
    <prefix>_tractography.nii.gz   4D uint8 per-tract binary stack (frame t ->
                                   label t+1) for the tracts4d dissection backend
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

import numpy as np
import nibabel as nib


def prettify(name: str) -> str:
    """`Cortico_Spinal_Tract_L` -> `Cortico Spinal Tract (L)`."""
    name = name.strip()
    for suffix, side in (("_L", " (L)"), ("_R", " (R)")):
        if name.endswith(suffix):
            name = name[: -len(suffix)] + side
            break
    return name.replace("_", " ")


def display_name(stem: str, full: str | None) -> str:
    """Prettified full name, with the L/R side forced to match the stem (the
    HCP1065 abbreviation sheet has a couple of copy-paste side typos)."""
    name = prettify(full if full else stem)
    for suffix, side, other in (("_L", " (L)", " (R)"), ("_R", " (R)", " (L)")):
        if stem.endswith(suffix):
            if name.endswith(other):
                name = name[: -len(other)]
            if not name.endswith(side):
                name = name.rstrip() + side
            break
    return name


def read_names_txt(names_path: str) -> dict[int, str]:
    """Parse `<index>\\t<name>` lines into {frame_index: raw_name}."""
    names: dict[int, str] = {}
    with open(names_path) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            idx_str, _, raw = line.partition("\t")
            if not raw:  # tolerate whitespace-separated files
                idx_str, _, raw = line.partition(" ")
            names[int(idx_str)] = raw.strip()
    return names


def read_xlsx_abbrev_map(xlsx_path: str) -> dict[str, str]:
    """Map abbreviation (col B, = filename stem) -> full name (col C) from an
    .xlsx, using only the standard library (no openpyxl dependency)."""
    NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    z = zipfile.ZipFile(xlsx_path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall(f"{NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))

    def cell_value(c) -> str:
        v = c.find(f"{NS}v")
        if v is None or v.text is None:
            return ""
        return shared[int(v.text)] if c.get("t") == "s" else v.text

    def col_letter(ref: str) -> str:
        return "".join(ch for ch in ref if ch.isalpha())

    mapping: dict[str, str] = {}
    for sheet in sorted(n for n in z.namelist()
                        if re.match(r"xl/worksheets/sheet\d+\.xml$", n)):
        root = ET.fromstring(z.read(sheet))
        for row in root.findall(f".//{NS}row"):
            cells = {col_letter(c.get("r", "")): cell_value(c)
                     for c in row.findall(f"{NS}c")}
            abbr, full = cells.get("B", "").strip(), cells.get("C", "").strip()
            if abbr and full:
                mapping[abbr] = full
    return mapping


def _binarize(data: np.ndarray, threshold: float) -> np.ndarray:
    """Binary mask from a probability/label map. threshold is a fraction of the
    map's max, so it works for 0/1, 0..1 probability, and 0..100 percent maps."""
    mx = float(data.max())
    thr = threshold * mx if mx > 1.0 else threshold
    return data > thr


def build(prefix: str, src_4d: str | None, src_dir: str | None,
          src_names: str | None, names_xlsx: str | None,
          out_dir: str, resample_to: str | None, threshold: float) -> None:
    if bool(src_4d) == bool(src_dir):
        sys.exit("Provide exactly one of --src-4d or --src-dir")

    ref = nib.load(resample_to) if resample_to else None
    if ref is not None:
        from nilearn.image import resample_to_img
        target_affine = ref.affine
        target_shape = ref.shape[:3]

    # Build a uniform list of (display_name, mask_getter). Each getter returns a
    # boolean mask on the TARGET grid (resampled up front if --resample-to).
    tracts: list[tuple[str, "callable"]] = []

    if src_4d:
        img = nib.load(src_4d)
        if img.ndim != 4:
            sys.exit(f"{src_4d}: expected a 4D file, got shape {img.shape}")
        T = img.shape[3]
        names = read_names_txt(src_names) if src_names else {}
        if ref is None:
            target_affine, target_shape = img.affine, img.shape[:3]
        dataobj = img.dataobj

        def make_frame_getter(t):
            def g():
                frame = nib.Nifti1Image(np.asanyarray(dataobj[..., t]).astype(np.uint8), img.affine)
                if ref is not None:
                    frame = resample_to_img(frame, ref, interpolation="nearest",
                                            copy_header=False, force_resample=False)
                return np.asanyarray(frame.dataobj) > 0
            return g

        for t in range(T):
            tracts.append((prettify(names.get(t, f"Tract {t + 1}")), make_frame_getter(t)))
    else:
        files = sorted(glob.glob(os.path.join(src_dir, "**", "*.nii.gz"), recursive=True))
        if not files:
            sys.exit(f"No *.nii.gz found under {src_dir}")
        abbrev = read_xlsx_abbrev_map(names_xlsx) if names_xlsx else {}
        if ref is None:
            first = nib.load(files[0])
            target_affine, target_shape = first.affine, first.shape[:3]

        def make_file_getter(path):
            def g():
                im = nib.load(path)
                if ref is not None:
                    im = resample_to_img(im, ref, interpolation="nearest",
                                         copy_header=False, force_resample=False)
                return _binarize(np.asanyarray(im.dataobj).astype(np.float32), threshold)
            return g

        for path in files:
            stem = os.path.basename(path)[: -len(".nii.gz")]
            tracts.append((display_name(stem, abbrev.get(stem)), make_file_getter(path)))

    T = len(tracts)
    XYZ = tuple(int(v) for v in target_shape)

    # Pass 1: fill the 4D binary stack and record each tract's volume.
    stack = np.zeros(XYZ + (T,), dtype=np.uint8)
    volumes = np.zeros(T, dtype=np.int64)
    for t, (_, getter) in enumerate(tracts):
        mask = getter()
        stack[..., t] = mask
        volumes[t] = int(mask.sum())

    # Pass 2: smallest-tract-wins collapse (paint largest first).
    label_vol = np.zeros(XYZ, dtype=np.int16)
    for t in np.argsort(-volumes):
        label_vol[stack[..., t] > 0] = int(t) + 1

    os.makedirs(out_dir, exist_ok=True)

    nii_path = os.path.join(out_dir, f"{prefix}_tracts.nii.gz")
    lab_path = os.path.join(out_dir, f"{prefix}_tracts_labels.json")
    stack_path = os.path.join(out_dir, f"{prefix}_tractography.nii.gz")

    out3d = nib.Nifti1Image(label_vol, target_affine)
    out3d.header.set_data_dtype(np.int16)
    nib.save(out3d, nii_path)

    out4d = nib.Nifti1Image(stack, target_affine)
    out4d.header.set_data_dtype(np.uint8)
    nib.save(out4d, stack_path)

    labels = [{"index": 0, "name": "Background"}]
    for t, (name, _) in enumerate(tracts):
        labels.append({"index": t + 1, "name": name})
    with open(lab_path, "w", encoding="utf-8") as f:
        json.dump(labels, f, indent=2, ensure_ascii=False)

    grid_note = (f"resampled onto {os.path.basename(resample_to)}"
                 if resample_to else "native source grid")
    print(f"Wrote {nii_path}  shape={XYZ}  dtype=int16  ({grid_note})")
    print(f"Wrote {stack_path}  shape={XYZ + (T,)}  dtype=uint8  (4D per-tract stack)")
    print(f"Wrote {lab_path}  ({len(labels)} labels incl. background)")
    print()
    print(f"{'tract':46s} {'raw':>8s} {'kept':>8s}")
    empty = []
    for t, (name, _) in enumerate(tracts):
        kept = int((label_vol == t + 1).sum())
        print(f"{name:46s} {int(volumes[t]):8d} {kept:8d}")
        if kept == 0:
            empty.append(name)
    if empty:
        print()
        print(f"WARNING: {len(empty)} tract(s) with 0 kept voxels "
              f"(overwritten or lost at this threshold/grid): {empty}")
    else:
        print(f"\nAll {T} tracts survived the collapse.")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prefix", default="HCP842",
                    help="Output basename prefix (<prefix>_tracts.nii.gz, etc.)")
    ap.add_argument("--src-4d", default=None,
                    help="Single 4D NIfTI, one binary frame per tract (with --src-names)")
    ap.add_argument("--src-dir", default=None,
                    help="Directory (searched recursively) of per-tract NIfTIs")
    ap.add_argument("--src-names", default=None,
                    help="'<index>\\t<name>' txt for --src-4d mode")
    ap.add_argument("--names-xlsx", default=None,
                    help="Optional abbreviation->full-name .xlsx for --src-dir mode")
    ap.add_argument("--threshold", type=float, default=0.25,
                    help="Binarization threshold as a fraction of each map's max "
                         "(auto-scaled for 0..100 maps); --src-dir mode. Default 0.25")
    ap.add_argument("--out-dir", default=None,
                    help="Output directory. Defaults to the shipped atlas family "
                         "folder for this prefix, data/modules/atlases/<prefix "
                         "lowercased> (e.g. .../hcp1065).")
    ap.add_argument("--resample-to", default=None,
                    help="Reference NIfTI (e.g. the app's mni152/mni152.nii.gz) to "
                         "resample every tract mask onto, nearest-neighbour.")
    args = ap.parse_args()
    out_dir = args.out_dir or os.path.join(
        "data", "modules", "atlases", args.prefix.lower())
    build(args.prefix, args.src_4d, args.src_dir, args.src_names, args.names_xlsx,
          out_dir, args.resample_to, args.threshold)


if __name__ == "__main__":
    main()
