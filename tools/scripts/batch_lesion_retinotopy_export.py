#!/usr/bin/env python3
"""
Batch lesion → polar angle / eccentricity chart export + aggregate heatmap.

For each lesion NIfTI in --lesions-dir, compute overlap with Benson14
retinotopy atlases (polar_angle.nii.gz, eccentricity.nii.gz) and render
a chart identical to MRLatte's in-app "Export PNG" feature.

Also generates aggregate 2D heatmaps across all lesions showing voxel overlap
patterns per degree bin.

Usage:
    python batch_lesion_retinotopy_export.py \\
        --lesions-dir /path/to/lesions \\
        --output-dir /path/to/output \\
        [--polar-atlas /path/to/benson14_polar_angle.nii.gz] \\
        [--eccen-atlas /path/to/benson14_eccentricity.nii.gz]
"""

import argparse
import csv
import json
import os
from pathlib import Path
from datetime import datetime

import nibabel as nib
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.colors import LinearSegmentedColormap


# Colormap stops (from frontend/src/lib/colormaps.js and PolarAngleDisc.jsx)
POLAR_ANGLE_360_STOPS = [
    (0,   255,   0,   0),     # red
    (45,  255, 165,   0),     # orange
    (90,  255, 255,   0),     # yellow
    (135,  60, 220,  60),     # green
    (180,   0,   0, 255),     # blue
    (225,   0, 180, 200),     # cyan-ish
    (270,   0, 255, 255),     # cyan
    (315, 200, 100, 255),     # purple
    (360, 255,   0,   0),     # red (wrap)
]

WARM_ECCEN_STOPS = [
    (0,   26,   0,   0),      # #1a0000
    (20,  92,   0,   0),      # #5c0000
    (40, 179,   0,   0),      # #b30000
    (60, 255,  69,   0),      # #ff4500
    (80, 255, 165,   0),      # #ffa500
    (90, 255, 255,   0),      # #ffff00
]

OVERLAY_FILL = (58, 58, 58)
OVERLAY_OPACITY = 0.92

ECCEN_MAX_DEG = 90


def voxel_to_mm(nifti_img, voxel_coords):
    """Convert voxel indices [i,j,k] to MNI mm via NIfTI affine."""
    affine = nifti_img.affine
    voxel_homog = np.append(voxel_coords, 1)
    mm_homog = affine @ voxel_homog
    return mm_homog[:3]


def mm_to_voxel(nifti_img, mm_coords):
    """Convert MNI mm to voxel indices via inverse NIfTI affine."""
    affine_inv = np.linalg.inv(nifti_img.affine)
    mm_homog = np.append(mm_coords, 1)
    voxel_homog = affine_inv @ mm_homog
    return voxel_homog[:3]


def compute_voxel_counts(lesion_img, atlas_img):
    """
    Map lesion voxels to atlas bins and count overlap.

    Returns: dict {rounded_atlas_value: voxel_count}
    Skips atlas values < 1 (background).
    Handles affine-aware mapping when grids differ.
    """
    counts = {}

    lesion_data = lesion_img.get_fdata()
    atlas_data = atlas_img.get_fdata()

    lnx, lny, lnz = lesion_data.shape
    anx, any, anz = atlas_data.shape

    # Fast path: same grid
    if lnx == anx and lny == any and lnz == anz:
        mask = lesion_data > 0
        atlas_vals = atlas_data[mask]
        rounded = np.round(atlas_vals[atlas_vals >= 1]).astype(int)
        for val in rounded:
            counts[val] = counts.get(val, 0) + 1
        return counts

    # Affine-aware fallback
    for k in range(lnz):
        for j in range(lny):
            for i in range(lnx):
                if lesion_data[i, j, k] <= 0:
                    continue
                mm = voxel_to_mm(lesion_img, np.array([i, j, k], dtype=float))
                voxel_atlas = mm_to_voxel(atlas_img, mm)
                ai, aj, ak = np.round(voxel_atlas).astype(int)
                if 0 <= ai < anx and 0 <= aj < any and 0 <= ak < anz:
                    val = atlas_data[ai, aj, ak]
                    if val >= 1:
                        val_int = int(np.round(val))
                        counts[val_int] = counts.get(val_int, 0) + 1

    return counts


def affected_set(counts, mode="any", min_voxels=1):
    """Convert count dict to set of affected degree bins."""
    affected = set()
    if not counts:
        return affected
    if mode == "any":
        return set(k for k, n in counts.items() if n > 0)
    min_v = max(1, int(min_voxels))
    return set(k for k, n in counts.items() if n >= min_v)


def merge_ranges(affected, wrap=False, max_deg=360):
    """
    Merge affected bins into contiguous ranges.

    Returns:
        (arc_segments, display_ranges) — tuples of [start, end] inclusive
        For wrap=True, handles 0/360 boundary specially.
    """
    if not affected:
        return [], []

    sorted_bins = sorted(affected)
    segs = []
    s = sorted_bins[0]
    e = sorted_bins[0]

    for v in sorted_bins[1:]:
        if v == e + 1:
            e = v
        else:
            segs.append([s, e])
            s = e = v
    segs.append([s, e])

    if not wrap or len(segs) < 2:
        return segs, segs

    # Wrap merge: if first segment starts ≤1 and last ends ≥ max_deg-1
    first = segs[0]
    last = segs[-1]
    if first[0] <= 1 and last[1] >= max_deg - 1:
        display = segs[1:-1] + [[last[0], first[1]]]
        return segs, display

    return segs, segs


def classify_hemifield(counts, bilateral_fraction=0.2):
    """Classify lesion as affecting right (1–180), left (181–360), or bilateral."""
    if not counts:
        return "none"

    right = sum(n for k, n in counts.items() if 1 <= k <= 180)
    left = sum(n for k, n in counts.items() if 181 <= k <= 360)
    total = right + left

    if total == 0:
        return "none"

    right_frac = right / total
    left_frac = left / total

    if right_frac >= bilateral_fraction and left_frac >= bilateral_fraction:
        return "bilateral"
    return "right" if right >= left else "left"


def ranges_to_text(ranges):
    """Format ranges as text: '45°–92°, 178°–205°'."""
    if not ranges:
        return ""
    return ", ".join(
        f"{s}°" if s == e else f"{s}°–{e}°"
        for s, e in ranges
    )


def build_summary(display_ranges, hemifield, kind):
    """Build one-line summary text."""
    text = ranges_to_text(display_ranges)
    if not text:
        return "no overlap with retinotopy atlas"

    if kind == "polar":
        tail = {
            "right": " · right hemifield",
            "left": " · left hemifield",
            "bilateral": " · bilateral",
        }.get(hemifield, "")
        return f"affects {text}{tail}"

    return f"affects {text}"


def interpolate_colormap(stops, num_points=256):
    """
    Interpolate colormap stops (angle, r, g, b) into a 256-point LUT.
    stops: list of (angle, r, g, b) tuples where angle ∈ [0, 360].
    Returns: array of shape (num_points, 4) with RGBA values in [0, 1].
    """
    angles = np.array([s[0] for s in stops])
    colors = np.array([[s[1], s[2], s[3], 255] for s in stops]) / 255.0

    interp_angles = np.linspace(0, 360, num_points)
    lut = np.zeros((num_points, 4))

    for i in range(num_points):
        angle = interp_angles[i]
        # Find bounding stops
        idx_hi = np.searchsorted(angles, angle)
        if idx_hi == 0:
            lut[i] = colors[0]
        elif idx_hi == len(angles):
            lut[i] = colors[-1]
        else:
            idx_lo = idx_hi - 1
            a_lo, a_hi = angles[idx_lo], angles[idx_hi]
            c_lo, c_hi = colors[idx_lo], colors[idx_hi]
            frac = (angle - a_lo) / (a_hi - a_lo)
            lut[i] = (1 - frac) * c_lo + frac * c_hi

    return lut


def render_polar_angle_disc_png(
    lesion_name,
    polar_counts, polar_arc_segs, polar_summary, polar_hemifield,
    eccen_counts, eccen_arc_segs, eccen_summary,
    output_path
):
    """
    Render a polar-angle disc + eccentricity bar PNG matching MRLatte's
    exportPolarAngleDiscPng layout.
    """
    W, H = 480, 850
    fig = plt.figure(figsize=(W / 100, H / 100), dpi=100)
    ax = fig.add_subplot(111)
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.set_aspect('equal')
    ax.invert_yaxis()
    ax.axis('off')

    # White background
    ax.add_patch(mpatches.Rectangle((0, 0), W, H, facecolor='white', edgecolor='none'))

    # Title
    ax.text(W / 2, 20, 'Predicted Visual Field Defect',
            ha='center', va='top', fontsize=12, fontweight='bold', fontfamily='monospace')

    # ── Polar angle disc ──────────────────────────────────────
    cx, cy = W / 2, 270
    r_outer = 160
    r_inner = 16

    # Rasterize the polar-angle disc to avoid seaming artifacts from 360 individual wedges
    # Create a 2D pixel array: angle and radius per pixel, look up color from colormap LUT
    disc_res = 512  # pixels per side
    disc_half = disc_res / 2
    x_grid = np.linspace(-r_outer, r_outer, disc_res)
    y_grid = np.linspace(-r_outer, r_outer, disc_res)
    X, Y = np.meshgrid(x_grid, y_grid)

    # Convert (x, y) to (angle, radius) in image space (y increases downward)
    R = np.sqrt(X**2 + Y**2)
    Theta = np.arctan2(Y, X)  # radians, -pi..pi

    # Convert angle to degree bin (0..359), with 0° at 90° from standard (UVM = top)
    Theta_deg = (np.degrees(Theta) + 90) % 360

    # Look up color from LUT (0..359 → 0..255 indices)
    lut = interpolate_colormap(POLAR_ANGLE_360_STOPS, 360)
    color_idx = np.round(Theta_deg).astype(int) % 360
    disc_colors = lut[color_idx]  # shape (disc_res, disc_res, 4) RGBA

    # Mask: only show pixels in the annulus [r_inner, r_outer], rest transparent
    mask = (R >= r_inner) & (R <= r_outer)
    disc_colors[~mask, 3] = 0  # alpha = 0 outside annulus

    # Draw as a single image (no visible seams)
    ax.imshow(disc_colors, extent=[cx - r_outer, cx + r_outer, cy + r_outer, cy - r_outer],
              origin='upper', aspect='auto', interpolation='bilinear', zorder=1)

    # Overlay dark wedges on affected bins (draw exactly one wedge per merged segment, not per degree)
    for s, e in polar_arc_segs:
        wedge = mpatches.Wedge((cx, cy), r_outer, s - 90, e + 1 - 90,
                               width=r_outer - r_inner,
                               facecolor=(*[c / 255 for c in OVERLAY_FILL], OVERLAY_OPACITY),
                               edgecolor='none', linewidth=0, zorder=2)
        ax.add_patch(wedge)

    # White centre circle
    centre = mpatches.Circle((cx, cy), r_inner, facecolor='white', edgecolor='none')
    ax.add_patch(centre)

    # Tick labels (UVM, RHM, LVM, LHM)
    ticks = [
        (0, "UVM", "0°"),
        (90, "RHM", "90°"),
        (180, "LVM", "180°"),
        (270, "LHM", "270°"),
    ]
    for angle, label, deg_text in ticks:
        rad = np.radians(angle - 90)
        lx = cx + np.cos(rad) * (r_outer + 26)
        ly = cy + np.sin(rad) * (r_outer + 26)
        ax.text(lx, ly, label, ha='center', va='center', fontsize=10, fontweight='bold', fontfamily='monospace', color='#111111')
        ax.text(lx, ly + 8, deg_text, ha='center', va='top', fontsize=8, fontfamily='monospace', color='#555555')

    # Polar angle footer
    fy = cy + r_outer + 44
    ax.text(cx, fy, 'LH cortex · right hemifield (0–180°)', ha='center', va='top', fontsize=8, fontfamily='monospace', color='#444444')
    fy += 18
    ax.text(cx, fy, 'RH cortex · left hemifield (180–360°)', ha='center', va='top', fontsize=8, fontfamily='monospace', color='#444444')
    fy += 22

    # Polar summary text
    if polar_summary:
        ax.text(cx, fy, polar_summary, ha='center', va='top', fontsize=7, fontfamily='monospace', color='#555555', wrap=True)
        fy += 16

    # ── Divider ──────────────────────────────────────────────
    fy += 10
    ax.plot([40, W - 40], [fy, fy], color='#dddddd', linewidth=0.5)
    fy += 14

    # ── Eccentricity section ──────────────────────────────────
    ax.text(40, fy, f'Eccentricity · warm', ha='left', va='top', fontsize=8, fontfamily='monospace', color='#444444')
    fy += 18

    # Horizontal eccentricity bar with gradient
    bar_x, bar_w, bar_h = 40, W - 80, 18

    # Rasterize eccentricity gradient bar to avoid seaming artifacts
    bar_res = 512
    bar_lut = interpolate_colormap(WARM_ECCEN_STOPS, 90)
    deg_per_pixel = ECCEN_MAX_DEG / bar_res
    deg_indices = np.arange(bar_res) * deg_per_pixel
    color_idx = np.round(deg_indices).astype(int) % 90
    bar_colors = bar_lut[color_idx]  # shape (512, 4) RGBA
    bar_colors_2d = np.tile(bar_colors[:, np.newaxis, :], (1, 20, 1))  # stretch vertically

    ax.imshow(bar_colors_2d, extent=[bar_x, bar_x + bar_w, fy + bar_h, fy],
              origin='upper', aspect='auto', interpolation='bilinear', zorder=1)

    # Overlay dark segments on affected eccentricity bins (one rectangle per merged segment)
    for s, e in eccen_arc_segs:
        seg_x = bar_x + (s / ECCEN_MAX_DEG) * bar_w
        seg_w = ((e + 1) / ECCEN_MAX_DEG) * bar_w - (s / ECCEN_MAX_DEG) * bar_w
        ax.add_patch(mpatches.Rectangle((seg_x, fy), seg_w, bar_h,
                                       facecolor=(*[c / 255 for c in OVERLAY_FILL], OVERLAY_OPACITY),
                                       edgecolor='none', zorder=2))

    fy += bar_h + 6

    # Eccentricity tick labels
    eccen_ticks = [
        (0, '0°'),
        (20, '20°'),
        (40, '40°'),
        (60, '60°+'),
    ]
    for deg, label in eccen_ticks:
        tx = bar_x + (deg / ECCEN_MAX_DEG) * bar_w
        ax.text(tx, fy, label, ha='center' if deg not in [0, 60] else ('left' if deg == 0 else 'right'),
                va='top', fontsize=7, fontfamily='monospace', color='#666666')
    fy += 16

    # Eccentricity summary text
    if eccen_summary:
        ax.text(cx, fy, eccen_summary, ha='center', va='top', fontsize=7, fontfamily='monospace', color='#555555')
        fy += 16

    # ── Timestamp footer ──────────────────────────────────────
    fy += 4
    timestamp = datetime.now().strftime('%m/%d/%Y, %I:%M:%S %p')
    ax.text(cx, fy, f'MRLatte · {timestamp}', ha='center', va='top', fontsize=7, fontfamily='monospace', color='#888888')

    # Save
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(str(output_path), bbox_inches='tight', pad_inches=0, dpi=100, facecolor='white')
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lesions-dir', required=True, help='Directory containing lesion NIfTI files')
    parser.add_argument('--output-dir', default='./output', help='Output directory')
    parser.add_argument('--polar-atlas', help='Path to polar angle atlas (default: data/modules/atlases/benson14/benson14_polar_angle.nii.gz)')
    parser.add_argument('--eccen-atlas', help='Path to eccentricity atlas (default: data/modules/atlases/benson14/benson14_eccentricity.nii.gz)')

    args = parser.parse_args()

    lesions_dir = Path(args.lesions_dir)
    output_dir = Path(args.output_dir)

    # Resolve atlas paths
    if args.polar_atlas:
        polar_atlas_path = Path(args.polar_atlas)
    else:
        polar_atlas_path = Path(__file__).parent.parent.parent / 'data' / 'modules' / 'atlases' / 'benson14' / 'benson14_polar_angle.nii.gz'

    if args.eccen_atlas:
        eccen_atlas_path = Path(args.eccen_atlas)
    else:
        eccen_atlas_path = Path(__file__).parent.parent.parent / 'data' / 'modules' / 'atlases' / 'benson14' / 'benson14_eccentricity.nii.gz'

    # Load atlases
    print(f"Loading polar atlas: {polar_atlas_path}")
    polar_atlas = nib.load(str(polar_atlas_path))
    print(f"Loading eccentricity atlas: {eccen_atlas_path}")
    eccen_atlas = nib.load(str(eccen_atlas_path))

    # Process lesions
    lesion_files = sorted(lesions_dir.glob('*.nii.gz')) + sorted(lesions_dir.glob('*.nii'))
    if not lesion_files:
        print(f"No lesion files found in {lesions_dir}")
        return

    print(f"Found {len(lesion_files)} lesion files")

    # Store per-lesion overlap data for aggregate heatmap
    lesion_names = []
    polar_matrices = []  # list of dicts {bin: count}
    eccen_matrices = []  # list of dicts {bin: count}

    for lesion_file in lesion_files:
        lesion_name = lesion_file.stem
        print(f"\nProcessing: {lesion_name}")

        lesion_nib = nib.load(str(lesion_file))

        # Compute overlaps
        polar_counts = compute_voxel_counts(lesion_nib, polar_atlas)
        eccen_counts = compute_voxel_counts(lesion_nib, eccen_atlas)

        # Polar analysis
        polar_affected = affected_set(polar_counts)
        polar_arc_segs, polar_display_ranges = merge_ranges(polar_affected, wrap=True, max_deg=360)
        polar_hemifield = classify_hemifield(polar_counts)
        polar_summary = build_summary(polar_display_ranges, polar_hemifield, "polar")

        # Eccentricity analysis
        eccen_affected = affected_set(eccen_counts)
        eccen_arc_segs, eccen_display_ranges = merge_ranges(eccen_affected, wrap=False, max_deg=90)
        eccen_summary = build_summary(eccen_display_ranges, "none", "eccen")

        print(f"  Polar: {polar_summary}")
        print(f"  Eccen: {eccen_summary}")

        # Render PNG
        output_subdir = output_dir / lesion_name
        export_path = output_subdir / "export.png"
        render_polar_angle_disc_png(
            lesion_name,
            polar_counts, polar_arc_segs, polar_summary, polar_hemifield,
            eccen_counts, eccen_arc_segs, eccen_summary,
            export_path
        )
        print(f"  -> {export_path}")

        # Per-lesion data log (raw counts + derived summaries) for rebuilding
        # any kind of heatmap later without re-reading the NIfTI volumes.
        lesion_voxels = int((lesion_nib.get_fdata() > 0).sum())
        overlap_record = {
            "lesion": lesion_name,
            "lesion_voxels": lesion_voxels,
            "polar": {
                "counts": {str(k): int(v) for k, v in sorted(polar_counts.items())},
                "summary": polar_summary,
                "hemifield": polar_hemifield,
                "arc_segments": polar_arc_segs,
                "display_ranges": polar_display_ranges,
            },
            "eccen": {
                "counts": {str(k): int(v) for k, v in sorted(eccen_counts.items())},
                "summary": eccen_summary,
                "arc_segments": eccen_arc_segs,
                "display_ranges": eccen_display_ranges,
            },
        }
        output_subdir.mkdir(parents=True, exist_ok=True)
        with open(output_subdir / "overlap.json", "w") as jf:
            json.dump(overlap_record, jf, indent=2)

        # Store for aggregate heatmap
        lesion_names.append(lesion_name)
        polar_matrices.append(polar_counts)
        eccen_matrices.append(eccen_counts)

    # ── Aggregate heatmaps ────────────────────────────────────────
    print("\n" + "=" * 60)
    print("Generating aggregate heatmaps...")

    # Build 2D arrays
    n_lesions = len(lesion_names)
    polar_matrix = np.zeros((n_lesions, 360))
    eccen_matrix = np.zeros((n_lesions, 90))

    for i, (polar_counts, eccen_counts) in enumerate(zip(polar_matrices, eccen_matrices)):
        for bin_val, count in polar_counts.items():
            if 1 <= bin_val <= 360:
                polar_matrix[i, bin_val - 1] = count
        for bin_val, count in eccen_counts.items():
            if 0 <= bin_val <= 89:
                eccen_matrix[i, bin_val] = count

    # ── Data logging: CSVs for rebuilding any heatmap later ────────
    # Long format: one row per (lesion, atlas, bin) — flexible source for
    # per-lesion, aggregate, normalized, thresholded, or joint heatmaps.
    long_csv = output_dir / "overlap_data.csv"
    with open(long_csv, "w", newline="") as cf:
        w = csv.writer(cf)
        w.writerow(["lesion", "atlas", "bin_degree", "voxel_count"])
        for name, pc, ec in zip(lesion_names, polar_matrices, eccen_matrices):
            for b in sorted(pc):
                w.writerow([name, "polar", b, pc[b]])
            for b in sorted(ec):
                w.writerow([name, "eccen", b, ec[b]])
    print(f"  -> {long_csv}")

    # Wide matrices: rows = lesion, cols = degree bin (mirror the PNG heatmaps).
    polar_matrix_csv = output_dir / "heatmap_polar_matrix.csv"
    with open(polar_matrix_csv, "w", newline="") as cf:
        w = csv.writer(cf)
        w.writerow(["lesion"] + [str(d) for d in range(1, 361)])
        for name, row in zip(lesion_names, polar_matrix):
            w.writerow([name] + [int(x) for x in row])
    print(f"  -> {polar_matrix_csv}")

    eccen_matrix_csv = output_dir / "heatmap_eccen_matrix.csv"
    with open(eccen_matrix_csv, "w", newline="") as cf:
        w = csv.writer(cf)
        w.writerow(["lesion"] + [str(d) for d in range(0, 90)])
        for name, row in zip(lesion_names, eccen_matrix):
            w.writerow([name] + [int(x) for x in row])
    print(f"  -> {eccen_matrix_csv}")

    # Plot polar heatmap
    fig, ax = plt.subplots(figsize=(14, max(4, n_lesions * 0.3)))
    im = ax.imshow(polar_matrix, aspect='auto', cmap='hot', interpolation='nearest')
    ax.set_xlabel('Polar angle (degrees)', fontsize=10)
    ax.set_ylabel('Lesion', fontsize=10)
    ax.set_yticks(range(n_lesions))
    ax.set_yticklabels(lesion_names, fontsize=8)
    ax.set_xticks(np.linspace(0, 359, 9))
    ax.set_xticklabels([f'{int(x)}°' for x in np.linspace(0, 360, 9)])
    plt.colorbar(im, ax=ax, label='Voxel count')
    fig.suptitle('Aggregate Lesion Overlap: Polar Angle', fontsize=12, fontweight='bold')
    plt.tight_layout()
    heatmap_polar_path = output_dir / 'heatmap_polar.png'
    fig.savefig(str(heatmap_polar_path), dpi=100, bbox_inches='tight')
    plt.close(fig)
    print(f"  -> {heatmap_polar_path}")

    # Plot eccentricity heatmap
    fig, ax = plt.subplots(figsize=(10, max(4, n_lesions * 0.3)))
    im = ax.imshow(eccen_matrix, aspect='auto', cmap='hot', interpolation='nearest')
    ax.set_xlabel('Eccentricity (degrees)', fontsize=10)
    ax.set_ylabel('Lesion', fontsize=10)
    ax.set_yticks(range(n_lesions))
    ax.set_yticklabels(lesion_names, fontsize=8)
    ax.set_xticks(np.linspace(0, 89, 10))
    ax.set_xticklabels([f'{int(x)}°' for x in np.linspace(0, 90, 10)])
    plt.colorbar(im, ax=ax, label='Voxel count')
    fig.suptitle('Aggregate Lesion Overlap: Eccentricity', fontsize=12, fontweight='bold')
    plt.tight_layout()
    heatmap_eccen_path = output_dir / 'heatmap_eccentricity.png'
    fig.savefig(str(heatmap_eccen_path), dpi=100, bbox_inches='tight')
    plt.close(fig)
    print(f"  -> {heatmap_eccen_path}")

    print("\n" + "=" * 60)
    print(f"Done. Outputs saved to {output_dir}")


if __name__ == '__main__':
    main()
