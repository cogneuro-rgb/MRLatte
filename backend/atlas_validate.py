"""Structural validation for an atlas volume the user is about to install.

Same contract as module_slots.VALIDATORS: every function returns
(ok: bool, reason: str, details: dict) and NEVER raises. A malformed atlas is
normal, expected input here -- someone is uploading a file that may well be the
wrong thing -- so `reason` is user-facing and must say what is wrong, not just
"invalid". The import wizard renders `reason` and `details["warnings"]`
verbatim.

Refusals are reserved for files we genuinely cannot use. Everything else is a
warning: plenty of legitimate atlases are in an unusual space, or have labels
the author never named, and refusing those would just push the user to edit
files by hand.
"""
from __future__ import annotations

from pathlib import Path

# An atlas covering a brain in MNI space should not reach much beyond this.
# module_slots.validate_tractogram applies the same bound to tractograms, and
# dissect_worker to incoming lesion masks.
_MNI_SANITY_MM = 250.0

# Above this many distinct labels the thing is more likely a continuous map
# that happens to be integer-valued (or a mislabelled probability volume) than
# a parcellation anyone will navigate region by region.
_MAX_LABELS = 5000

_MIN_VOXEL_MM = 0.2
_MAX_VOXEL_MM = 5.0

# A label is "on both sides" only if a real share of it sits either side of the
# mid-sagittal plane -- partial-volume bleed across x=0 is normal and should not
# make a strictly unilateral region look bilateral.
#
# PUBLIC: atlas_ops.split_lr imports this. The probe that tells the user "N
# regions span both sides" and the operation that then splits them MUST agree,
# or the wizard promises 1 new region and delivers 5.
BILATERAL_FRACTION = 0.15
_BILATERAL_FRACTION = BILATERAL_FRACTION
_UNILATERAL_FRACTION = 0.85


def inspect_volume(path):
    """Validate an atlas volume and describe it.

    details, on success:
        shape, voxelSizeMM, kind ("parcellation" | "continuous"),
        labelValues (sorted ints, capped), labelCount, warnings [str],
        lateralized (bool|None), bilateralValues [int], voxelCounts {value: n}
    """
    p = Path(path)
    try:
        import numpy as np
        import nibabel as nib
    except ImportError as exc:  # pragma: no cover - deps are installed
        return False, "numpy/nibabel unavailable on the server: %s" % exc, {}

    try:
        img = nib.load(str(p))
    except Exception as exc:  # noqa: BLE001 -- any parse failure is a bad file
        return False, "not a readable NIfTI: %s" % exc, {}

    try:
        data = np.asarray(img.dataobj)
    except Exception as exc:  # noqa: BLE001
        return False, "NIfTI header is readable but the data is not: %s" % exc, {}

    warnings = []

    # A 4-D volume with a singleton last axis is just a 3-D volume that went
    # through a tool that kept the time axis; squeeze it rather than refuse.
    if data.ndim == 4 and data.shape[3] == 1:
        data = data[..., 0]
        warnings.append("4-D volume with a single frame; using frame 0.")
    if data.ndim != 3:
        return False, (
            "expected a 3-D label volume, got %d dimensions %s. A 4-D "
            "probabilistic atlas has to be converted to max-probability first."
            % (data.ndim, tuple(data.shape))), {}

    if not np.all(np.isfinite(data)):
        return False, "volume contains NaN or Inf values", {}

    affine = np.asarray(img.affine, dtype=float)
    if affine.shape != (4, 4) or not np.isfinite(affine).all():
        return False, "affine is missing or not finite", {}
    if abs(float(np.linalg.det(affine[:3, :3]))) < 1e-9:
        return False, "affine is singular (zero-volume voxels)", {}

    voxel = [float(v) for v in np.sqrt((affine[:3, :3] ** 2).sum(axis=0))]
    if any(v < _MIN_VOXEL_MM or v > _MAX_VOXEL_MM for v in voxel):
        warnings.append(
            "voxel size %s mm is outside the usual %g-%g mm range."
            % ([round(v, 3) for v in voxel], _MIN_VOXEL_MM, _MAX_VOXEL_MM))

    corners = _corners_mm(np, affine, data.shape)
    reach = float(np.abs(corners).max()) if len(corners) else 0.0
    if reach > _MNI_SANITY_MM:
        warnings.append(
            "volume reaches %.0f mm from the origin; an MNI-space atlas stays "
            "within about %.0f mm, so this may not be in MNI space."
            % (reach, _MNI_SANITY_MM))

    # Discrete or not? A parcellation's values are integers; anything else is a
    # continuous map, which we accept but flag, because region tables and the
    # label list are meaningless for it.
    finite = data[np.isfinite(data)]
    integral = bool(finite.size) and bool(np.all(finite == np.round(finite)))
    kind = "parcellation" if integral else "continuous"
    if not integral:
        warnings.append(
            "values are not whole numbers, so this is a continuous map rather "
            "than a parcellation. Region labelling will not apply to it.")

    values = np.unique(np.round(data).astype(np.int64)) if integral else np.array([], dtype=np.int64)
    values = values[values != 0]
    if integral and values.size > _MAX_LABELS:
        warnings.append(
            "%d distinct labels; only the first %d are listed."
            % (int(values.size), _MAX_LABELS))

    listed = values[:_MAX_LABELS]
    counts = {}
    lateral = None
    bilateral = []
    if integral and listed.size:
        counts, lateral, bilateral = _lateralization(np, data, affine, listed)

    details = {
        "shape": [int(s) for s in data.shape],
        "voxelSizeMM": [round(v, 4) for v in voxel],
        "reachMM": round(reach, 1),
        "kind": kind,
        "labelValues": [int(v) for v in listed],
        "labelCount": int(values.size),
        "voxelCounts": counts,
        "lateralized": lateral,
        "bilateralValues": bilateral,
        "warnings": warnings,
    }
    if integral and not listed.size:
        return False, "volume has no non-zero labels -- it is empty", details
    return True, "", details


def _corners_mm(np, affine, shape):
    i, j, k = (shape[0] - 1, shape[1] - 1, shape[2] - 1)
    pts = np.array([[0, 0, 0, 1], [i, 0, 0, 1], [0, j, 0, 1], [0, 0, k, 1],
                    [i, j, 0, 1], [i, 0, k, 1], [0, j, k, 1], [i, j, k, 1]],
                   dtype=float)
    return (affine @ pts.T).T[:, :3]


def _lateralization(np, data, affine, values):
    """Per-label voxel counts and which labels straddle the mid-sagittal plane.

    World x is what decides the side, not voxel i: the shipped atlases are
    LIA-native, so the voxel axes do not line up with left/right. Returns
    (counts, lateralized, bilateralValues) where `lateralized` is True when
    every label is essentially one-sided, False when at least one straddles,
    and None when there is nothing to judge.
    """
    ints = np.round(data).astype(np.int64)
    idx = np.argwhere(ints != 0)
    if not idx.size:
        return {}, None, []
    labels = ints[idx[:, 0], idx[:, 1], idx[:, 2]]
    # Only the x row of the affine is needed to place a voxel left or right.
    xs = (idx * affine[0, :3]).sum(axis=1) + affine[0, 3]

    counts, bilateral, one_sided = {}, [], 0
    for v in values.tolist():
        sel = labels == v
        n = int(sel.sum())
        if not n:
            continue
        counts[int(v)] = n
        left = float((xs[sel] < 0).sum()) / n
        right = 1.0 - left
        if left > _BILATERAL_FRACTION and right > _BILATERAL_FRACTION:
            bilateral.append(int(v))
        elif max(left, right) >= _UNILATERAL_FRACTION:
            one_sided += 1
    if not counts:
        return {}, None, []
    return counts, (not bilateral and one_sided == len(counts)), bilateral


def cross_check_labels(details: dict, regions):
    """Compare a label list against the values actually present in the volume.

    Returns a warnings list. Neither direction is fatal: an atlas whose author
    listed regions that got thresholded away still works, and unnamed labels
    just render as their number.
    """
    out = []
    present = set(details.get("labelValues") or [])
    named = {int(r["value"]) for r in (regions or [])}
    if not present:
        return out
    missing = sorted(present - named)
    orphan = sorted(named - present)
    if missing:
        out.append(
            "%d label%s in the volume have no name (%s%s)."
            % (len(missing), "" if len(missing) == 1 else "s",
               ", ".join(str(v) for v in missing[:10]),
               ", ..." if len(missing) > 10 else ""))
    if orphan:
        out.append(
            "%d named region%s have no voxels in the volume (%s%s)."
            % (len(orphan), "" if len(orphan) == 1 else "s",
               ", ".join(str(v) for v in orphan[:10]),
               ", ..." if len(orphan) > 10 else ""))
    return out
