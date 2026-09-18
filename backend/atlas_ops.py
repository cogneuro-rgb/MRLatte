"""Operations that rewrite an atlas volume and its label list together.

The invariant this file exists to hold: the integers in the NIfTI and the
values in the label JSON are ONE fact, and nothing may change one without the
other. Splitting Harvard-Oxford into left/right renumbers 48 labels into 96 --
done in two steps by hand, that is a silent mislabelling of the whole brain.
So every function here returns (volume, regions) and the caller writes both or
neither.
"""
from __future__ import annotations

from pathlib import Path

import atlas_labels
import atlas_validate

# Voxels sitting exactly on x = 0 have no side. They go to the right, which is
# arbitrary but must be stated: the alternative (dropping them) punches a
# one-voxel hole down the midline of every split atlas.
_MIDLINE_GOES_RIGHT = True


def _world_x(np, affine, idx):
    """World x for an (N,3) array of voxel indices.

    Only the x row of the affine matters. Voxel i is NOT left/right: the
    shipped atlases are LIA-native, so the sagittal axis is j or k depending on
    the file, and going through the affine is the only way that is correct for
    all of them.
    """
    return (idx * affine[0, :3]).sum(axis=1) + affine[0, 3]


def split_lr(volume_path, regions, suffix_left=" (L)", suffix_right=" (R)"):
    """Split every bilateral label into a left and a right label.

    Returns (nibabel image, regions) -- a NEW volume, densely renumbered in
    ascending order of the source value. Unilateral labels keep one value,
    bilateral labels take two, so the result has no gaps and no dependence on
    the source numbering scheme (AAL's odd/even L/R convention, Harvard-Oxford's
    single-label-per-structure, and a sparse 1..170 range all come out the same
    shape).

    The source volume is never modified.
    """
    import numpy as np
    import nibabel as nib

    img = nib.load(str(volume_path))
    data = np.asarray(img.dataobj)
    if data.ndim == 4 and data.shape[3] == 1:
        data = data[..., 0]
    ints = np.round(data).astype(np.int64)
    affine = np.asarray(img.affine, dtype=float)

    by_value = {int(r["value"]): r for r in regions}
    idx = np.argwhere(ints != 0)
    if not idx.size:
        raise ValueError("volume has no labelled voxels to split")
    labels = ints[idx[:, 0], idx[:, 1], idx[:, 2]]
    xs = _world_x(np, affine, idx)
    on_left = xs < 0 if _MIDLINE_GOES_RIGHT else xs <= 0

    out = np.zeros_like(ints)
    new_regions = []
    next_value = 1

    for src in sorted({int(v) for v in np.unique(labels)}):
        sel = labels == src
        if not sel.any():
            continue
        src_region = by_value.get(src)
        base_name = (src_region or {}).get("name") or ("Region %d" % src)
        color = (src_region or {}).get("color")

        left_sel = sel & on_left
        right_sel = sel & ~on_left
        n_left, n_right = int(left_sel.sum()), int(right_sel.sum())
        total = n_left + n_right

        # Split only what atlas_validate calls bilateral. Splitting on a single
        # stray voxel would shatter a strictly one-sided structure into a real
        # region plus a partial-volume sliver sitting on the midline -- and the
        # wizard, which shows the user atlas_validate's count first, would be
        # lying about how many regions they are about to get.
        frac_left = n_left / total if total else 0.0
        frac_right = n_right / total if total else 0.0
        bilateral = (frac_left > atlas_validate.BILATERAL_FRACTION
                     and frac_right > atlas_validate.BILATERAL_FRACTION)

        sides = []
        if not bilateral:
            # Keep the label whole, on whichever side owns it.
            sides.append((sel, "", "L" if frac_left >= frac_right else "R"))
        else:
            sides.append((left_sel, suffix_left, "L"))
            sides.append((right_sel, suffix_right, "R"))

        # A label that is not bilateral keeps its name unchanged: appending
        # " (R)" to something already called "Right Thalamus" reads as a bug.
        for mask, suffix, hemi in sides:
            picks = idx[mask]
            out[picks[:, 0], picks[:, 1], picks[:, 2]] = next_value
            new_regions.append({
                "value": next_value,
                "name": base_name + suffix,
                "hemi": hemi if hemi else (src_region or {}).get("hemi"),
                "color": list(color) if color else None,
                "centroidMM": None,   # invalidated by the split
            })
            next_value += 1

    dtype = np.int16 if next_value <= 32767 else np.int32
    new_img = nib.Nifti1Image(out.astype(dtype), affine, header=img.header)
    new_img.set_data_dtype(dtype)
    return new_img, new_regions


def region_mask(volume_path, values):
    """Binary mask of the given label values, on the atlas's own grid."""
    import numpy as np
    import nibabel as nib

    wanted = {int(v) for v in (values or [])}
    if not wanted:
        raise ValueError("no regions selected")

    img = nib.load(str(volume_path))
    data = np.asarray(img.dataobj)
    if data.ndim == 4 and data.shape[3] == 1:
        data = data[..., 0]
    ints = np.round(data).astype(np.int64)
    mask = np.isin(ints, list(wanted)).astype(np.uint8)
    if not mask.any():
        raise ValueError("those regions have no voxels in this atlas")

    out = nib.Nifti1Image(mask, np.asarray(img.affine, dtype=float), header=img.header)
    out.set_data_dtype(np.uint8)
    return out


def region_stats(volume_path, regions):
    """Per-region voxel count, volume in mm^3, and centroid in world mm.

    Centroids are snapped to the nearest voxel that is actually IN the region.
    A bilateral single-label structure (Harvard-Oxford cortical, every label)
    has its raw centroid on the midline, outside itself -- navigating there
    lands the crosshair in the opposite hemisphere's white matter. This is the
    same correction lib/volumeAnalysis.regionCentroidMM makes on the client;
    doing it here too means a catalog install can ship centroids and skip the
    client's full-volume scan entirely.
    """
    import numpy as np
    import nibabel as nib

    img = nib.load(str(volume_path))
    data = np.asarray(img.dataobj)
    if data.ndim == 4 and data.shape[3] == 1:
        data = data[..., 0]
    ints = np.round(data).astype(np.int64)
    affine = np.asarray(img.affine, dtype=float)
    voxel_mm3 = float(abs(np.linalg.det(affine[:3, :3])))

    idx = np.argwhere(ints != 0)
    if not idx.size:
        return {}
    labels = ints[idx[:, 0], idx[:, 1], idx[:, 2]]

    out = {}
    for r in regions:
        v = int(r["value"])
        sel = labels == v
        n = int(sel.sum())
        if not n:
            continue
        picks = idx[sel]
        centre = picks.mean(axis=0)
        # Snap onto a voxel that belongs to the region.
        nearest = picks[np.argmin(((picks - centre) ** 2).sum(axis=1))]
        world = affine @ np.array([nearest[0], nearest[1], nearest[2], 1.0])
        out[v] = {
            "voxels": n,
            "volumeMM3": round(n * voxel_mm3, 1),
            "centroidMM": [round(float(c), 2) for c in world[:3]],
        }
    return out


def apply_centroids(regions, stats):
    """Copy centroids from region_stats() onto a region list, in place."""
    for r in regions:
        s = stats.get(int(r["value"]))
        if s:
            r["centroidMM"] = s["centroidMM"]
    return regions


def write_atlas(folder, atlas_id, img, regions):
    """Write <id>.nii.gz + <id>.labels.json into `folder`. Returns the paths."""
    import nibabel as nib

    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    vol = folder / ("%s.nii.gz" % atlas_id)
    lab = folder / ("%s.labels.json" % atlas_id)
    nib.save(img, str(vol))
    atlas_labels.write_labels(lab, regions)
    return vol, lab
