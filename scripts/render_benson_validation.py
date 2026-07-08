"""
Create a visual side-by-side comparison between the source surface .mgz
files (rendered on fsaverage inflated) and our generated MNI152 volumes
(rendered as axial slices). Saves PNGs to /app/scripts/validation_plots/.
Useful for visually confirming that the projected atlas matches Benson 2014.
"""
import os
import numpy as np
import nibabel as nib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from nilearn.datasets import fetch_surf_fsaverage
from nilearn.plotting import plot_surf, plot_stat_map, plot_roi
from nilearn.image import math_img

ATLAS_DIR = "/app/frontend/public/atlases"
OUT_DIR = "/app/scripts/validation_plots"
os.makedirs(OUT_DIR, exist_ok=True)

fs = fetch_surf_fsaverage("fsaverage")

def render_surface_pair(scalar_lh, scalar_rh, title, cmap, vmin, vmax, threshold=None):
    fig, axes = plt.subplots(1, 2, figsize=(10, 5),
                             subplot_kw={"projection": "3d"},
                             facecolor="#050505")
    for ax, hemi, scalar in [(axes[0], "left", scalar_lh), (axes[1], "right", scalar_rh)]:
        mesh = fs[f"infl_{hemi}"]
        plot_surf(mesh, scalar, hemi=hemi, view="lateral",
                  cmap=cmap, vmin=vmin, vmax=vmax,
                  threshold=threshold, bg_map=fs[f"sulc_{hemi}"],
                  bg_on_data=True, axes=ax, figure=fig,
                  colorbar=(hemi == "right"))
        ax.set_facecolor("#050505")
    fig.suptitle(title, color="white", fontsize=12)
    return fig


def render_volume_axial(path, title, cmap, vmin, vmax, threshold=None):
    img = nib.load(path)
    fig = plt.figure(figsize=(10, 4), facecolor="#050505")
    if threshold is None:
        threshold = 1e-6
    plot_stat_map(
        img, bg_img=os.path.join(ATLAS_DIR, "mni152.nii.gz"),
        display_mode="z", cut_coords=6, cmap=cmap,
        vmin=vmin, vmax=vmax, threshold=threshold,
        figure=fig, colorbar=True, black_bg=True,
        title=title,
    )
    return fig


def main():
    # 1) Polar angle (signed: LH +0..+180, RH -180..0)
    lh = np.asarray(nib.load(f"{ATLAS_DIR}/lh.benson14_angle.v4_0.mgz").dataobj).squeeze()
    rh = -1 * np.asarray(nib.load(f"{ATLAS_DIR}/rh.benson14_angle.v4_0.mgz").dataobj).squeeze()
    f = render_surface_pair(lh, rh, "Benson 2014 Polar Angle — fsaverage source (signed)", "twilight", -180, 180, threshold=0.5)
    f.savefig(f"{OUT_DIR}/01_polar_angle_surface.png", dpi=110, facecolor="#050505")
    plt.close(f)
    f = render_volume_axial(f"{ATLAS_DIR}/benson14_polar_angle.nii.gz",
                            "Benson 2014 Polar Angle — projected to MNI152 (signed)",
                            "twilight", -180, 180, threshold=0.5)
    f.savefig(f"{OUT_DIR}/02_polar_angle_volume.png", dpi=110, facecolor="#050505")
    plt.close(f)

    # 2) Eccentricity
    lh = np.asarray(nib.load(f"{ATLAS_DIR}/lh.benson14_eccen.v4_0.mgz").dataobj).squeeze()
    rh = np.asarray(nib.load(f"{ATLAS_DIR}/rh.benson14_eccen.v4_0.mgz").dataobj).squeeze()
    f = render_surface_pair(lh, rh, "Benson 2014 Eccentricity — fsaverage source", "hot", 0, 90, threshold=1e-3)
    f.savefig(f"{OUT_DIR}/03_eccen_surface.png", dpi=110, facecolor="#050505")
    plt.close(f)
    f = render_volume_axial(f"{ATLAS_DIR}/benson14_eccentricity.nii.gz",
                            "Benson 2014 Eccentricity — projected to MNI152",
                            "hot", 0, 90, threshold=1e-3)
    f.savefig(f"{OUT_DIR}/04_eccen_volume.png", dpi=110, facecolor="#050505")
    plt.close(f)

    # 3) Visual areas (Benson — 12 labels)
    lh = np.asarray(nib.load(f"{ATLAS_DIR}/lh.benson14_varea.v4_0.mgz").dataobj).squeeze().astype(int)
    rh = np.asarray(nib.load(f"{ATLAS_DIR}/rh.benson14_varea.v4_0.mgz").dataobj).squeeze().astype(int)
    f = render_surface_pair(lh, rh, "Benson 2014 Visual Areas — fsaverage source (12 areas)", "tab20", 1, 12, threshold=0.5)
    f.savefig(f"{OUT_DIR}/05_varea_surface.png", dpi=110, facecolor="#050505")
    plt.close(f)
    img = nib.load(f"{ATLAS_DIR}/benson14_visual_areas.nii.gz")
    fig = plt.figure(figsize=(10, 4), facecolor="#050505")
    plot_roi(img, bg_img=os.path.join(ATLAS_DIR, "mni152.nii.gz"),
             display_mode="z", cut_coords=6, cmap="tab20",
             figure=fig, black_bg=True,
             title="Benson 2014 Visual Areas — projected to MNI152")
    fig.savefig(f"{OUT_DIR}/06_varea_volume.png", dpi=110, facecolor="#050505")
    plt.close(fig)

    # 4) Wang 2015
    lh = np.asarray(nib.load(f"{ATLAS_DIR}/lh.wang15_mplbl.v1_0.mgz").dataobj).squeeze().astype(int)
    rh = np.asarray(nib.load(f"{ATLAS_DIR}/rh.wang15_mplbl.v1_0.mgz").dataobj).squeeze().astype(int)
    f = render_surface_pair(lh, rh, "Wang 2015 — fsaverage source (25 ROIs)", "tab20", 1, 25, threshold=0.5)
    f.savefig(f"{OUT_DIR}/07_wang_surface.png", dpi=110, facecolor="#050505")
    plt.close(f)
    img = nib.load(f"{ATLAS_DIR}/wang2015_maxprob.nii.gz")
    fig = plt.figure(figsize=(10, 4), facecolor="#050505")
    plot_roi(img, bg_img=os.path.join(ATLAS_DIR, "mni152.nii.gz"),
             display_mode="z", cut_coords=6, cmap="tab20",
             figure=fig, black_bg=True,
             title="Wang 2015 — projected to MNI152")
    fig.savefig(f"{OUT_DIR}/08_wang_volume.png", dpi=110, facecolor="#050505")
    plt.close(fig)

    print(f"All 8 validation plots written to {OUT_DIR}/")


if __name__ == "__main__":
    main()
