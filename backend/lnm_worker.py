#!/usr/bin/env python
"""Isolated worker: Degree-Adjusted Lesion Network Mapping (DA-LNM v2.1).

Runs the DA-LNM Connectome pipeline on a lesion mask: seed-to-voxel stat map
(t or Fisher-z), optional degree adjustment, optional randomized-lesion
specificity filtering, tail voxel counts, and optional report figures (nilearn
+ matplotlib, only when the optional `reports-figures` module is installed —
the compute path above needs numpy/nibabel/scipy only). Called by server.py via
subprocess for crash isolation (mirrors dissect_worker.py -- a numpy/nibabel
crash kills only this process).

Usage: python lnm_worker.py <config_json_path>
  Config JSON keys: lesion_path, result_id, bundle_path, lnm_results_dir,
    metric ("t"|"z"), threshold, zthr, pthr, degree_adjust, run_specificity,
    nperm, alpha, fdr, sampling_mask, seed, top, make_html
Output: one JSON line on stdout; traceback to stderr on failure.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker_common import make_set_status as _make_set_status  # noqa: E402


def main():
    # numpy/nibabel/nilearn/matplotlib emit log lines to stdout; reserve stdout
    # for the single JSON result and route everything else to stderr.
    _real_stdout = sys.stdout
    sys.stdout = sys.stderr

    config_path = Path(sys.argv[1])
    cfg = json.loads(config_path.read_text())

    # Extra sys.path entries from the parent (optional Python stacks like
    # python-reports/python-validation in a full packaged build — see
    # worker_common.extra_sys_path_for_worker for why PYTHONPATH can't carry
    # these across the subprocess boundary). Must run before any import that
    # might need them.
    for _p in cfg.get("sys_path") or []:
        if _p not in sys.path:
            sys.path.insert(0, _p)

    lesion_path     = Path(cfg["lesion_path"])
    result_id       = cfg["result_id"]
    bundle_path     = Path(cfg["bundle_path"])
    lnm_results_dir = Path(cfg["lnm_results_dir"])

    metric          = cfg.get("metric", "t")
    threshold       = float(cfg.get("threshold", 11.0))
    zthr            = float(cfg.get("zthr", 0.2))
    pthr            = cfg.get("pthr")
    pthr            = float(pthr) if pthr not in (None, "") else None
    degree_adjust   = bool(cfg.get("degree_adjust", True))
    run_spec        = bool(cfg.get("run_specificity", True))
    nperm           = int(cfg.get("nperm", 100))
    alpha           = float(cfg.get("alpha", 0.05))
    fdr             = bool(cfg.get("fdr", False))
    sampling_mask   = cfg.get("sampling_mask") or ""
    seed            = int(cfg.get("seed", 0))
    top             = int(cfg.get("top", 15))
    make_html       = bool(cfg.get("make_html", True))
    # Optional live-progress channel (job mode); no-op when absent (sync/summary).
    # Stage bands (item 99): specificity is by far the slowest phase (nperm
    # randomized-lesion permutations), so it owns most of the bar — the other
    # four stages are comparatively instant and just need to visibly tick.
    set_status      = _make_set_status(cfg.get("status_path"))
    set_status("load", 0.06, "Loading connectome bundle…")

    import numpy as np
    import nibabel as nib
    # lnm_backend.py is a sibling of this worker. When launched via subprocess
    # under the offline installer's embeddable Python, the ._pth file controls
    # sys.path and does NOT auto-add the script's own directory, so a bare
    # `import lnm_backend` fails with ModuleNotFoundError (dev works only because
    # normal Python prepends the script dir). Add it explicitly.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from lnm_backend import (
        Connectome, pool_indices, region_tables, t_threshold,
        static_png, mosaic_png, interactive_html,
    )

    c = Connectome(str(bundle_path))

    if metric == "z":
        tc, thr_note = zthr, ""
    elif pthr is not None:
        tc, thr_note = t_threshold(pthr, c.N - 1), f" (P<{pthr:g}, df={c.N - 1})"
    else:
        tc, thr_note = threshold, ""

    result_dir = lnm_results_dir / result_id
    result_dir.mkdir(parents=True, exist_ok=True)
    raw_path         = result_dir / "lnm_raw.nii.gz"
    da_path          = result_dir / "lnm_da.nii.gz"
    thresh_cont_path = result_dir / "lnm_thresh_cont.nii.gz"
    pos_bin_path     = result_dir / "network_pos_bin.nii.gz"
    neg_bin_path     = result_dir / "network_neg_bin.nii.gz"
    spec_zscore_path = result_dir / "specificity_zscore.nii.gz"
    spec_net_path    = result_dir / "specificity_network.nii.gz"

    try:
        les_idx = c._load_lesion(str(lesion_path))
    except ValueError as e:
        print(json.dumps({"id": result_id, "error": str(e)}),
              file=_real_stdout, flush=True)
        sys.exit(1)

    vvox = int(les_idx.sum())
    set_status("seed", 0.12, "Computing seed-to-voxel map…")
    stat, raw, rb, ra = c.stat_for_indices(les_idx, degree_adjust, metric)
    stat = c._mask_brain(stat); raw = c._mask_brain(raw)

    nib.save(c._to_img(raw), str(raw_path))
    if degree_adjust:
        nib.save(c._to_img(stat), str(da_path))
    cont = stat.copy(); cont[np.abs(cont) < tc] = 0.0
    nib.save(c._to_img(cont), str(thresh_cont_path))
    n_pos_thr = int((stat >= tc).sum()); n_neg_thr = int((stat <= -tc).sum())

    spec = None; main_vec = cont
    pos_bin = (stat >= tc); neg_bin = (stat <= -tc)
    if run_spec:
        rng = np.random.default_rng(seed)
        pool = pool_indices(c, sampling_mask)
        # Map permutation progress into the 0.12–0.88 band of the overall bar
        # (item 99) — specificity is the slowest phase by far, so it gets most
        # of the bar's range instead of the previous 0.40–0.80 (40%). chunk=4
        # (down from the default 8) makes progress_cb fire twice as often for
        # a visibly smoother fill; it only changes how often progress is
        # reported, not the RNG draw order or null accumulation.
        def _spec_progress(done, total):
            frac = (done / total) if total else 1.0
            set_status("specificity", 0.12 + 0.76 * frac,
                       f"Specificity permutations {done}/{total}…")
        spec = c.specificity(stat, vvox, degree_adjust, metric, tc, nperm,
                             pool, alpha, fdr, rng, chunk=4, progress_cb=_spec_progress)
        pos_bin = spec["sig_pos"]; neg_bin = spec["sig_neg"]  # post-specificity
        sig = spec["sig_pos"] | spec["sig_neg"]
        main_vec = np.where(sig, stat, 0.0)
        nib.save(c._to_img(spec["z"]), str(spec_zscore_path))
        nib.save(c._to_img(main_vec), str(spec_net_path))

    nib.save(c._to_img(pos_bin.astype(np.float32)), str(pos_bin_path))
    nib.save(c._to_img(neg_bin.astype(np.float32)), str(neg_bin_path))

    # -- robust display window for the overlay (degree-adjusted |t| can be huge) --
    tabs = np.abs(stat[stat != 0])
    disp_max = float(np.percentile(tabs, 99)) if tabs.size else float(tc * 4)
    disp_max = max(disp_max, float(tc) + 1.0)

    # -- region statistics on the PRIMARY result (specificity net if present) --
    set_status("regions", 0.88, "Labelling regions…")
    tables = region_tables(c._to_img(main_vec), tc, top=top, use_atlases=True)

    def _rows(rows):
        return [{"name": nm, "voxels": n, "pct": round(pct, 1), "mean_t": round(mt, 2)}
                for nm, n, pct, mt in rows]

    networks = {"n_pos": tables.get("n_pos", 0), "n_neg": tables.get("n_neg", 0)}
    for key in ("ho", "yeo"):
        err_key = f"{key}_err"
        if err_key in tables:
            networks[err_key] = tables[err_key]
        else:
            networks[f"{key}_pos"] = _rows(tables.get(f"{key}_pos", []))
            networks[f"{key}_neg"] = _rows(tables.get(f"{key}_neg", []))

    # Item 103: this worker no longer composes report.html itself (that moved
    # to the frontend's lib/report/ — one HTML-generation owner for every
    # report type). It still renders the same nilearn visuals (interactive
    # MNI viewer, falling back to a static mosaic/section PNG) and returns
    # them directly in the JSON result so the frontend can embed them via
    # lib/report/sections.js::buildLnmImagesSection exactly as this worker's
    # own report.html used to.
    images = None
    if make_html:
        set_status("render", 0.92, "Rendering figures…")
        primary_img = c._to_img(main_vec)
        primary_iframe, primary_err = interactive_html(primary_img, tc, lesion_path=str(lesion_path))
        primary_png = None
        if not primary_iframe:
            primary_png, _ = mosaic_png(primary_img, tc, lesion_path=str(lesion_path))
        support_iframe, support_err = interactive_html(c._to_img(cont), tc, lesion_path=str(lesion_path))
        support_png = None
        if not support_iframe:
            support_png, support_err = static_png(
                c._to_img(cont), tc, "Thresholded network on MNI152", lesion_path=str(lesion_path))
        images = {
            "primary": {"iframe": primary_iframe, "png": primary_png, "err": primary_err},
            "support": {"iframe": support_iframe, "png": support_png, "err": support_err},
        }

    files = {
        "raw":         f"/api/lnm/result/{result_id}/lnm_raw.nii.gz",
        "thresh_cont": f"/api/lnm/result/{result_id}/lnm_thresh_cont.nii.gz",
        "pos_bin":     f"/api/lnm/result/{result_id}/network_pos_bin.nii.gz",
        "neg_bin":     f"/api/lnm/result/{result_id}/network_neg_bin.nii.gz",
    }
    if degree_adjust:
        files["da"] = f"/api/lnm/result/{result_id}/lnm_da.nii.gz"
    if spec is not None:
        files["spec_zscore"] = f"/api/lnm/result/{result_id}/specificity_zscore.nii.gz"
        files["spec_net"] = f"/api/lnm/result/{result_id}/specificity_network.nii.gz"

    print(json.dumps({
        "id": result_id,
        "metric": metric,
        "degree_adjust": degree_adjust,
        "threshold": tc,
        "thr_note": thr_note,
        "n_lesion_voxels": vvox,
        "degree_corr_before": round(rb, 3),
        "degree_corr_after": (round(ra, 3) if ra is not None else None),
        "n_pos_thr": n_pos_thr,
        "n_neg_thr": n_neg_thr,
        "specificity": (
            {"run": True, "nperm": nperm, "alpha": alpha, "fdr": fdr,
             "n_sig_pos": spec["n_sig_pos"], "n_sig_neg": spec["n_sig_neg"]}
            if spec is not None else {"run": False}
        ),
        "display": {"cal_min": float(tc), "cal_max": round(disp_max, 2)},
        "files": files,
        "networks": networks,
        # Item 103: figures for the frontend's own report composition
        # (lib/report/sections.js::buildLnmImagesSection) — replaces the
        # backend-composed report.html this worker used to write.
        "images": images,
    }), file=_real_stdout, flush=True)
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
