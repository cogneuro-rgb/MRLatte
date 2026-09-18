#!/usr/bin/env python3
"""
Batch visual field deficit reporter — pure Python, no browser required.

For each lesion NIfTI in --lesions-dir, produces:
  <output>/<lesion>/vf_plot.png      — 2-D polar VF deficit plot
  <output>/<lesion>/mni_overlay.png  — lesion on MNI brain (requires nilearn)
  <output>/<lesion>/report.html      — standalone HTML clinical report
  <output>/<lesion>/overlap.json     — raw overlap data

Plus aggregate CSVs across all lesions:
  <output>/summary.csv
  <output>/overlap_data.csv
  <output>/heatmap_polar_matrix.csv
  <output>/heatmap_eccen_matrix.csv

All atlas files are read from --atlases-dir (default: data/modules/atlases/).
Everything is already present in the repo — no downloads needed.

Usage:
    python tools/scripts/batch_lesion_full_report.py \\
        --lesions-dir Lesion_Resliced_MNI_108_patients \\
        --output-dir  output_full

    # Override defaults:
        [--atlases-dir data/modules/atlases]
        [--max-ecc 30]
        [--bin-angle 5]
        [--bin-ecc 1]

Dependencies:
    pip install nibabel numpy matplotlib
    pip install nilearn          # optional — enables MNI overlay
"""

import argparse
import base64
import csv
import io
import json
import os
import sys
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np
import nibabel as nib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.patheffects as pe

warnings.filterwarnings("ignore")

try:
    from nilearn.image import resample_to_img as _nilearn_resample
    from nilearn.plotting import plot_roi as _nilearn_plot_roi
    _HAVE_NILEARN = True
except ImportError:
    _HAVE_NILEARN = False

# ─── colormap ────────────────────────────────────────────────────────────────

_PA_CMAP = matplotlib.colormaps.get_cmap("hsv")


# ─── NIfTI helpers ───────────────────────────────────────────────────────────

def load_nifti(path):
    img = nib.load(str(path))
    data = np.squeeze(img.get_fdata())
    return data, img.affine, img


def resample_lesion(lesion_img, template_img):
    """Resample lesion to template grid (nearest-neighbour)."""
    if (lesion_img.shape[:3] == template_img.shape[:3] and
            np.allclose(lesion_img.affine, template_img.affine, atol=1e-3)):
        return np.squeeze(lesion_img.get_fdata())
    if _HAVE_NILEARN:
        r = _nilearn_resample(lesion_img, template_img,
                              interpolation="nearest", force_resample=True)
        return np.squeeze(r.get_fdata())
    from scipy.ndimage import affine_transform
    vox2vox = np.linalg.inv(lesion_img.affine) @ template_img.affine
    mat, off = vox2vox[:3, :3], vox2vox[:3, 3]
    return affine_transform(np.squeeze(lesion_img.get_fdata()),
                            mat, offset=off,
                            output_shape=template_img.shape[:3],
                            order=0, mode="constant", cval=0)


def resample_to_template(img, template_img):
    """Generic resample (for extra atlases onto PA grid)."""
    if (img.shape[:3] == template_img.shape[:3] and
            np.allclose(img.affine, template_img.affine, atol=1e-3)):
        return np.squeeze(img.get_fdata())
    if _HAVE_NILEARN:
        r = _nilearn_resample(img, template_img,
                              interpolation="nearest", force_resample=True)
        return np.squeeze(r.get_fdata())
    from scipy.ndimage import affine_transform
    vox2vox = np.linalg.inv(img.affine) @ template_img.affine
    mat, off = vox2vox[:3, :3], vox2vox[:3, 3]
    return affine_transform(np.squeeze(img.get_fdata()),
                            mat, offset=off,
                            output_shape=template_img.shape[:3],
                            order=0, mode="constant", cval=0)


# ─── Overlap extraction ───────────────────────────────────────────────────────

def extract_overlap(les_data, pa_data, ecc_data, pa_affine, max_ecc=None):
    """
    Returns (vf_angles, ecc_vals, n_overlap, (xi,yi,zi)) or
            (None, None, n_overlap, None) if below threshold.

    VF angle: the atlas (after postprocess_atlases.py) already encodes the full
    0–360° visual field directly:
      LH cortex (right VF) → 1–180°   (1°=UVM, 90°=RHM, 180°=LVM)
      RH cortex (left VF)  → 180–360° (180°=LVM, 270°=LHM, 360°=UVM)
    No hemisphere-based flip is needed.
    """
    mask = (les_data > 0) & (pa_data > 0) & (ecc_data > 0)
    if max_ecc is not None:
        mask = mask & (ecc_data <= max_ecc)
    n_ov = int(mask.sum())
    if n_ov == 0:
        return None, None, 0, None

    xi, yi, zi = np.where(mask)
    pa_vals  = pa_data[xi, yi, zi]
    ecc_vals = ecc_data[xi, yi, zi]
    vf_angles = pa_vals
    return vf_angles, ecc_vals, n_ov, (xi, yi, zi)


def build_deficit_grid(vf_angles, ecc_vals, max_ecc, bin_angle, bin_ecc):
    ang_edges = np.arange(0, 360 + bin_angle, bin_angle)
    ecc_edges = np.arange(0, max_ecc + bin_ecc, bin_ecc)
    if vf_angles is None:
        return ang_edges, ecc_edges, np.zeros((len(ang_edges)-1, len(ecc_edges)-1))
    in_range = ecc_vals <= max_ecc
    grid, _, _ = np.histogram2d(vf_angles[in_range], ecc_vals[in_range],
                                bins=[ang_edges, ecc_edges])
    return ang_edges, ecc_edges, grid


def atlas_counts_for_mask(atlas_data, idx, labels):
    """Count lesion-overlap voxels per atlas region label."""
    if atlas_data is None or idx is None:
        return {}
    xi, yi, zi = idx
    vals = atlas_data[xi, yi, zi].astype(int)
    unique, counts = np.unique(vals, return_counts=True)
    out = {}
    for v, c in zip(unique, counts):
        if v == 0:
            continue
        name = labels.get(str(v), f"Region-{v}")
        out[name] = int(c)
    return out


def load_labels(json_path):
    if not os.path.exists(str(json_path)):
        return {}
    with open(json_path, "r") as f:
        data = json.load(f)
    if isinstance(data, dict):
        return {str(k): v for k, v in data.items()}
    if isinstance(data, list):
        out = {}
        for item in data:
            idx = item.get("index")
            name = item.get("name", f"Region-{idx}")
            if idx is not None:
                out[str(idx)] = name
        return out
    return {}


# ─── Plotting ─────────────────────────────────────────────────────────────────

def _draw_pa_background(ax, max_ecc, bin_angle=2, alpha=0.6):
    angles = np.arange(0, 360, bin_angle)
    width  = np.radians(bin_angle)
    for a in angles:
        ax.bar(np.radians(a), max_ecc, width=width, bottom=0,
               color=_PA_CMAP(a / 360.0), alpha=alpha, linewidth=0)


def _draw_ecc_rings(ax, max_ecc, color="white", label_angle_rad=np.radians(30)):
    step = 5 if max_ecc >= 10 else 2
    for e in np.arange(step, max_ecc + 0.1, step):
        ax.plot(np.linspace(0, 2 * np.pi, 361), [e] * 361,
                color=color, linewidth=0.7, alpha=0.55, zorder=2)
        txt = ax.text(label_angle_rad, e - 0.4, f"{e:.0f}°",
                      color=color, fontsize=9, ha="center", va="top",
                      fontweight="normal", zorder=5)
        txt.set_path_effects([pe.withStroke(linewidth=2, foreground="black")])


def _hemi_labels(ax, max_ecc, radius_factor=1.35):
    r = max_ecc * radius_factor
    ax.text(np.radians(90),  r, "RIGHT VF", ha="center", fontsize=10,
            color="#ff7733", fontweight="bold", transform=ax.transData, zorder=5)
    ax.text(np.radians(270), r, "LEFT VF",  ha="center", fontsize=10,
            color="#5599ff", fontweight="bold", transform=ax.transData, zorder=5)


def _draw_circular_colormap(fig, center_x, center_y, radius, n_seg=360):
    size = radius * 2
    cmap_ax = fig.add_axes([center_x - radius, center_y - radius, size, size],
                           projection="polar")
    cmap_ax.set_theta_zero_location("N")
    cmap_ax.set_theta_direction(-1)
    angles = np.linspace(0, 360, n_seg, endpoint=False)
    width  = np.radians(360 / n_seg)
    for a in angles:
        cmap_ax.bar(np.radians(a), 1.0, width=width, bottom=0,
                    color=_PA_CMAP(a / 360.0), linewidth=0, alpha=0.95)
    cmap_ax.set_ylim(0, 1.0)
    cmap_ax.set_yticks([])
    cmap_ax.set_xticks([])
    cmap_ax.spines["polar"].set_visible(False)
    cmap_ax.set_facecolor("white")
    label_r   = 1.38
    for deg, txt, ha, va in [(0, "0\nUVM", "center", "bottom"),
                              (90, "90\nRHM", "left", "center"),
                              (180, "180\nLVM", "center", "top"),
                              (270, "270\nLHM", "right", "center")]:
        cmap_ax.text(np.radians(deg), label_r, txt, fontsize=6,
                     ha=ha, va=va, color="#333333", fontweight="bold")
    cmap_ax.set_title("Polar\nangle", fontsize=7, pad=2,
                      color="#333333", fontweight="bold")


def render_vf_plot(vf_angles, ecc_vals, n_overlap, lesion_name,
                   max_ecc=30, bin_angle=5, bin_ecc=1):
    """Render the 2-D polar VF deficit plot and return PNG bytes."""
    ang_edges, ecc_edges, grid = build_deficit_grid(
        vf_angles, ecc_vals, max_ecc, bin_angle, bin_ecc)
    n_within = int(grid.sum())

    fig = plt.figure(figsize=(12, 9), facecolor="white")
    ax  = fig.add_axes([0.12, 0.15, 0.76, 0.70], projection="polar")

    _draw_pa_background(ax, max_ecc, bin_angle=2, alpha=0.60)
    _draw_ecc_rings(ax, max_ecc, color="white", label_angle_rad=np.radians(30))

    ax.set_theta_zero_location("N")
    ax.set_theta_direction(-1)
    ax.set_ylim(0, max_ecc)
    ax.set_yticks([])

    tick_deg = [0, 45, 90, 135, 180, 225, 270, 315]
    tick_lbl = ["0°\nUpper VM", "45°", "90°\nRight HM", "135°",
                "180°\nLower VM", "225°", "270°\nLeft HM", "315°"]
    ax.set_xticks(np.radians(tick_deg))
    ax.set_xticklabels(tick_lbl, fontsize=10, color="#222222", fontweight="bold")
    ax.tick_params(pad=16)
    ax.grid(color="#888888", linewidth=0.4, alpha=0.4)
    ax.set_facecolor("white")
    ax.spines["polar"].set_edgecolor("#cccccc")

    _hemi_labels(ax, max_ecc, radius_factor=1.35)

    if vf_angles is not None:
        ang_w = np.radians(bin_angle)
        for ai in range(len(ang_edges) - 1):
            for ei in range(len(ecc_edges) - 1):
                if grid[ai, ei] > 0:
                    ax.bar(np.radians(ang_edges[ai]),
                           ecc_edges[ei + 1] - ecc_edges[ei],
                           width=ang_w, bottom=ecc_edges[ei],
                           color="black", alpha=0.88, linewidth=0, zorder=4)

    _draw_circular_colormap(fig, center_x=0.10, center_y=0.06, radius=0.10)

    short = lesion_name if len(lesion_name) < 55 else lesion_name[:52] + "…"
    ax.set_title(
        f"Predicted Visual Field Deficit\n{short}\n"
        f"Total overlap: {n_overlap} vx  |  within {max_ecc}° ecc: {n_within} vx",
        fontsize=11, pad=28, color="black")

    fig.legend(handles=[mpatches.Patch(color="black", label="Predicted VF deficit")],
               loc="lower right", bbox_to_anchor=(0.92, 0.08), fontsize=9, framealpha=0.8)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


# ─── MNI overlay ─────────────────────────────────────────────────────────────

def render_mni_overlay(lesion_img, mni_img):
    """Return PNG bytes for the MNI overlay, or None if unavailable."""
    if not _HAVE_NILEARN or mni_img is None:
        return None
    try:
        from nilearn.plotting import plot_roi
        data = np.squeeze(lesion_img.get_fdata())
        if data.sum() == 0:
            return None
        idx = np.where(data > 0)
        com_vox = np.array([np.mean(idx[0]), np.mean(idx[1]), np.mean(idx[2])])
        com_mm  = nib.affines.apply_affine(lesion_img.affine, com_vox)
        display = plot_roi(lesion_img, mni_img,
                           display_mode="ortho", title="Lesion localisation",
                           cut_coords=tuple(com_mm), draw_cross=False,
                           colorbar=True, cmap="autumn")
        fig = plt.gcf()
        fig.set_size_inches(10, 7.5)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=100, bbox_inches="tight")
        plt.close(fig)
        buf.seek(0)
        return buf.read()
    except Exception as e:
        print(f"    MNI overlay failed: {e}")
        return None


# ─── HTML report ─────────────────────────────────────────────────────────────

def _b64(png_bytes):
    return base64.b64encode(png_bytes).decode("utf-8") if png_bytes else None


def _atlas_table_html(counts, title):
    total = sum(counts.values()) if counts else 0
    rows = ""
    for name, cnt in sorted(counts.items(), key=lambda x: -x[1]):
        pct = cnt / total * 100 if total else 0
        rows += f"<tr><td>{name}</td><td class='num'>{cnt}</td><td class='num'>{pct:.1f}%</td></tr>"
    if not rows:
        rows = "<tr><td colspan='3' style='text-align:center;color:#94a3b8;'>No data</td></tr>"
    return f"""
    <div class="section-title">{title}</div>
    <table class="atlas-table">
      <thead><tr><th>Area</th><th class='num'>Voxels</th><th class='num'>%</th></tr></thead>
      <tbody>{rows}</tbody>
    </table>"""


def generate_html_report(lesion_name, n_overlap, n_within, max_ecc,
                         bin_angle, bin_ecc,
                         vf_png, mni_png,
                         visf_counts, harv_counts, wang_counts,
                         vf_mean=None, ecc_mean=None):
    now = datetime.now().strftime("%Y-%m-%d  %H:%M")

    def img_tag(png_bytes, alt):
        if not png_bytes:
            return f"<div class='no-img'>{alt} not available</div>"
        b64 = _b64(png_bytes)
        return f"<img src='data:image/png;base64,{b64}' alt='{alt}'>"

    stats_cards = f"""
    <div class="stat-grid">
      <div class="stat-card" style="--accent:#2563eb">
        <div class="stat-label">Total overlap</div>
        <div class="stat-value">{n_overlap}</div>
        <div class="stat-sub">voxels with retinotopy atlas</div>
      </div>
      <div class="stat-card" style="--accent:#7c3aed">
        <div class="stat-label">Within {max_ecc}° ecc.</div>
        <div class="stat-value">{n_within}</div>
        <div class="stat-sub">voxels in deficit zone</div>
      </div>
      <div class="stat-card" style="--accent:#059669">
        <div class="stat-label">VF angle (mean)</div>
        <div class="stat-value">{f'{vf_mean:.1f}°' if vf_mean is not None else '—'}</div>
        <div class="stat-sub">eccentricity {f'{ecc_mean:.1f}°' if ecc_mean is not None else '—'} mean</div>
      </div>
    </div>"""

    atlas_tables = (
        _atlas_table_html(visf_counts, "Visual Field Areas (visfAtlas)") +
        _atlas_table_html(harv_counts, "Cortical Areas (Harvard‑Oxford)") +
        _atlas_table_html(wang_counts, "Probabilistic ROIs (Wang 2015)")
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>VF Report — {lesion_name}</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
            background: #eef2f7; color: #1a2035; min-height: 100vh; padding: 32px 20px 48px; }}
    .page {{ max-width: 1180px; margin: 0 auto; }}
    .banner {{ background: linear-gradient(120deg,#0f172a 0%,#1e3a5f 55%,#1e4d8c 100%);
               color: white; border-radius: 16px 16px 0 0;
               padding: 28px 36px 22px; display: flex;
               justify-content: space-between; align-items: flex-start; gap: 16px; }}
    .banner h1 {{ font-size: 22px; font-weight: 700; letter-spacing: -0.3px; line-height: 1.2; }}
    .banner .subject {{ font-size: 13.5px; color: #94b8e0; margin-top: 6px; word-break: break-all; }}
    .banner .meta {{ text-align: right; font-size: 12.5px; color: #7aa3cc; white-space: nowrap; }}
    .banner .badge {{ display: inline-block; background: rgba(255,255,255,.12);
                      border: 1px solid rgba(255,255,255,.22); border-radius: 20px;
                      padding: 3px 12px; font-size: 11.5px; margin-top: 6px; }}
    .body-card {{ background: white; border-radius: 0 0 16px 16px;
                  padding: 28px 36px 36px; box-shadow: 0 6px 24px rgba(0,0,0,.08); }}
    .section-title {{ font-size: 11px; font-weight: 700; text-transform: uppercase;
                      letter-spacing: 1px; color: #64748b;
                      margin: 28px 0 12px; padding-bottom: 6px;
                      border-bottom: 1px solid #e8edf5; }}
    .section-title:first-child {{ margin-top: 0; }}
    .stat-grid {{ display: grid; grid-template-columns: repeat(3,1fr); gap: 14px; }}
    .stat-card {{ border-left: 4px solid var(--accent,#2563eb); background: #f8fafc;
                  border-radius: 0 10px 10px 0; padding: 14px 16px; }}
    .stat-label {{ font-size: 11.5px; color: #64748b; font-weight: 600;
                   text-transform: uppercase; letter-spacing: .4px; }}
    .stat-value {{ font-size: 24px; font-weight: 700; color: #0f172a; margin: 4px 0 2px; line-height: 1.1; }}
    .stat-sub {{ font-size: 11px; color: #94a3b8; }}
    .param-row {{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }}
    .pill {{ background: #f1f5f9; border: 1px solid #e2e8f0;
             border-radius: 20px; padding: 4px 12px; font-size: 12px; color: #475569; }}
    .pill strong {{ color: #1e293b; }}
    .img-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 4px; }}
    .img-panel {{ border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;
                  background: #f8fafc; display: flex; flex-direction: column; }}
    .img-panel-header {{ padding: 10px 16px; background: #f1f5f9;
                         border-bottom: 1px solid #e2e8f0;
                         display: flex; align-items: center; gap: 8px; }}
    .img-panel-header .dot {{ width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }}
    .img-panel-header h3 {{ font-size: 13px; font-weight: 600; color: #334155; }}
    .img-panel-body {{ flex: 1; display: flex; align-items: center; justify-content: center;
                       padding: 12px; aspect-ratio: 4/3; }}
    .img-panel-body img {{ width: 100%; height: 100%; object-fit: contain; display: block; border-radius: 6px; }}
    .no-img {{ color: #94a3b8; font-size: 13px; text-align: center; padding: 20px; line-height: 1.8; }}
    .atlas-table {{ width: 100%; border-collapse: collapse; font-size: 13px;
                    background: #f8fafc; border-radius: 10px; overflow: hidden; margin-top: 6px; }}
    .atlas-table th {{ background: #1e293b; color: white; padding: 8px 12px;
                       text-align: left; font-weight: 600; font-size: 12px; }}
    .atlas-table td {{ padding: 6px 12px; border-bottom: 1px solid #e2e8f0; }}
    .atlas-table tr:last-child td {{ border-bottom: none; }}
    .atlas-table td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
    .footer {{ margin-top: 32px; text-align: center; font-size: 12px;
               color: #94a3b8; line-height: 1.8; }}
    @media print {{ body {{ background: white; padding: 0; }}
                    .page {{ max-width: 100%; }}
                    .banner {{ border-radius: 0; }}
                    .body-card {{ border-radius: 0; box-shadow: none; }} }}
  </style>
</head>
<body>
<div class="page">
  <div class="banner">
    <div>
      <h1>Visual Field Deficit Report</h1>
      <div class="subject">{lesion_name}</div>
    </div>
    <div class="meta">
      <div>Generated: {now}</div>
      <span class="badge">Retinotopic + triple atlas analysis</span>
    </div>
  </div>
  <div class="body-card">
    <div class="section-title">Key Statistics</div>
    {stats_cards}
    <div class="section-title">Analysis Parameters</div>
    <div class="param-row">
      <span class="pill"><strong>Angle bin:</strong> {bin_angle}°</span>
      <span class="pill"><strong>Ecc bin:</strong> {bin_ecc}°</span>
      <span class="pill"><strong>Max ecc:</strong> {max_ecc}°</span>
      <span class="pill"><strong>Atlas:</strong> Benson 2014</span>
    </div>
    <div class="section-title">Predicted Visual Field Deficit &amp; Lesion Localisation</div>
    <div class="img-grid">
      <div class="img-panel">
        <div class="img-panel-header">
          <div class="dot" style="background:#6366f1;"></div>
          <h3>Predicted VF Deficit (Polar Plot)</h3>
        </div>
        <div class="img-panel-body">{img_tag(vf_png, 'VF polar plot')}</div>
      </div>
      <div class="img-panel">
        <div class="img-panel-header">
          <div class="dot" style="background:#f59e0b;"></div>
          <h3>Lesion Localisation (MNI Space)</h3>
        </div>
        <div class="img-panel-body">{img_tag(mni_png, 'MNI overlay — install nilearn to enable')}</div>
      </div>
    </div>
    {atlas_tables}
    <div class="footer">
      <div>Benson 2014 retinotopy · visfAtlas · Harvard‑Oxford · Wang 2015</div>
      <div>⚠ Automated prediction — for research use; clinical interpretation requires expert review.</div>
    </div>
  </div>
</div>
</body>
</html>"""


# ─── Per-lesion processor ─────────────────────────────────────────────────────

def process_lesion(lesion_path, pa_data, pa_affine, pa_img, ecc_data,
                   visf_data, visf_labels, harv_data, harv_labels,
                   wang_data, wang_labels, mni_img,
                   output_dir, max_ecc, bin_angle, bin_ecc):
    """
    Full per-lesion pipeline. Returns a record dict for aggregate CSVs,
    or None on failure.
    """
    lesion_path = Path(lesion_path)
    name = lesion_path.name
    for ext in (".nii.gz", ".nii"):
        if name.endswith(ext):
            name = name[: -len(ext)]
            break

    out_sub = output_dir / name
    out_sub.mkdir(parents=True, exist_ok=True)

    try:
        les_img  = nib.load(str(lesion_path))
        les_data = resample_lesion(les_img, pa_img)

        vf_angles, ecc_vals, n_overlap, idx = extract_overlap(
            les_data, pa_data, ecc_data, pa_affine)

        # ── VF metrics ────────────────────────────────────────────────────────
        if vf_angles is not None:
            in_range = ecc_vals <= max_ecc
            vf_r   = vf_angles[in_range]
            ecc_r  = ecc_vals[in_range]
            n_within = int(in_range.sum())
            vf_mean  = float(np.mean(vf_r))  if len(vf_r)  > 0 else None
            ecc_mean = float(np.mean(ecc_r)) if len(ecc_r) > 0 else None
            # Simple hemifield classification
            right_v = float(np.sum(vf_r <= 180)) if len(vf_r) > 0 else 0
            left_v  = float(np.sum(vf_r >  180)) if len(vf_r) > 0 else 0
            total   = right_v + left_v
            if total == 0:
                hemifield = "none"
            elif right_v / total >= 0.8:
                hemifield = "right"
            elif left_v  / total >= 0.8:
                hemifield = "left"
            else:
                hemifield = "bilateral"
        else:
            n_within  = 0
            vf_mean   = None
            ecc_mean  = None
            hemifield = "none"
            vf_r      = np.array([])
            ecc_r     = np.array([])

        # ── Atlas overlap ──────────────────────────────────────────────────────
        visf_counts = atlas_counts_for_mask(visf_data, idx, visf_labels)
        harv_counts = atlas_counts_for_mask(harv_data, idx, harv_labels)
        wang_counts = atlas_counts_for_mask(wang_data, idx, wang_labels)

        # ── VF plot ────────────────────────────────────────────────────────────
        vf_png = render_vf_plot(
            vf_r if len(vf_r) > 0 else None,
            ecc_r if len(ecc_r) > 0 else None,
            n_overlap, name, max_ecc, bin_angle, bin_ecc)
        (out_sub / "vf_plot.png").write_bytes(vf_png)

        # ── MNI overlay ───────────────────────────────────────────────────────
        mni_png = render_mni_overlay(les_img, mni_img)
        if mni_png:
            (out_sub / "mni_overlay.png").write_bytes(mni_png)

        # ── HTML report ───────────────────────────────────────────────────────
        html = generate_html_report(
            lesion_name=name,
            n_overlap=n_overlap,
            n_within=n_within,
            max_ecc=max_ecc,
            bin_angle=bin_angle,
            bin_ecc=bin_ecc,
            vf_png=vf_png,
            mni_png=mni_png,
            visf_counts=visf_counts,
            harv_counts=harv_counts,
            wang_counts=wang_counts,
            vf_mean=vf_mean,
            ecc_mean=ecc_mean,
        )
        (out_sub / "report.html").write_text(html, encoding="utf-8")

        # ── overlap.json ──────────────────────────────────────────────────────
        record = {
            "lesion": name,
            "n_overlap": n_overlap,
            "n_within_ecc": n_within,
            "hemifield": hemifield,
            "vf_mean": round(vf_mean, 2) if vf_mean is not None else None,
            "ecc_mean": round(ecc_mean, 2) if ecc_mean is not None else None,
            "atlas": {
                "visfAtlas": visf_counts,
                "harvard_oxford": harv_counts,
                "wang2015": wang_counts,
            },
            # angle-bin presence for heatmap matrix
            "_polar_bins": {},
            "_ecc_bins": {},
        }
        if vf_angles is not None:
            ang_edges = np.arange(0, 360 + bin_angle, bin_angle)
            ecc_edges = np.arange(0, max_ecc + bin_ecc, bin_ecc)
            grid, _, _ = np.histogram2d(
                vf_r if len(vf_r) > 0 else np.array([]),
                ecc_r if len(ecc_r) > 0 else np.array([]),
                bins=[ang_edges, ecc_edges])
            for ai, a in enumerate(ang_edges[:-1]):
                if grid[ai].sum() > 0:
                    record["_polar_bins"][str(int(a))] = int(grid[ai].sum())
            ecc_hist, _ = np.histogram(ecc_r, bins=ecc_edges)
            for ei, e in enumerate(ecc_edges[:-1]):
                if ecc_hist[ei] > 0:
                    record["_ecc_bins"][str(int(e))] = int(ecc_hist[ei])

        with open(out_sub / "overlap.json", "w") as f:
            json.dump(record, f, indent=2)

        return record

    except Exception as e:
        print(f"    ERROR: {e}")
        import traceback; traceback.print_exc()
        return None


# ─── Aggregate CSVs ───────────────────────────────────────────────────────────

def write_aggregate_csvs(records, output_dir, bin_angle=5, max_ecc=30, bin_ecc=1):
    ang_bins = [int(a) for a in np.arange(0, 360, bin_angle)]
    ecc_bins = [int(e) for e in np.arange(0, max_ecc, bin_ecc)]

    # summary.csv
    with open(output_dir / "summary.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["lesion", "n_overlap", "n_within_ecc", "hemifield",
                    "vf_mean", "ecc_mean",
                    "n_visf_regions", "n_harv_regions", "n_wang_regions"])
        for r in records:
            w.writerow([
                r["lesion"], r["n_overlap"], r["n_within_ecc"], r["hemifield"],
                r["vf_mean"], r["ecc_mean"],
                len(r["atlas"]["visfAtlas"]),
                len(r["atlas"]["harvard_oxford"]),
                len(r["atlas"]["wang2015"]),
            ])
    print(f"  -> {output_dir / 'summary.csv'}")

    # overlap_data.csv (long format — all three atlases)
    with open(output_dir / "overlap_data.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["lesion", "atlas", "region", "voxel_count"])
        for r in records:
            for atlas_name, counts in r["atlas"].items():
                for region, cnt in counts.items():
                    w.writerow([r["lesion"], atlas_name, region, cnt])
    print(f"  -> {output_dir / 'overlap_data.csv'}")

    # heatmap_polar_matrix.csv
    with open(output_dir / "heatmap_polar_matrix.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["lesion"] + [str(b) for b in ang_bins])
        for r in records:
            pb = r.get("_polar_bins", {})
            w.writerow([r["lesion"]] + [pb.get(str(b), 0) for b in ang_bins])
    print(f"  -> {output_dir / 'heatmap_polar_matrix.csv'}")

    # heatmap_eccen_matrix.csv
    with open(output_dir / "heatmap_eccen_matrix.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["lesion"] + [str(b) for b in ecc_bins])
        for r in records:
            eb = r.get("_ecc_bins", {})
            w.writerow([r["lesion"]] + [eb.get(str(b), 0) for b in ecc_bins])
    print(f"  -> {output_dir / 'heatmap_eccen_matrix.csv'}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lesions-dir",  required=True,
                    help="Folder of lesion .nii / .nii.gz files")
    ap.add_argument("--output-dir",   default="output_full")
    ap.add_argument("--atlases-dir",  default="data/modules/atlases",
                    help="Folder containing all atlas .nii.gz files")
    ap.add_argument("--max-ecc",   type=float, default=30.0)
    ap.add_argument("--bin-angle", type=float, default=5.0)
    ap.add_argument("--bin-ecc",   type=float, default=1.0)
    args = ap.parse_args()

    lesions_dir  = Path(args.lesions_dir)
    output_dir   = Path(args.output_dir)
    atlases_dir  = Path(args.atlases_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Load atlases (once, shared across all lesions) ─────────────────────────
    print("Loading atlases …")

    pa_path  = atlases_dir / "benson14" / "benson14_polar_angle.nii.gz"
    ecc_path = atlases_dir / "benson14" / "benson14_eccentricity.nii.gz"
    for p in [pa_path, ecc_path]:
        if not p.exists():
            print(f"ERROR: required atlas not found: {p}")
            sys.exit(1)

    pa_data, pa_affine, pa_img = load_nifti(pa_path)
    ecc_data, _, _             = load_nifti(ecc_path)
    print(f"  Benson14 polar angle: shape {pa_data.shape}")

    def _load_optional_atlas(nii_name, json_name, label):
        nii_path  = atlases_dir / nii_name
        json_path = atlases_dir / json_name
        if not nii_path.exists():
            print(f"  WARNING: {label} not found ({nii_path}) — table will be empty")
            return None, {}
        img    = nib.load(str(nii_path))
        data   = resample_to_template(img, pa_img)
        labels = load_labels(json_path)
        print(f"  {label}: {len(labels)} labels")
        return data, labels

    visf_data, visf_labels = _load_optional_atlas(
        "visfatlas/visfAtlas_maxprob.nii.gz",
        "visfatlas/visfAtlas_labels.json", "visfAtlas")
    harv_data, harv_labels = _load_optional_atlas(
        "harvard_oxford/harvard_oxford_cort.nii.gz",
        "harvard_oxford/harvard_oxford_cort_labels.json", "Harvard-Oxford")
    wang_data, wang_labels = _load_optional_atlas(
        "wang2015/wang2015_maxprob.nii.gz",
        "wang2015/wang2015_labels.json", "Wang 2015")

    mni_img = None
    mni_path = atlases_dir / "mni152" / "mni152.nii.gz"
    if mni_path.exists() and _HAVE_NILEARN:
        mni_img = nib.load(str(mni_path))
        print(f"  MNI152 template: loaded (nilearn available ✓)")
    elif not _HAVE_NILEARN:
        print(f"  MNI overlay disabled (install nilearn to enable)")
    else:
        print(f"  WARNING: mni152.nii.gz not found — MNI overlay disabled")

    print()

    # ── Gather lesion files ────────────────────────────────────────────────────
    lesion_files = sorted(lesions_dir.glob("*.nii.gz")) + sorted(lesions_dir.glob("*.nii"))
    if not lesion_files:
        print(f"No lesion files found in {lesions_dir}")
        sys.exit(1)
    print(f"Found {len(lesion_files)} lesion files → {output_dir}")
    print()

    records = []
    failed  = []

    for idx, lf in enumerate(lesion_files, 1):
        name = lf.name
        for ext in (".nii.gz", ".nii"):
            if name.endswith(ext):
                name = name[: -len(ext)]; break

        print(f"[{idx:3d}/{len(lesion_files)}] {name}")

        # Resume: skip if report already exists
        done = output_dir / name / "report.html"
        if done.exists():
            jf = output_dir / name / "overlap.json"
            if jf.exists():
                with open(jf) as f:
                    records.append(json.load(f))
                print("  (already done, skipping)")
                continue

        record = process_lesion(
            lf, pa_data, pa_affine, pa_img, ecc_data,
            visf_data, visf_labels, harv_data, harv_labels,
            wang_data, wang_labels, mni_img,
            output_dir, args.max_ecc, args.bin_angle, args.bin_ecc)

        if record:
            records.append(record)
            print(f"  Hemifield: {record['hemifield']}  |  "
                  f"overlap: {record['n_overlap']} vx  |  "
                  f"within {args.max_ecc}°: {record['n_within_ecc']} vx")
            print(f"  -> {done}")
        else:
            failed.append(name)
            print("  FAILED — skipped")

    # ── Aggregate CSVs ─────────────────────────────────────────────────────────
    print()
    print("=" * 60)
    print("Writing aggregate CSVs …")
    if records:
        write_aggregate_csvs(records, output_dir,
                             bin_angle=args.bin_angle,
                             max_ecc=args.max_ecc,
                             bin_ecc=args.bin_ecc)

    print()
    print("=" * 60)
    print(f"Done.  Succeeded: {len(records)}/{len(lesion_files)}")
    if failed:
        print(f"Failed ({len(failed)}): {', '.join(failed[:5])}"
              + (" …" if len(failed) > 5 else ""))
    print(f"Outputs: {output_dir}/")


if __name__ == "__main__":
    main()
