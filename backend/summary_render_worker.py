#!/usr/bin/env python
"""Isolated worker: One-Click Summary rendering + packaging.

Given a lesion mask plus the (already-computed) tract-dissection and DA-LNM
outputs, this worker produces the visual/report artifacts and bundles the whole
thing into a single ZIP:

  * an optic-radiation / visual-pathway retinotopy check (lesion vs. named-tract
    atlas labels -- HCP1065, falling back to JHU),
  * brainsprite viewers of the lesion, the affected tracts, and the DA-LNM
    positive/negative network tails on MNI152 (nilearn view_img),
  * a self-contained report.html tying together the client-computed atlas
    overlap tables, the client-rendered 2D retinotopy disc, and the above,
  * the ZIP itself (report + brainsprite + images + maps + CSV).

Called by server.py via subprocess for crash isolation (mirrors
dissect_worker.py / lnm_worker.py -- a nilearn/matplotlib crash kills only this
process). Heavy imports are deferred and stdout is reserved for the single JSON
result line; all library chatter is routed to stderr.

Usage: python summary_render_worker.py <config_json_path>
Output: one JSON line on stdout; traceback to stderr on failure.
"""
import base64
import json
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path


# Optic-radiation / posterior-thalamic-radiation label matcher (visual pathway).
def _is_visual_pathway(name: str) -> bool:
    n = (name or "").lower()
    return ("optic radiation" in n) or ("posterior thalamic radiation" in n)


def _retinotopy_check(lesion_path, atlas_dir):
    """Voxel overlap of the lesion with visual white-matter tracts.

    Prefers HCP1065 named tracts; falls back to the JHU WM atlas. Returns a
    dict with a human finding and per-tract rows, or a 'skipped' marker when no
    suitable atlas is bundled.
    """
    import numpy as np
    import nibabel as nib
    from nilearn.image import resample_to_img

    candidates = [
        ("HCP1065_tracts.nii.gz", "HCP1065_tracts_labels.json"),
        ("jhu_wm_atlas.nii.gz", "jhu_wm_labels.json"),
    ]
    atlas_dir = Path(atlas_dir)
    atlas_nii = atlas_labels = None
    for nii_name, lab_name in candidates:
        if (atlas_dir / nii_name).exists() and (atlas_dir / lab_name).exists():
            atlas_nii, atlas_labels = atlas_dir / nii_name, atlas_dir / lab_name
            break
    if atlas_nii is None:
        return {"available": False, "intersects": False, "rows": [],
                "finding": "Visual-pathway atlas not available on the server; "
                           "retinotopy tract check skipped.",
                "atlas_name": None}

    labels = json.loads(Path(atlas_labels).read_text())
    # Two on-disk formats: a list of {"index", "name"} (current atlases) or a
    # {"int-string": name} dict. Normalise both to {int: name}.
    label_map = {}
    if isinstance(labels, list):
        for item in labels:
            if isinstance(item, dict) and "index" in item:
                try:
                    label_map[int(item["index"])] = item.get("name", "")
                except (ValueError, TypeError):
                    continue
    elif isinstance(labels, dict):
        for k, v in labels.items():
            try:
                label_map[int(k)] = v if isinstance(v, str) else (v.get("name") if isinstance(v, dict) else str(v))
            except (ValueError, TypeError):
                continue

    les_img = nib.load(str(lesion_path))
    atlas_img = nib.load(str(atlas_nii))
    # Resample the atlas onto the lesion grid (nearest -> labels stay integral).
    atlas_r = resample_to_img(atlas_img, les_img, interpolation="nearest",
                              copy_header=False, force_resample=False)
    les = np.asarray(les_img.dataobj)
    atl = np.asarray(atlas_r.dataobj).astype(int)
    les_mask = les > 0
    les_vox = int(les_mask.sum())

    rows = []
    for lab, name in label_map.items():
        if not _is_visual_pathway(name):
            continue
        region = atl == lab
        hit = int((region & les_mask).sum())
        if hit == 0:
            continue
        reg_vox = int(region.sum())
        rows.append({
            "label": lab,
            "name": name,
            "hit_voxels": hit,
            "region_voxels": reg_vox,
            "pct_region": round(100.0 * hit / reg_vox, 2) if reg_vox else 0.0,
            "pct_lesion": round(100.0 * hit / les_vox, 2) if les_vox else 0.0,
        })
    rows.sort(key=lambda r: r["hit_voxels"], reverse=True)

    if rows:
        names = ", ".join(r["name"] for r in rows)
        finding = ("Lesion intersects the visual white-matter pathway: "
                   f"{names}. A visual-field deficit is plausible; correlate "
                   "clinically with the retinotopic disc below.")
    else:
        finding = ("No occipital / visual-pathway intersection: the lesion does "
                   "not overlap the optic radiation or posterior thalamic "
                   "radiation in this atlas.")

    return {"available": True, "intersects": bool(rows), "rows": rows,
            "finding": finding, "atlas_name": Path(atlas_nii).name}


def _brainsprite_html(img_path, out_path, title="Lesion on MNI152", cmap="autumn",
                       threshold=0.5, opacity=0.8):
    """Interactive brainsprite of a NIfTI on MNI152; returns True on success."""
    try:
        import nibabel as nib
        from nilearn import plotting
        from nilearn.datasets import load_mni152_template
        try:
            bg = load_mni152_template(resolution=2)
        except TypeError:
            bg = load_mni152_template()
        view = plotting.view_img(
            nib.load(str(img_path)), bg_img=bg, threshold=threshold,
            cmap=cmap, symmetric_cmap=False, colorbar=False,
            black_bg=False, opacity=opacity, title=title,
        )
        view.save_as_html(str(out_path))
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[summary] brainsprite failed for {img_path}: {e}", file=sys.stderr)
        return False


# --------------------------------------------------------------------------- #
#  HTML report (light, print-friendly; mirrors the LNM/lesion report styling)
# --------------------------------------------------------------------------- #
_CSS = """
*{box-sizing:border-box}
body{font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;
background:#f5f7fb;color:#1a2433;line-height:1.55;font-size:15px}
.wrap{max-width:960px;margin:0 auto;padding:0 26px 56px}
header{background:linear-gradient(135deg,#16324f 0%,#2563a8 100%);color:#fff;
padding:30px 0 26px;box-shadow:0 2px 12px rgba(16,50,79,.18)}
header .wrap{padding-bottom:0}
header h1{font-size:23px;font-weight:600;margin:0 0 5px}
header .sub{opacity:.9;font-size:13.5px;margin:0;font-family:ui-monospace,Consolas,monospace}
.card{background:#fff;border:1px solid #e4e9f0;border-radius:12px;padding:20px 24px;
margin:18px 0;box-shadow:0 1px 3px rgba(16,24,40,.05)}
h2{font-size:16px;color:#16324f;margin:0 0 14px;font-weight:650;display:flex;
align-items:center;gap:8px}
h2 .tag{font-size:10.5px;font-weight:600;color:#fff;background:#0e7490;padding:2px 8px;
border-radius:20px;letter-spacing:.04em;text-transform:uppercase}
h3{font-size:12px;color:#475569;margin:16px 0 6px;font-weight:700;text-transform:uppercase;
letter-spacing:.06em}
h4{font-size:12.5px;color:#334155;margin:12px 0 4px;font-weight:650}
table{border-collapse:collapse;width:100%;font-size:13.5px;margin:4px 0 10px}
thead th{background:#16324f;color:#fff;text-align:left;padding:8px 12px;font-weight:600;
font-size:12px}
tbody td{padding:7px 12px;border-bottom:1px solid #e4e9f0}
tbody td:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
tbody tr:nth-child(even){background:#f8fafc}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;margin:4px 0}
.stat{background:#f8fafc;border:1px solid #e4e9f0;border-radius:9px;padding:11px 15px}
.stat .l{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em}
.stat .v{font-size:19px;font-weight:650;color:#16324f;margin-top:3px;font-variant-numeric:tabular-nums}
.stat .v small{font-size:12px;font-weight:500;color:#64748b}
.finding{font-size:14px;color:#334155;background:#eef4fb;border-left:3px solid #2563a8;
border-radius:0 8px 8px 0;padding:13px 18px;margin:8px 0}
.viewer{width:100%;height:560px;border:1px solid #e4e9f0;border-radius:10px;overflow:hidden;
background:#fff;margin:4px 0}
.viewer iframe{width:100%;height:100%;border:0;display:block}
img{max-width:100%;border:1px solid #e4e9f0;border-radius:8px;display:block;margin:6px 0}
figure{margin:8px 0}figcaption{font-size:12.5px;color:#64748b;margin-top:6px}
.muted{color:#64748b;font-size:13px}
footer{color:#94a3b8;font-size:12px;text-align:center;padding:26px 0 0}
"""


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _num(v):
    """Report display: floats -> 3 dp; ints / non-numeric pass through unchanged."""
    if isinstance(v, bool) or isinstance(v, int):
        return v
    if isinstance(v, float):
        return round(v, 3)
    return v


def _stat(label, value, unit=""):
    u = f" <small>{_esc(unit)}</small>" if unit else ""
    return f'<div class="stat"><div class="l">{_esc(label)}</div><div class="v">{_esc(_num(value))}{u}</div></div>'


def _atlas_table_html(breakdown):
    rows = breakdown.get("rows", []) or []
    name = breakdown.get("atlasName", "Atlas")
    if not rows:
        return f"<h3>{_esc(name)}</h3><p class='muted'>No overlap.</p>"
    body = "".join(
        f"<tr><td>{_esc(r.get('regionName',''))}</td>"
        f"<td>{r.get('voxelCount',0)}</td>"
        f"<td>{_num(r.get('percentOfLesion',0))}%</td>"
        f"<td>{_num(r.get('percentOfRegion',0))}%</td></tr>"
        for r in rows
    )
    return (f"<h3>{_esc(name)}</h3><table><thead><tr><th>Region</th><th>Voxels</th>"
            f"<th>% of lesion</th><th>% of region</th></tr></thead><tbody>{body}</tbody></table>")


def _affected_tracts_table_html(rows):
    if not rows:
        return '<p class="muted">No named tracts intersected.</p>'
    body = "".join(
        f"<tr><td>{_esc(r.get('name',''))}</td><td>{r.get('hit_voxels',0)}</td>"
        f"<td>{_num(r.get('pct_region',0))}%</td><td>{_num(r.get('streamline_density',0))}</td></tr>"
        for r in rows
    )
    return ("<table><thead><tr><th>Tract</th><th>Voxels hit</th>"
            "<th>% of tract</th><th>Streamline density</th></tr></thead>"
            f"<tbody>{body}</tbody></table>")


def _yeo_table_html(title, rows, err=None):
    if err:
        return f"<h4>{_esc(title)}</h4><p class='muted'>Yeo-7 unavailable: {_esc(err)}</p>"
    if not rows:
        return f"<h4>{_esc(title)}</h4><p class='muted'>No voxels in this tail.</p>"
    body = "".join(
        f"<tr><td>{_esc(r['name'])}</td><td>{r['voxels']}</td>"
        f"<td>{_num(r['pct'])}%</td><td>{_num(r['mean_t'])}</td></tr>"
        for r in rows)
    return (f"<h4>{_esc(title)}</h4><table><thead><tr><th>Network</th><th>Voxels</th>"
            "<th>% of tail</th><th>Mean t</th></tr></thead>"
            f"<tbody>{body}</tbody></table>")


def _build_report_html(ctx):
    cards = []

    # Key statistics
    vol = (ctx.get("overlap_model") or {}).get("volume") or {}
    stats = []
    if vol.get("cm3") is not None:
        stats.append(_stat("Lesion volume", vol.get("cm3"), "cm³"))
    if vol.get("voxelCount") is not None:
        stats.append(_stat("Voxels", vol.get("voxelCount")))
    cen = vol.get("centroidMM")
    if isinstance(cen, (list, tuple)) and len(cen) == 3:
        stats.append(_stat("Centroid (MNI)", f"{_num(cen[0])}, {_num(cen[1])}, {_num(cen[2])}", "mm"))
    if stats:
        cards.append('<section class="card"><h2>Key Statistics</h2>'
                     f'<div class="grid">{"".join(stats)}</div></section>')

    # Brainsprite
    if ctx.get("brainsprite_file"):
        cards.append(
            '<section class="card"><h2>Lesion Viewer <span class="tag">brainsprite</span></h2>'
            f'<div class="viewer"><iframe src="{_esc(ctx["brainsprite_file"])}"></iframe></div>'
            '<p class="muted">Interactive MNI152 viewer — scroll to change slices, drag to reposition.</p>'
            '</section>')

    # Atlas overlap
    breakdowns = (ctx.get("overlap_model") or {}).get("atlasBreakdowns") or []
    if breakdowns:
        tables = "".join(_atlas_table_html(b) for b in breakdowns)
        cards.append(f'<section class="card"><h2>Atlas Overlap</h2>{tables}</section>')

    # Tract dissection
    if ctx.get("dissect_brainsprite") or ctx.get("dissect_info"):
        di = ctx.get("dissect_info") or {}
        sub = []
        if di.get("n_selected_streamlines") is not None:
            sub.append(_stat("Affected streamlines", di.get("n_selected_streamlines")))
        if di.get("tract_volume_cm3") is not None:
            sub.append(_stat("Tract volume", di.get("tract_volume_cm3"), "cm³"))
        tract_rows = (di.get("atlas_overlap") or {}).get("hcp1065") or []
        tracts_html = "<h3>Affected tracts</h3>" + _affected_tracts_table_html(tract_rows)
        viewer = (
            '<div class="viewer"><iframe src="'
            f'{_esc(ctx["dissect_brainsprite"])}"></iframe></div>'
            '<p class="muted">Interactive MNI152 viewer of streamlines passing through the lesion — '
            'scroll to change slices, drag to reposition.</p>'
            ) if ctx.get("dissect_brainsprite") else ""
        cards.append('<section class="card"><h2>Tract Dissection</h2>'
                     + (f'<div class="grid">{"".join(sub)}</div>' if sub else "")
                     + tracts_html + viewer + '</section>')

    # Lesion network mapping
    if ctx.get("lnm_info") or ctx.get("lnm_bs_pos") or ctx.get("lnm_bs_neg"):
        li = ctx.get("lnm_info") or {}
        sub = []
        if li.get("n_pos_thr") is not None:
            sub.append(_stat("Positive voxels", li.get("n_pos_thr")))
        if li.get("n_neg_thr") is not None:
            sub.append(_stat("Negative voxels", li.get("n_neg_thr")))
        if li.get("degree_corr_after") is not None:
            sub.append(_stat("Degree corr (after)", li.get("degree_corr_after")))
        views = ""
        if ctx.get("lnm_bs_pos"):
            views += (f'<div class="viewer"><iframe src="{_esc(ctx["lnm_bs_pos"])}"></iframe></div>'
                      '<p class="muted">Positively-coupled network (correlated with the lesion) — '
                      'interactive MNI152 viewer; scroll to change slices, drag to reposition.</p>')
        if ctx.get("lnm_bs_neg"):
            views += (f'<div class="viewer"><iframe src="{_esc(ctx["lnm_bs_neg"])}"></iframe></div>'
                      '<p class="muted">Negatively-coupled network (anticorrelated) — '
                      'interactive MNI152 viewer; scroll to change slices, drag to reposition.</p>')
        # Yeo-7 functional networks affected (both tails, stacked below the viewers).
        yeo = ""
        nets = li.get("networks") or {}
        if nets:
            yeo = ('<h3>Functional networks (Yeo-7)</h3>'
                   + _yeo_table_html("Positive (coupled) network",
                                     nets.get("yeo_pos"), nets.get("yeo_err"))
                   + _yeo_table_html("Negative (anticorrelated) network",
                                     nets.get("yeo_neg"), nets.get("yeo_err")))
        cards.append('<section class="card"><h2>Lesion Network Mapping '
                     '<span class="tag">degree-adjusted</span></h2>'
                     + (f'<div class="grid">{"".join(sub)}</div>' if sub else "")
                     + views + yeo + '</section>')

    # Retinotopy (kept last: the visual-pathway finding reads best after the
    # anatomical/connectivity sections above it).
    retino = ctx.get("retino") or {}
    if retino:
        disc = (f'<figure><img src="{_esc(ctx["retino_disc"])}" alt="Retinotopy visual-field map">'
                '<figcaption>2D visual-field map — polar angle (color) × eccentricity (radius); '
                'black = predicted VF deficit.</figcaption></figure>'
                ) if ctx.get("retino_disc") else ""
        tbl = ""
        if retino.get("rows"):
            body = "".join(
                f"<tr><td>{_esc(r['name'])}</td><td>{r['hit_voxels']}</td>"
                f"<td>{_num(r['pct_region'])}%</td><td>{_num(r['pct_lesion'])}%</td></tr>"
                for r in retino["rows"])
            tbl = ("<table><thead><tr><th>Visual-pathway tract</th><th>Voxels hit</th>"
                   "<th>% of tract</th><th>% of lesion</th></tr></thead>"
                   f"<tbody>{body}</tbody></table>")
        cards.append('<section class="card"><h2>Retinotopy</h2>'
                     f'<div class="finding">{_esc(retino.get("finding",""))}</div>'
                     + tbl + disc + '</section>')

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    name = ctx.get("lesion_name") or "Lesion"
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NeuroVue — MR LATTE Lesion Summary: {_esc(name)}</title><style>{_CSS}</style></head>
<body><header><div class="wrap"><h1>MR LATTE Lesion Summary</h1>
<p class="sub">{_esc(name)} · generated {generated}</p></div></header>
<div class="wrap">{"".join(cards)}
<footer>NeuroVue — automated summary. Illustrative / research use; not a clinical diagnosis.</footer>
</div></body></html>"""


def main():
    _real_stdout = sys.stdout
    sys.stdout = sys.stderr  # keep library chatter off the JSON channel

    import matplotlib
    matplotlib.use("Agg")

    cfg = json.loads(Path(sys.argv[1]).read_text())
    lesion_path = Path(cfg["lesion_path"])
    out_dir = Path(cfg["output_dir"])
    atlas_dir = cfg["atlas_dir"]
    stages = cfg.get("stages", {})
    lesion_name = cfg.get("lesion_name") or lesion_path.name

    images_dir = out_dir / "images"
    maps_dir = out_dir / "maps"
    data_dir = out_dir / "data"
    for d in (images_dir, maps_dir, data_dir):
        d.mkdir(parents=True, exist_ok=True)

    ctx = {"lesion_name": lesion_name, "overlap_model": cfg.get("overlap_model")}

    # ── Retinotopy visual-pathway check ──────────────────────────────────────
    if stages.get("retino", True):
        try:
            ctx["retino"] = _retinotopy_check(lesion_path, atlas_dir)
        except Exception as e:  # noqa: BLE001
            print(f"[summary] retino check failed: {e}", file=sys.stderr)
            ctx["retino"] = {"available": False, "intersects": False, "rows": [],
                             "finding": "Retinotopy check could not be completed.",
                             "atlas_name": None}

    # Client-rendered 2D retinotopy disc(s)
    disc_pngs = cfg.get("disc_pngs") or {}
    # Prefer the 2D visual-field map (matches the on-screen "Export PNG"); fall
    # back to the classic polar-angle disc only if the 2D map failed to render.
    disc_b64 = disc_pngs.get("vfmap") or disc_pngs.get("polar")
    if disc_b64:
        try:
            raw = disc_b64.split(",", 1)[-1]  # strip data: URL prefix if present
            (images_dir / "retinotopy_disc.png").write_bytes(base64.b64decode(raw))
            ctx["retino_disc"] = "images/retinotopy_disc.png"
        except Exception as e:  # noqa: BLE001
            print(f"[summary] disc decode failed: {e}", file=sys.stderr)

    # ── Brainsprite of the lesion on MNI ─────────────────────────────────────
    if _brainsprite_html(lesion_path, out_dir / "brainsprite_lesion.html"):
        ctx["brainsprite_file"] = "brainsprite_lesion.html"

    # ── Tract dissection artefacts ───────────────────────────────────────────
    dissect = cfg.get("dissect")
    if dissect and dissect.get("result_dir"):
        rd = Path(dissect["result_dir"])
        ctx["dissect_info"] = dissect.get("info") or {}
        nii = rd / "affected_tracts.nii.gz"
        trk = rd / "affected_tracts.trk"
        if nii.exists():
            shutil.copy2(nii, maps_dir / "affected_tracts.nii.gz")
            if _brainsprite_html(nii, out_dir / "brainsprite_tracts.html",
                                 title="Affected tracts on MNI152", cmap="hot",
                                 threshold=0.5, opacity=0.9):
                ctx["dissect_brainsprite"] = "brainsprite_tracts.html"
        if trk.exists():
            shutil.copy2(trk, maps_dir / "affected_tracts.trk")

    # ── DA-LNM maps + glass brains ───────────────────────────────────────────
    lnm = cfg.get("lnm")
    if lnm and lnm.get("result_dir"):
        rd = Path(lnm["result_dir"])
        ctx["lnm_info"] = lnm.get("info") or {}
        # positive-only, negative-only, both, and degree-adjusted maps
        for src, tag in (("network_pos_bin.nii.gz", "network_pos_bin.nii.gz"),
                         ("network_neg_bin.nii.gz", "network_neg_bin.nii.gz"),
                         ("lnm_thresh_cont.nii.gz", "lnm_thresh_cont.nii.gz"),
                         ("lnm_da.nii.gz", "lnm_da.nii.gz")):
            if (rd / src).exists():
                shutil.copy2(rd / src, maps_dir / tag)
        if (rd / "network_pos_bin.nii.gz").exists():
            if _brainsprite_html(rd / "network_pos_bin.nii.gz",
                                 out_dir / "brainsprite_lnm_positive.html",
                                 title="Positive network", cmap="autumn",
                                 threshold=0.5, opacity=0.85):
                ctx["lnm_bs_pos"] = "brainsprite_lnm_positive.html"
        if (rd / "network_neg_bin.nii.gz").exists():
            if _brainsprite_html(rd / "network_neg_bin.nii.gz",
                                 out_dir / "brainsprite_lnm_negative.html",
                                 title="Negative network", cmap="winter",
                                 threshold=0.5, opacity=0.85):
                ctx["lnm_bs_neg"] = "brainsprite_lnm_negative.html"
        # Include the LNM's own full report for completeness, if present.
        if (rd / "report.html").exists():
            shutil.copy2(rd / "report.html", out_dir / "lnm_full_report.html")

    # ── Atlas overlap CSV ────────────────────────────────────────────────────
    breakdowns = (cfg.get("overlap_model") or {}).get("atlasBreakdowns") or []
    if breakdowns:
        lines = ["atlas,region,voxels,pct_of_lesion,pct_of_region"]
        for b in breakdowns:
            an = str(b.get("atlasName", "")).replace(",", " ")
            for r in b.get("rows", []) or []:
                rn = str(r.get("regionName", "")).replace(",", " ")
                lines.append(f"{an},{rn},{r.get('voxelCount',0)},"
                             f"{r.get('percentOfLesion',0)},{r.get('percentOfRegion',0)}")
        (data_dir / "atlas_overlap.csv").write_text("\n".join(lines))

    # ── Report HTML ──────────────────────────────────────────────────────────
    (out_dir / "report.html").write_text(_build_report_html(ctx), encoding="utf-8")

    # ── ZIP everything ───────────────────────────────────────────────────────
    zip_path = out_dir / "summary.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(out_dir.rglob("*")):
            if p.is_file() and p.name != "summary.zip":
                zf.write(p, p.relative_to(out_dir).as_posix())

    print(json.dumps({
        "ok": True,
        "zip": f"/api/summary/result/{cfg['job_id']}/summary.zip",
        "report": f"/api/summary/result/{cfg['job_id']}/report.html",
        "retino": ctx.get("retino"),
    }), file=_real_stdout, flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        sys.exit(1)
