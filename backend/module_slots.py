"""Structural validation for user-supplied module "slots".

Two modules are not fixed artifacts we can hash: the whole-brain tractogram and
the DA-LNM connectome bundle. Both are obtained by the user (the HCP Open Access
Data Use Terms restrict redistribution to people who registered themselves), and
neither has to be one specific file — any whole-brain tractogram registered to
MNI works for dissection, and the LNM bundle can legitimately be rebuilt on a
different substrate such as GSP1000.

So instead of pinning a filename and a sha256, a slot is a DIRECTORY that is
scanned for a file satisfying the structural contract the code actually depends
on. Drop a conforming file in and the feature turns on.

Every validator returns (ok: bool, reason: str, details: dict) and NEVER raises:
a malformed file is a normal, expected input here. `reason` is user-facing — it
is shown in the Module Store — so it must say what is wrong, not just "invalid".
Validation reads headers, never the whole file, so a 700 MB tractogram is cheap
to check.
"""
from __future__ import annotations

from pathlib import Path

# A tractogram covering a brain in MNI space should not have corners much beyond
# this. dissect_worker.py applies the same bound to incoming lesion masks.
_MNI_SANITY_MM = 250.0


def validate_tractogram(path: Path):
    """A whole-brain tractogram usable by dissect_worker.

    Only .trk qualifies. dissect_worker loads with `reference='same'`, which
    requires the file to carry its own reference grid; a .tck stores streamlines
    in RASMM with NO embedded reference and would raise there, so accepting one
    here would just move the failure somewhere less legible.
    """
    suffix = path.suffix.lower()
    if suffix == ".tck":
        return False, (
            ".tck carries no reference grid, and tract dissection needs one "
            "(it loads with reference='same'). Convert to .trk."), {}
    if suffix != ".trk":
        return False, f"unsupported extension '{suffix}' — expected .trk", {}

    try:
        import nibabel as nib
        tf = nib.streamlines.load(str(path), lazy_load=True)
    except Exception as exc:  # noqa: BLE001 — any parse failure is a bad file
        return False, f"not a readable tractogram: {exc}", {}

    hdr = getattr(tf, "header", {}) or {}
    try:
        n = int(hdr.get("nb_streamlines", 0) or 0)
    except (TypeError, ValueError):
        n = 0
    if n < 1:
        return False, "contains no streamlines", {}

    try:
        import numpy as np
        affine = np.asarray(tf.affine)
        dims = [int(d) for d in hdr.get("dimensions", [])]
    except Exception as exc:  # noqa: BLE001
        return False, f"unreadable reference grid: {exc}", {}

    if affine.shape != (4, 4) or not np.all(np.isfinite(affine)):
        return False, "reference affine is missing or not a finite 4x4", {}
    if abs(float(np.linalg.det(affine[:3, :3]))) < 1e-9:
        return False, "reference affine is singular (zero-volume voxels)", {}
    if len(dims) != 3 or any(d <= 0 for d in dims):
        return False, f"implausible reference dimensions {dims}", {}

    # World-space extent of the reference grid corners.
    corners = np.array([[0, 0, 0, 1], [dims[0], 0, 0, 1], [0, dims[1], 0, 1],
                        [0, 0, dims[2], 1], [dims[0], dims[1], dims[2], 1]]).T
    world = (affine @ corners)[:3]
    reach = float(np.abs(world).max())
    if reach > _MNI_SANITY_MM:
        return False, (
            f"reference grid reaches {reach:.0f} mm from the origin, beyond the "
            f"{_MNI_SANITY_MM:.0f} mm expected of MNI space — is this registered "
            "to the MNI template?"), {}

    return True, "", {"streamlines": n, "dimensions": dims,
                      "voxelSizeMM": [round(float(v), 3) for v in
                                      np.sqrt((affine[:3, :3] ** 2).sum(axis=0))]}


# Arrays Connectome.__init__ reads out of the bundle (lnm_backend.py:51-58).
_LNM_KEYS = ("A", "mask", "affine", "grid", "covs", "G", "dim")


def validate_lnm_bundle(path: Path):
    """A DA-LNM connectome bundle consumable by lnm_backend.Connectome.

    Checks the arrays actually indexed there, and their mutual consistency —
    a bundle whose `covs` and `A` disagree on D loads fine and then fails deep
    inside an einsum, which is far harder to diagnose than a message here.
    """
    if path.suffix.lower() != ".npz":
        return False, f"unsupported extension '{path.suffix}' — expected .npz", {}

    try:
        import numpy as np
        z = np.load(str(path), mmap_mode="r", allow_pickle=False)
    except Exception as exc:  # noqa: BLE001
        return False, f"not a readable .npz: {exc}", {}

    try:
        missing = [k for k in _LNM_KEYS if k not in z.files]
        if missing:
            return False, f"missing array(s): {', '.join(missing)}", {}

        A, mask, covs, G = z["A"], z["mask"], z["covs"], z["G"]
        affine, grid = z["affine"], z["grid"]
        try:
            D = int(z["dim"])
        except Exception:  # noqa: BLE001
            return False, "'dim' is not a scalar integer", {}

        if A.ndim != 2:
            return False, f"'A' should be 2-D (voxels x components), got {A.ndim}-D", {}
        if covs.ndim != 3:
            return False, f"'covs' should be 3-D (subjects x D x D), got {covs.ndim}-D", {}
        V, aD = A.shape
        N = covs.shape[0]

        if aD != D:
            return False, f"'A' has {aD} components but 'dim' says {D}", {}
        if covs.shape[1:] != (D, D):
            return False, f"'covs' is {covs.shape}, expected (N, {D}, {D})", {}
        if tuple(G.shape) != (D, D):
            return False, f"'G' is {tuple(G.shape)}, expected ({D}, {D})", {}
        if N < 2:
            return False, f"only {N} subject(s); the t-map needs across-subject variance", {}
        if tuple(np.asarray(affine).shape) != (4, 4):
            return False, "'affine' is not 4x4", {}

        gshape = tuple(int(g) for g in np.asarray(grid).ravel()[:3])
        if tuple(mask.shape) != gshape:
            return False, f"'mask' is {tuple(mask.shape)} but 'grid' says {gshape}", {}
        nvox = int(np.count_nonzero(np.asarray(mask)))
        if nvox != V:
            return False, (f"'mask' selects {nvox} voxels but 'A' has {V} rows — "
                           "mask and component maps disagree"), {}

        return True, "", {"subjects": N, "components": D, "voxels": V, "grid": list(gshape)}
    finally:
        try:
            z.close()
        except Exception:  # noqa: BLE001
            pass


VALIDATORS = {
    "tractogram": validate_tractogram,
    "lnm-bundle": validate_lnm_bundle,
}


def scan_slot(directory: Path, extensions, validator: str):
    """Find the first file in `directory` satisfying `validator`.

    Returns (path|None, state, reason, details) where state is one of
    "installed" | "missing" | "broken". The distinction matters: an empty slot
    is `missing` (nothing to report), whereas a present-but-invalid file is
    `broken` WITH a reason — "this .trk has no reference affine" is actionable,
    "not installed" sends the user looking for a file that is already there.
    """
    fn = VALIDATORS.get(validator)
    if fn is None:
        return None, "broken", f"unknown validator '{validator}'", {}
    try:
        if not directory.is_dir():
            return None, "missing", "", {}
        candidates = sorted(
            p for p in directory.iterdir()
            if p.is_file() and p.suffix.lower() in extensions
            and not p.name.endswith(".part")
        )
    except OSError as exc:
        return None, "broken", f"cannot read slot directory: {exc}", {}

    if not candidates:
        return None, "missing", "", {}

    first_reason = ""
    for p in candidates:
        ok, reason, details = fn(p)
        if ok:
            return p, "installed", "", details
        first_reason = first_reason or f"{p.name}: {reason}"
    return None, "broken", first_reason, {}
