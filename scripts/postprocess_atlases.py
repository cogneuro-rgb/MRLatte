"""
Hot-fix script — runs after generate_real_benson.py to enforce:
  1. Benson polar_angle: merge LH + RH into ONE 0..360 volume so that
     left- and right-hemifield are different colors on the SAME continuous
     scale (no hemisphere-split files, no signed values).

       LH cortex (processes RIGHT visual field) →   1..180
         · UVM    →   1°  (red)
         · RHM    →  90°  (yellow)
         · LVM    → 180°  (blue)
       RH cortex (processes  LEFT visual field) → 180..360
         · LVM    → 180°  (blue)
         · LHM    → 270°  (cyan)
         · UVM    → 360°  (red)

     Background voxels stay at exactly 0 so the viewer can set cal_min=1
     and hide them. Hemisphere split is done via the MNI x-coordinate
     (x_mm >= 0 → right hemisphere).

  2. visfAtlas: resample the user-uploaded 1 mm volume to our MNI152
     0.74 mm grid so voxel lookups (and the on-screen overlay) line up
     with the other atlases.

Outputs are written in place over the previous files.
"""
import os
import numpy as np
import nibabel as nib
from nilearn.image import resample_to_img

ATLAS_DIR = "/app/frontend/public/atlases"

# --- 1) Merge Benson polar_angle into one 0..360 volume ---
print("Merging Benson polar angle into one 0..360 volume…")
mni = nib.load(f"{ATLAS_DIR}/mni152.nii.gz")
pa = nib.load(f"{ATLAS_DIR}/benson14_polar_angle.nii.gz")
raw = pa.get_fdata().astype(np.float32)
abs_pa = np.abs(raw)                            # 0..180 (always)
mask = abs_pa > 1e-6                            # cortex coverage from neuropythy

aff = pa.affine
i_idx = np.arange(raw.shape[0])
ones = np.ones_like(i_idx)
hom = np.stack([i_idx, np.zeros_like(i_idx), np.zeros_like(i_idx), ones], axis=-1).astype(np.float32)
x_mm_per_i = (hom @ aff.T)[:, 0]
rh_mask_3d = (x_mm_per_i >= 0)[:, None, None]   # broadcast over (J, K)

merged = np.zeros_like(abs_pa, dtype=np.float32)
# LH cortex → 1..180 (clamp lower bound to 1 so UVM stays visible above bg)
lh_vals = np.clip(abs_pa, 1.0, 180.0)
# RH cortex → 180..360 (wrap: UVM=360, LHM=270, LVM=180)
rh_vals = np.clip(360.0 - abs_pa, 180.0, 360.0)

lh_sel = mask & ~rh_mask_3d
rh_sel = mask &  rh_mask_3d
merged[lh_sel] = lh_vals[lh_sel]
merged[rh_sel] = rh_vals[rh_sel]

print(f"  LH cortex voxels  {int(lh_sel.sum()):,}  range {merged[lh_sel].min():.2f}..{merged[lh_sel].max():.2f}")
print(f"  RH cortex voxels  {int(rh_sel.sum()):,}  range {merged[rh_sel].min():.2f}..{merged[rh_sel].max():.2f}")
print(f"  background voxels {int((merged == 0).sum()):,}  (kept at 0 → transparent with cal_min=1)")

nib.save(nib.Nifti1Image(merged, aff), f"{ATLAS_DIR}/benson14_polar_angle.nii.gz")
print("  wrote merged benson14_polar_angle.nii.gz")

# Remove the now-stale hemisphere-split files so the dashboard never tries to load them.
for stale in ("benson14_polar_angle_lh.nii.gz", "benson14_polar_angle_rh.nii.gz"):
    p = f"{ATLAS_DIR}/{stale}"
    if os.path.exists(p):
        os.remove(p)
        print(f"  removed stale {stale}")

# --- 2) Resample visfAtlas to MNI152 0.74mm grid ---
print("\nResampling visfAtlas to MNI152 grid…")
visf_in = nib.load(f"{ATLAS_DIR}/visfAtlas_maxprob.nii.gz")
print(f"  input shape={visf_in.shape}  affine_diag={np.diag(visf_in.affine)[:3]}")
if visf_in.shape == mni.shape and np.allclose(visf_in.affine, mni.affine):
    print("  already aligned to MNI152 grid — skipping resample")
else:
    visf_out = resample_to_img(visf_in, mni, interpolation="nearest", force_resample=True, copy_header=False)
    arr = np.asarray(visf_out.dataobj).astype(np.int16)
    print(f"  output shape={arr.shape}  labels found: {np.unique(arr).tolist()[:10]}...")
    nib.save(nib.Nifti1Image(arr, mni.affine), f"{ATLAS_DIR}/visfAtlas_maxprob.nii.gz")
    print(f"  wrote resampled visfAtlas_maxprob.nii.gz  nonzero={int((arr>0).sum()):,}")
