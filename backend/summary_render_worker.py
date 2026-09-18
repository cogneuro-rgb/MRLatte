#!/usr/bin/env python
"""Isolated worker: One-Click Summary rendering + artifact manifest.

Given a lesion mask plus the (already-computed) tract-dissection and DA-LNM
outputs, this worker produces the visual/report artifacts and declares exactly
what it produced:

  * an optic-radiation / visual-pathway retinotopy check (lesion vs. named-tract
    atlas labels -- HCP1065, falling back to JHU),
  * brainsprite viewers of the lesion, the affected tracts, and the DA-LNM
    positive/negative network tails on MNI152 (nilearn view_img),
  * an artifact manifest (rel/label/kind/bytes/group/default per file) so the
    frontend can offer a selective-download picker instead of one big ZIP.

Item 103: this worker no longer composes its own report.html. It returns the
same underlying data (retinotopy finding, dissection/LNM info, asset URLs)
in its JSON result instead, so the frontend (lib/report/) composes ONE report
document reusing the same section builders Tract Dissection and LNM use.

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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker_common import make_set_status as _make_set_status  # noqa: E402


# Optic-radiation / posterior-thalamic-radiation label matcher (visual pathway).
def _is_visual_pathway(name: str) -> bool:
    n = (name or "").lower()
    return ("optic radiation" in n) or ("posterior thalamic radiation" in n)


def _retinotopy_check(lesion_path):
    """Voxel overlap of the lesion with visual white-matter tracts.

    Prefers HCP1065 named tracts; falls back to the JHU WM atlas. Returns a
    dict with a human finding and per-tract rows, or a 'skipped' marker when no
    suitable atlas is bundled.
    """
    import numpy as np
    import nibabel as nib
    from worker_common import resample_to_img

    # Resolved through the atlas registry: a tract atlas may be uninstalled, and
    # its folder name is no longer something this worker should know. First
    # preference wins; the check is skipped (not failed) when neither is
    # installed, which is why the fallback message is user-facing.
    import atlas_registry
    import atlas_labels as atlas_labels_mod

    desc = None
    for atlas_id in ("hcp1065_tracts", "jhu_wm"):
        d = atlas_registry.resolve(atlas_id)
        if d and Path(d["volumePath"]).exists() and Path(d["labelsPath"]).exists():
            desc = d
            break
    if desc is None:
        return {"available": False, "intersects": False, "rows": [],
                "finding": "Visual-pathway atlas not available on the server; "
                           "retinotopy tract check skipped.",
                "atlas_name": None}

    atlas_nii = Path(desc["volumePath"])
    label_map = atlas_labels_mod.name_map(
        atlas_labels_mod.read_labels_or_empty(desc["labelsPath"]))

    les_img = nib.load(str(lesion_path))
    atlas_img = nib.load(str(atlas_nii))
    # Resample the atlas onto the lesion grid (nearest -> labels stay integral).
    # force_resample=True is REQUIRED for correctness — see worker_common.py's
    # ho_overlap. False mis-places the atlas whenever it shares voxel sizes with
    # the lesion grid, which silently corrupts the region-overlap table.
    atlas_r = resample_to_img(atlas_img, les_img, interpolation="nearest",
                              copy_header=False, force_resample=True)
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
            "finding": finding, "atlas_name": desc["short"]}


# Phase 1b: nilearn + matplotlib are the optional `reports-figures` module, not
# part of the base install. Everything below is FIGURE-ONLY, so it may keep
# using them — but it must degrade with a message rather than raise, matching
# the availability probe in routers/summary.py (which reports
# `{ok: False, reason: "Missing dependency: …"}` when the stack is absent).
REPORTS_HINT = (
    "the report figure renderer is not installed. Install the "
    "'reports-figures' module (pip install -r backend/requirements-reports.txt) "
    "to enable nilearn/matplotlib figures.")


def _reports_stack():
    """(nilearn.plotting, nilearn.datasets.load_mni152_template) with matplotlib
    pinned to Agg. Raises RuntimeError carrying REPORTS_HINT if absent."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        from nilearn import plotting
        from nilearn.datasets import load_mni152_template
    except ImportError as e:
        raise RuntimeError(f"Missing dependency: {e} — {REPORTS_HINT}") from e
    return plotting, load_mni152_template


def _brainsprite_html(img_path, out_path, title="Lesion on MNI152", cmap="autumn",
                       threshold=0.5, opacity=0.8):
    """Interactive brainsprite of a NIfTI on MNI152; returns True on success."""
    try:
        import nibabel as nib
        plotting, load_mni152_template = _reports_stack()
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


def _write_overlap_csv(data_dir, overlap_model):
    """Write data/atlas_overlap.csv from an overlap_model's atlasBreakdowns.
    Returns True iff the file was written (i.e. there was at least one
    breakdown row). A pure, unit-testable helper -- see
    backend/tests/test_summary_overlap.py.

    The optional leading `# engine: ...` comment line carries the same
    provenance the frontend's provenance pill shows (see
    lib/lesionReport.js::engineProvenanceLabel) -- safe as a comment line
    only because nothing parses this file strictly (checked: no
    csv.DictReader/pandas.read_csv consumer exists anywhere in the repo as
    of this writing; re-check before removing the comment-safety assumption
    this relies on)."""
    breakdowns = (overlap_model or {}).get("atlasBreakdowns") or []
    if not breakdowns:
        return False
    lines = []
    prov = (overlap_model or {}).get("provenance") or {}
    if prov:
        engine = prov.get("engine", "unknown")
        version = prov.get("version") or "?"
        threshold = prov.get("threshold")
        resampling = prov.get("resampling", "")
        lines.append(f"# engine: {engine} {version} · threshold > {threshold} "
                    f"· {resampling}".replace(",", " "))
    lines.append("atlas,region,voxels,pct_of_lesion,pct_of_region")
    for b in breakdowns:
        an = str(b.get("atlasName", "")).replace(",", " ")
        for r in b.get("rows", []) or []:
            rn = str(r.get("regionName", "")).replace(",", " ")
            lines.append(f"{an},{rn},{r.get('voxelCount',0)},"
                         f"{r.get('percentOfLesion',0)},{r.get('percentOfRegion',0)}")
    (data_dir / "atlas_overlap.csv").write_text("\n".join(lines))
    return True


def _artifact(out_dir, rel, label, kind, group, default):
    """One entry for the worker's declared-artifacts manifest -- only included
    when the file actually exists on disk, so the frontend's picker never
    lists something the download route can't serve."""
    if not rel:
        return None
    p = out_dir / rel
    if not p.exists() or not p.is_file():
        return None
    return {"rel": rel, "label": label, "kind": kind, "bytes": p.stat().st_size,
            "group": group, "default": default}


def _build_manifest(out_dir, ctx):
    """Assemble the artifact manifest from what this run actually produced.

    Pure function of (out_dir, ctx) -- unit-testable without the
    nilearn/matplotlib reports stack, a real lesion, or a subprocess. `ctx`
    carries the rel paths of the run-dependent artifacts (brainsprite viewers,
    the retinotopy disc); the dissect/LNM maps and the overlap CSV have fixed
    rel paths, so they're named directly. _artifact() drops anything that
    doesn't exist on disk, so a skipped stage just produces a shorter list."""
    return [a for a in (
        _artifact(out_dir, ctx.get("brainsprite_file"),
                 "Lesion viewer (interactive)", "html", "Viewers", True),
        _artifact(out_dir, ctx.get("dissect_brainsprite"),
                 "Affected tracts viewer (interactive)", "html", "Viewers", True),
        _artifact(out_dir, ctx.get("lnm_bs_pos"),
                 "Positive network viewer (interactive)", "html", "Viewers", True),
        _artifact(out_dir, ctx.get("lnm_bs_neg"),
                 "Negative network viewer (interactive)", "html", "Viewers", True),
        _artifact(out_dir, ctx.get("retino_disc"),
                 "Retinotopy disc (image)", "image", "Images", True),
        _artifact(out_dir, "maps/affected_tracts.nii.gz",
                 "Affected tracts (NIfTI)", "map", "Maps", False),
        _artifact(out_dir, "maps/affected_tracts.trk",
                 "Affected tracts (streamlines, .trk)", "map", "Maps", False),
        _artifact(out_dir, "maps/network_pos_bin.nii.gz",
                 "Positive network mask (NIfTI)", "map", "Maps", False),
        _artifact(out_dir, "maps/network_neg_bin.nii.gz",
                 "Negative network mask (NIfTI)", "map", "Maps", False),
        _artifact(out_dir, "maps/lnm_thresh_cont.nii.gz",
                 "Thresholded continuous network map (NIfTI)", "map", "Maps", False),
        _artifact(out_dir, "maps/lnm_da.nii.gz",
                 "Degree-adjusted network map (NIfTI)", "map", "Maps", False),
        _artifact(out_dir, "data/atlas_overlap.csv",
                 "Atlas overlap table (CSV)", "data", "Data", True),
    ) if a is not None]


def main():
    _real_stdout = sys.stdout
    sys.stdout = sys.stderr  # keep library chatter off the JSON channel

    cfg = json.loads(Path(sys.argv[1]).read_text())

    # Extra sys.path entries from the parent (optional Python stacks like
    # python-reports/python-validation in a full packaged build — see
    # worker_common.extra_sys_path_for_worker for why PYTHONPATH can't carry
    # these across the subprocess boundary). Must run before any import that
    # might need them — in particular _reports_stack()/_brainsprite_html()
    # below, which is exactly the import this worker silently swallows when
    # it fails (see REPORTS_HINT).
    for _p in cfg.get("sys_path") or []:
        if _p not in sys.path:
            sys.path.insert(0, _p)

    # Best-effort only: matplotlib is part of the optional reports stack. The
    # retinotopy check, the maps and the manifest all work without it, so a
    # missing plotting stack must not abort the whole worker — the figure
    # helpers each re-check and report their own reason. Must stay BELOW the sys.path
    # injection above: in a full build matplotlib lives in python-reports,
    # which only reaches this process via cfg["sys_path"], so running this
    # first would log "unavailable" on every run while the figures in fact
    # render fine (_reports_stack pins Agg again anyway).
    try:
        import matplotlib
        matplotlib.use("Agg")
    except ImportError as e:
        print(f"[summary] matplotlib unavailable ({e}); figures will be skipped — "
              f"{REPORTS_HINT}", file=sys.stderr)

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

    # Item 105: optional live-progress channel, same contract as dissect_worker
    # /lnm_worker (cfg["status_path"] absent => no-op). The One-Click Summary
    # orchestrator maps this worker's 0..1 onto the tail of its own bar.
    set_status = _make_set_status(cfg.get("status_path"))

    # ── Retinotopy visual-pathway check ──────────────────────────────────────
    set_status("retino", 0.05, "Checking visual pathway…")
    if stages.get("retino", True):
        try:
            ctx["retino"] = _retinotopy_check(lesion_path)
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
    set_status("brainsprite", 0.25, "Rendering lesion viewer…")
    if _brainsprite_html(lesion_path, out_dir / "brainsprite_lesion.html"):
        ctx["brainsprite_file"] = "brainsprite_lesion.html"

    # ── Tract dissection artefacts ───────────────────────────────────────────
    set_status("dissect_assets", 0.45, "Packaging tract dissection…")
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
    set_status("lnm_assets", 0.60, "Packaging network maps…")
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
    # ── Atlas overlap CSV ────────────────────────────────────────────────────
    set_status("csv", 0.85, "Writing atlas overlap table…")
    _write_overlap_csv(data_dir, cfg.get("overlap_model"))

    # ── Artifact manifest (replaces the old zip-everything) ─────────────────
    # The worker declares exactly what it produced -- rel path, human label,
    # kind, size, picker group, and whether it's checked by default -- instead
    # of zipping the whole out_dir (which swept in the uploaded lesion input
    # and the internal status.json). The frontend lists these via
    # /api/summary/artifacts/{job_id} and lets the user pick what to download
    # through /api/summary/download/{job_id}. Only files that actually exist
    # are included (see _artifact).
    set_status("manifest", 0.92, "Finalizing artifacts…")
    artifacts = _build_manifest(out_dir, ctx)

    # Item 103: absolute, servable URLs for every visual asset this worker
    # produced, so the frontend (OneClickSummaryPanel) can compose the same
    # sections lib/report/sections.js uses elsewhere (Open/Save), instead of
    # this worker composing its own narrative HTML.
    def asset_url(rel):
        return f"/api/summary/result/{cfg['job_id']}/{rel}" if rel else None

    print(json.dumps({
        "ok": True,
        "artifacts": artifacts,
        "lesion_name": lesion_name,
        "retino": ctx.get("retino"),
        "dissect_info": ctx.get("dissect_info"),
        "lnm_info": ctx.get("lnm_info"),
        "overlap_model": ctx.get("overlap_model"),
        "assets": {
            "brainsprite_lesion": asset_url(ctx.get("brainsprite_file")),
            "brainsprite_tracts": asset_url(ctx.get("dissect_brainsprite")),
            "brainsprite_lnm_pos": asset_url(ctx.get("lnm_bs_pos")),
            "brainsprite_lnm_neg": asset_url(ctx.get("lnm_bs_neg")),
            "retino_disc": asset_url(ctx.get("retino_disc")),
        },
    }), file=_real_stdout, flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        sys.exit(1)
