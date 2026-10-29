#!/usr/bin/env python
"""Isolated worker: One-Click Summary data + artifact manifest.

Given a lesion mask plus the (already-computed) tract-dissection and DA-LNM
outputs, this worker produces the run's data and declares exactly what it
produced:

  * an optic-radiation / visual-pathway retinotopy check (lesion vs. named-tract
    atlas labels -- HCP1065, falling back to JHU),
  * the run's maps (affected tracts, network masks) and the atlas-overlap CSV,
  * an artifact manifest (rel/label/kind/bytes/group/default per file) so the
    frontend can offer a selective-download picker instead of one big ZIP.

It draws nothing. The report is the run's only figure output, and the
frontend draws its figures from these maps (lib/report/figures.js) — so the
summary needs neither nilearn nor matplotlib (the reports-figures module).
Item 103: the frontend (lib/report/) composes ONE report document from the
data returned here, reusing the section builders Tract Dissection and LNM use.

Called by server.py via subprocess for crash isolation (mirrors
dissect_worker.py / lnm_worker.py). Heavy imports are deferred and stdout is
reserved for the single JSON result line; all library chatter is routed to
stderr.

Usage: python summary_render_worker.py <config_json_path>
Output: one JSON line on stdout; traceback to stderr on failure.
"""
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
                   "clinically.")
    else:
        finding = ("No occipital / visual-pathway intersection: the lesion does "
                   "not overlap the optic radiation or posterior thalamic "
                   "radiation in this atlas.")

    return {"available": True, "intersects": bool(rows), "rows": rows,
            "finding": finding, "atlas_name": desc["short"]}


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
    real lesion or a subprocess. Only DATA is offered — the maps and the
    overlap CSV, at fixed rel paths; the report (built by the frontend) is the
    run's one figure output. _artifact() drops anything that doesn't exist on
    disk, so a skipped stage just produces a shorter list. `ctx` is unused
    today and kept for the call shape."""
    return [a for a in (
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

    # Extra sys.path entries from the parent (optional Python stacks and
    # installed python modules — see worker_common.extra_sys_path_for_worker
    # for why PYTHONPATH can't carry these across the subprocess boundary).
    # Must run before any import that might need them.
    for _p in cfg.get("sys_path") or []:
        if _p not in sys.path:
            sys.path.insert(0, _p)

    lesion_path = Path(cfg["lesion_path"])
    out_dir = Path(cfg["output_dir"])
    atlas_dir = cfg["atlas_dir"]
    stages = cfg.get("stages", {})
    lesion_name = cfg.get("lesion_name") or lesion_path.name

    maps_dir = out_dir / "maps"
    data_dir = out_dir / "data"
    for d in (maps_dir, data_dir):
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
        if trk.exists():
            shutil.copy2(trk, maps_dir / "affected_tracts.trk")

    # ── DA-LNM maps ──────────────────────────────────────────────────────────
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

    print(json.dumps({
        "ok": True,
        "artifacts": artifacts,
        "lesion_name": lesion_name,
        "retino": ctx.get("retino"),
        "dissect_info": ctx.get("dissect_info"),
        "lnm_info": ctx.get("lnm_info"),
        "overlap_model": ctx.get("overlap_model"),
    }), file=_real_stdout, flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        sys.exit(1)
