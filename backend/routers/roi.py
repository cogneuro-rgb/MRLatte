# Auto-split from server.py — roi endpoints.
from fastapi import APIRouter
from deps import *  # noqa: F401,F403 (shared config, models, helpers)

router = APIRouter()


@router.post("/roi/sphere")
async def roi_sphere(
    x: float = Form(...),
    y: float = Form(...),
    z: float = Form(...),
    radius: float = Form(...),
    label: str = Form("roi"),
):
    """Rasterize a spherical ROI onto the bundled MNI152 grid and persist it.

    X/Y/Z are world (MNI) millimeters; radius is in millimeters. The mask is
    served by GET /api/roi/result/{result_id}/{filename} for download and for
    loading as an overlay in the viewer.
    """
    if radius <= 0:
        raise HTTPException(status_code=400, detail="Radius must be greater than 0.")

    ref_path = ATLAS_DIR / "mni152" / "mni152.nii.gz"
    if not ref_path.exists():
        raise HTTPException(status_code=503,
            detail="MNI152 reference template not found on server.")

    result_id = str(uuid.uuid4())
    slug = _safe_slug(label)
    filename = f"roi_{slug}.nii.gz"

    def _build():
        import numpy as np
        import nibabel as nib

        ref = nib.load(str(ref_path))
        affine = ref.affine
        shape = tuple(int(d) for d in ref.shape[:3])
        inv = np.linalg.inv(affine)

        center_vox = inv.dot(np.array([x, y, z, 1.0]))[:3]
        # Voxel size (mm) per axis, to bound the search box around the center.
        vox_sizes = np.sqrt((affine[:3, :3] ** 2).sum(axis=0))
        pad = np.ceil(radius / np.maximum(vox_sizes, 1e-6)).astype(int) + 1

        lo = np.maximum(np.floor(center_vox - pad).astype(int), 0)
        hi = np.minimum(np.ceil(center_vox + pad).astype(int), np.array(shape) - 1)
        if np.any(lo > hi):
            return None, 0  # sphere entirely outside the volume

        mask = np.zeros(shape, dtype=np.int16)
        ii, jj, kk = np.meshgrid(
            np.arange(lo[0], hi[0] + 1),
            np.arange(lo[1], hi[1] + 1),
            np.arange(lo[2], hi[2] + 1),
            indexing="ij",
        )
        vox = np.stack([ii.ravel(), jj.ravel(), kk.ravel(), np.ones(ii.size)], axis=0)
        world = affine.dot(vox)[:3].T  # (N, 3) in mm
        dist = np.sqrt(((world - np.array([x, y, z])) ** 2).sum(axis=1))
        inside = dist <= radius
        n_vox = int(inside.sum())
        if n_vox > 0:
            sel = vox[:3, inside].astype(int)
            mask[sel[0], sel[1], sel[2]] = 1

        result_dir = ROI_RESULTS_DIR / result_id
        result_dir.mkdir(parents=True, exist_ok=True)
        nib.save(nib.Nifti1Image(mask, affine), str(result_dir / filename))
        return str(result_dir / filename), n_vox

    try:
        saved_path, n_vox = await run_in_threadpool(_build)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ROI creation failed: {e}")

    if saved_path is None or n_vox == 0:
        raise HTTPException(status_code=422,
            detail="Sphere falls entirely outside the MNI152 volume — check the coordinates.")

    return {
        "id": result_id,
        "label": label,
        "voxels": n_vox,
        "file": f"/api/roi/result/{result_id}/{filename}",
    }
@router.get("/roi/result/{result_id}/{filename}")
async def roi_result(result_id: str, filename: str):
    """Serve a persisted spherical-ROI NIfTI for download / overlay loading."""
    if not _UUID4_RE.match(result_id):
        raise HTTPException(status_code=400, detail="Invalid result id.")
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    file_path = ROI_RESULTS_DIR / result_id / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Result file not found.")
    media = "application/gzip" if filename.endswith(".gz") else "application/octet-stream"
    return FileResponse(path=str(file_path), media_type=media, filename=filename)
