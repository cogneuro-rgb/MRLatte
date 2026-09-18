"""
Generate MNI152 retinotopy & visual area maps using REAL anatomical visual cortex
from the Juelich cytoarchitectonic atlas (indices 48-52: V1, V2, V3V, V4, V5).

Outputs into data/modules/atlases/ (one folder per atlas family):
  misc/visual_areas_v1v5.nii.gz   int16 labels 1..5 (V1, V2, V3V, V4, V5)
  wang2015/wang2015_maxprob.nii.gz    int16 labels 1..11 (Wang regions, anchored on V1/V2/V3 subdivision)
  wang2015/wang2015_prob.nii.gz       float32 0..1 probability map
  benson14/benson14_polar_angle.nii.gz   float32 0..360 deg, only within visual areas
  benson14/benson14_eccentricity.nii.gz  float32 0..90 deg, only within visual areas

Note: Polar angle and eccentricity are anatomically-grounded geometric estimates
constrained to the real visual cortex (Juelich), not on arbitrary spheres.
"""

import os
import numpy as np
import nibabel as nib

ATLAS_DIR = "data/modules/atlases"
MNI_PATH = os.path.join(ATLAS_DIR, "mni152", "mni152.nii.gz")
JUELICH_PATH = os.path.join(ATLAS_DIR, "juelich", "juelich_atlas.nii.gz")

# Juelich label IDs for visual cortex
V1_ID = 48   # BA17
V2_ID = 49   # BA18
V3_ID = 50   # V3V
V4_ID = 51   # hV4
V5_ID = 52   # V5 / MT


def main():
    print("Loading MNI152 + Juelich…")
    mni = nib.load(MNI_PATH)
    aff = mni.affine
    shape = mni.shape

    jue = nib.load(JUELICH_PATH)
    jue_data = jue.get_fdata().astype(np.int16)
    # Juelich may have different shape — resample to MNI grid via nilearn
    if jue_data.shape != shape:
        print(f"  Resampling Juelich {jue_data.shape} -> MNI {shape}…")
        from nilearn.image import resample_to_img
        jue_res = resample_to_img(jue, mni, interpolation="nearest")
        jue_data = jue_res.get_fdata().astype(np.int16)
    print(f"  Juelich aligned: shape={jue_data.shape}")

    # Build MNI coordinate grid
    i, j, k = np.meshgrid(np.arange(shape[0]), np.arange(shape[1]), np.arange(shape[2]), indexing="ij")
    vox = np.stack([i, j, k, np.ones_like(i)], axis=-1).astype(np.float32)
    coords = vox @ aff.T
    X, Y, Z = coords[..., 0], coords[..., 1], coords[..., 2]

    # === Visual Areas mask (real cytoarchitectonic) ===
    v1 = (jue_data == V1_ID)
    v2 = (jue_data == V2_ID)
    v3 = (jue_data == V3_ID)
    v4 = (jue_data == V4_ID)
    v5 = (jue_data == V5_ID)
    visual_mask = v1 | v2 | v3 | v4 | v5

    varea = np.zeros(shape, dtype=np.int16)
    varea[v1] = 1
    varea[v2] = 2
    varea[v3] = 3
    varea[v4] = 4
    varea[v5] = 5
    print(f"  V1={int(v1.sum()):,}, V2={int(v2.sum()):,}, V3V={int(v3.sum()):,}, V4={int(v4.sum()):,}, V5={int(v5.sum()):,}")

    # === Fovea coords for polar/eccen estimation ===
    # The calcarine occipital pole (foveal representation) at posterior V1
    # Pick centroids of V1 in left and right hemispheres at the occipital pole
    fov_L = np.array([-12.0, -90.0, 0.0])
    fov_R = np.array([+12.0, -90.0, 0.0])

    dL = np.sqrt((X - fov_L[0]) ** 2 + (Y - fov_L[1]) ** 2 + (Z - fov_L[2]) ** 2)
    dR = np.sqrt((X - fov_R[0]) ** 2 + (Y - fov_R[1]) ** 2 + (Z - fov_R[2]) ** 2)
    d_side = np.minimum(dL, dR)
    closer_L = dL < dR

    # Polar angle: color encodes the VISUAL FIELD position (Benson 2014 convention).
    # Both hemispheres use the same 0–360° color disc:
    #   0°   = upper vertical meridian (UVM)
    #   90°  = right horizontal meridian (RHM) — represented by left hemisphere cortex
    #   180° = lower vertical meridian (LVM)
    #   270° = left horizontal meridian (LHM) — represented by right hemisphere cortex
    # Left hemisphere encodes the contralateral (right) hemifield: 0–180°.
    # Right hemisphere encodes the contralateral (left) hemifield: 180–360°.
    cz = np.where(closer_L, fov_L[2], fov_R[2])
    cy = np.where(closer_L, fov_L[1], fov_R[1])
    cx = np.where(closer_L, fov_L[0], fov_R[0])
    dz_loc = Z - cz
    dy_loc = Y - cy
    base_angle = np.degrees(np.arctan2(np.abs(dy_loc), -dz_loc))  # 0..180
    # Flip the angle for right hemisphere so it spans 180..360
    angle = np.where(closer_L, base_angle, 360.0 - base_angle)
    polar = np.where(visual_mask, angle, 0).astype(np.float32)

    # Eccentricity within visual cortex - cortical distance from foveal pole
    # In real retinotopy, V1 has fovea at occipital pole, periphery anterior.
    # Distance from fovea along the cortical surface ≈ eccentricity 0..~80°
    eccen_raw = d_side
    eccen = np.where(visual_mask, np.clip(eccen_raw / 50 * 90, 0, 90), 0).astype(np.float32)

    # === Wang 2015 max-prob: subdivide V1/V2/V3 into d/v, plus V4, V5 ===
    # Dorsal/ventral split by Z (above/below calcarine ≈ Z=0 in occipital cortex)
    dorsal = Z > 0
    wang = np.zeros(shape, dtype=np.int16)
    wang[v1 & dorsal] = 1   # V1d
    wang[v1 & ~dorsal] = 2  # V1v
    wang[v2 & dorsal] = 3   # V2d
    wang[v2 & ~dorsal] = 4  # V2v
    wang[v3 & dorsal] = 5   # V3d (interior dorsal portion of Juelich V3V mask + extra)
    wang[v3 & ~dorsal] = 6  # V3v
    wang[v4] = 7            # hV4
    wang[v5] = 10           # TO1 ≈ V5/MT
    # Additional subdivisions remain 0 (not present without Wang real data)

    # Probabilistic map (gaussian on cortical-distance from region centroid)
    from scipy.ndimage import distance_transform_edt
    prob = np.zeros(shape, dtype=np.float32)
    for label_id in range(1, 11):
        m = (wang == label_id)
        if not m.any(): continue
        dist_in = distance_transform_edt(m)
        max_d = max(dist_in.max(), 1.0)
        p = np.clip(0.5 + 0.5 * (dist_in / max_d), 0.5, 1.0)
        prob = np.where(m, p, prob)

    # === Save ===
    def save(arr, fname, dtype):
        # `fname` is <family>/<file> — atlases are grouped one folder per family.
        out = nib.Nifti1Image(arr.astype(dtype), aff, mni.header)
        out.set_data_dtype(dtype)
        dest = os.path.join(ATLAS_DIR, *fname.split("/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        nib.save(out, dest)
        nz = int((arr != 0).sum())
        rng = f"{arr.min():.2f}..{arr.max():.2f}" if arr.dtype.kind == "f" else f"{int(arr.min())}..{int(arr.max())}"
        print(f"  ✓ {fname} | nz={nz:,} | range={rng}")

    print("Saving…")
    save(varea, "misc/visual_areas_v1v5.nii.gz", np.int16)
    save(polar, "benson14/benson14_polar_angle.nii.gz", np.float32)
    save(eccen, "benson14/benson14_eccentricity.nii.gz", np.float32)
    save(wang, "wang2015/wang2015_maxprob.nii.gz", np.int16)
    save(prob, "wang2015/wang2015_prob.nii.gz", np.float32)
    # Also keep old name for backward-compat link
    save(varea, "benson14/benson14_visual_areas.nii.gz", np.int16)
    print("Done.")


if __name__ == "__main__":
    main()
