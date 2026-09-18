"""
Round-trip + neuropythy validation of the surface→volume atlas projection pipeline.

Primary (A): surface .mgz → volume .nii.gz → back-project to surface → compare with source
Secondary (C): compare source .mgz and back-projected values against neuropythy benson14 reference
"""

import os
import sys
import json
import datetime
from pathlib import Path

import numpy as np
import nibabel as nib
from scipy.ndimage import map_coordinates
from nilearn.datasets import fetch_surf_fsaverage

N_DEPTHS = 11  # same as the forward pass in generate_real_benson.py

ATLASES = [
    {
        "name": "Benson 2014 — Polar Angle",
        "key": "benson14_polar_angle",
        "family": "benson14",
        "mgz": "benson14_angle.v4_0",
        "nii": "benson14_polar_angle.nii.gz",
        "type": "polar_angle",
        "pass_threshold": 10.0,
    },
    {
        "name": "Benson 2014 — Eccentricity",
        "key": "benson14_eccentricity",
        "family": "benson14",
        "mgz": "benson14_eccen.v4_0",
        "nii": "benson14_eccentricity.nii.gz",
        "type": "eccentricity",
        "pass_threshold": 4.0,
    },
    {
        "name": "Benson 2014 — Visual Areas",
        "key": "benson14_visual_areas",
        "family": "benson14",
        "mgz": "benson14_varea.v4_0",
        "nii": "benson14_visual_areas.nii.gz",
        "type": "categorical",
        "labels": list(range(1, 13)),
        "label_names": {
            1: "V1", 2: "V2", 3: "V3", 4: "hV4",
            5: "VO1", 6: "VO2", 7: "LO1", 8: "LO2",
            9: "TO1", 10: "TO2", 11: "V3b", 12: "V3a",
        },
        "pass_threshold": 0.80,
    },
    {
        "name": "Wang 2015 — Max-probability ROIs",
        "key": "wang2015_maxprob",
        "family": "wang2015",
        "mgz": "wang15_mplbl.v1_0",
        "nii": "wang2015_maxprob.nii.gz",
        "type": "categorical",
        "labels": list(range(1, 26)),
        "label_names": {
            1: "V1v", 2: "V1d", 3: "V2v", 4: "V2d", 5: "V3v", 6: "V3d",
            7: "hV4", 8: "VO1", 9: "VO2", 10: "PHC1", 11: "PHC2",
            12: "TO2", 13: "TO1", 14: "LO2", 15: "LO1",
            16: "V3B", 17: "V3A", 18: "IPS0", 19: "IPS1", 20: "IPS2",
            21: "IPS3", 22: "IPS4", 23: "IPS5", 24: "SPL1", 25: "FEF",
        },
        "pass_threshold": 0.75,
    },
]


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _load_surface(path):
    g = nib.load(str(path))
    verts = g.darrays[0].data.astype(np.float32)
    faces = g.darrays[1].data.astype(np.int32) if len(g.darrays) > 1 else None
    return verts, faces


def _load_mgz(path):
    return np.asarray(nib.load(str(path)).dataobj).squeeze().astype(np.float32)


def _back_project(white_verts, pial_verts, vol_data, inv_affine, categorical=False):
    """
    Sample vol_data at N_DEPTHS positions along the cortical ribbon for each vertex.

    white_verts / pial_verts are in MNI mm space (nilearn fsaverage is already MNI152).
    Returns depth_samples of shape (N_DEPTHS, N_verts).
    """
    n_verts = len(white_verts)
    ts = np.linspace(0.0, 1.0, N_DEPTHS, dtype=np.float32)

    # Build all ribbon points in one shot: (N_DEPTHS * N_verts, 3)
    ribbon_pts = np.stack(
        [white_verts + t * (pial_verts - white_verts) for t in ts]
    ).reshape(-1, 3)

    # mm → fractional voxel coords
    ones = np.ones((len(ribbon_pts), 1), dtype=np.float32)
    vox_flat = (inv_affine @ np.hstack([ribbon_pts, ones]).T)[:3]  # (3, N)

    # Mark out-of-bounds before clamping (clamped coords would otherwise sample border voxels)
    sh = np.array(vol_data.shape[:3], dtype=np.float32) - 1
    oob = np.any((vox_flat < 0) | (vox_flat > sh[:, None]), axis=0)

    vox_clamped = np.clip(vox_flat, 0, sh[:, None])
    order = 0 if categorical else 1
    sampled = map_coordinates(
        vol_data.astype(np.float32), vox_clamped,
        order=order, mode="constant", cval=0.0,
    ).astype(np.float32)
    sampled[oob] = 0.0

    return sampled.reshape(N_DEPTHS, n_verts)


# ---------------------------------------------------------------------------
# Aggregation per atlas type
# ---------------------------------------------------------------------------

def _aggregate_polar_angle(depth_samples, hemi):
    """
    Circular mean of non-zero depth samples. Inverts the postprocess_atlases.py
    hemisphere convention before averaging:
      LH: merged values 1–180° are already in source convention
      RH: merged values 180–360°, inverse is 360 – V → 0–180°
    """
    samples = depth_samples.copy()
    if hemi == "rh":
        nz = samples > 0
        samples[nz] = 360.0 - samples[nz]

    nz_mask = samples > 0                               # (N_DEPTHS, N_verts)
    coverage = nz_mask.any(axis=0)                      # (N_verts,)

    # Complex exponential trick for half-circle [0°, 180°]:
    # double angles → full circle → circular mean → halve back
    angles_rad = np.where(nz_mask, np.deg2rad(samples * 2.0), np.nan)
    with np.errstate(invalid="ignore"):
        z = np.nanmean(np.exp(1j * angles_rad), axis=0)  # (N_verts,) complex

    mean_deg = np.rad2deg(np.angle(z)) / 2.0
    mean_deg = np.where(mean_deg < 0, mean_deg + 180.0, mean_deg)
    result = np.where(coverage, mean_deg, 0.0).astype(np.float32)
    return result, coverage


def _aggregate_continuous(depth_samples):
    """Mean of non-zero depth samples."""
    nz_mask = depth_samples > 0
    coverage = nz_mask.any(axis=0)
    nz_count = nz_mask.sum(axis=0).astype(np.float32)
    result = np.where(coverage, depth_samples.sum(axis=0) / np.maximum(nz_count, 1), 0.0)
    return result.astype(np.float32), coverage


def _aggregate_categorical(depth_samples):
    """Majority vote across depths per vertex."""
    int_samples = np.round(depth_samples).astype(np.int32)  # (N_DEPTHS, N_verts)
    n_depths, n_verts = int_samples.shape
    max_label = int(int_samples.max())
    if max_label == 0:
        return np.zeros(n_verts, dtype=np.int32), np.zeros(n_verts, dtype=bool)

    # vote_counts[v, l] = number of depths where vertex v has label l
    vote_counts = np.zeros((n_verts, max_label + 1), dtype=np.int32)
    vertex_idx = np.tile(np.arange(n_verts), n_depths)  # (N_DEPTHS * N_verts,)
    label_vals = int_samples.ravel()
    valid = (label_vals > 0) & (label_vals <= max_label)
    np.add.at(vote_counts, (vertex_idx[valid], label_vals[valid]), 1)

    vote_counts[:, 0] = 0  # exclude background from vote
    coverage = vote_counts.sum(axis=1) > 0
    result = np.where(coverage, vote_counts.argmax(axis=1).astype(np.int32), 0)
    return result, coverage


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _circular_mae_180(pred, true):
    """MAE for half-circle angles in [0°, 180°]."""
    diff = np.abs(pred.astype(float) - true.astype(float))
    diff = np.minimum(diff, 180.0 - diff)
    return float(np.nanmean(diff))


def _pearson_r(a, b):
    if len(a) < 2:
        return None
    try:
        from scipy.stats import pearsonr
        r, _ = pearsonr(a.astype(float), b.astype(float))
        return float(r) if np.isfinite(r) else None
    except Exception:
        return None


def _find_boundary_vertices(labels, faces):
    """Bool mask of surface vertices adjacent to a label boundary."""
    v0, v1, v2 = faces[:, 0], faces[:, 1], faces[:, 2]
    is_bnd = (labels[v0] != labels[v1]) | (labels[v1] != labels[v2]) | (labels[v0] != labels[v2])
    bnd = np.zeros(len(labels), dtype=bool)
    bnd[v0[is_bnd]] = True
    bnd[v1[is_bnd]] = True
    bnd[v2[is_bnd]] = True
    return bnd


# ---------------------------------------------------------------------------
# Per-atlas validation
# ---------------------------------------------------------------------------

def _validate_atlas(atlas, atlas_dir, surfaces, inv_affine):
    nii_path = Path(atlas_dir) / atlas["family"] / atlas["nii"]
    if not nii_path.exists():
        return {"error": f"{atlas['nii']} not found", "pass": False}

    vol = nib.load(str(nii_path)).get_fdata().astype(np.float32)
    atype = atlas["type"]
    categorical = atype == "categorical"
    hemi_res = {}

    for hemi in ("lh", "rh"):
        white_verts, pial_verts, faces = surfaces[hemi]
        mgz_path = Path(atlas_dir) / atlas["family"] / f"{hemi}.{atlas['mgz']}.mgz"
        if not mgz_path.exists():
            hemi_res[hemi] = {"error": f"{mgz_path.name} not found"}
            continue

        source = _load_mgz(mgz_path)              # (N_verts,) in source convention
        valid_source = source > 0

        depth_samples = _back_project(white_verts, pial_verts, vol, inv_affine, categorical=categorical)

        if atype == "polar_angle":
            recon, coverage = _aggregate_polar_angle(depth_samples, hemi)
        elif atype == "eccentricity":
            recon, coverage = _aggregate_continuous(depth_samples)
        else:
            recon, coverage = _aggregate_categorical(depth_samples)

        valid = valid_source & coverage
        n_valid = int(valid.sum())
        if n_valid < 100:
            hemi_res[hemi] = {"error": f"Too few valid vertices ({n_valid})"}
            continue

        cov_pct = round(float(coverage[valid_source].mean() * 100), 1)

        if atype == "polar_angle":
            hemi_res[hemi] = {
                "circular_mae_deg": round(_circular_mae_180(recon[valid], source[valid]), 2),
                "pearson_r": round(r, 4) if (r := _pearson_r(recon[valid], source[valid])) is not None else None,
                "coverage_pct": cov_pct,
                "n_valid": n_valid,
            }

        elif atype == "eccentricity":
            mae = float(np.mean(np.abs(recon[valid] - source[valid])))
            hemi_res[hemi] = {
                "mae_deg": round(mae, 2),
                "pearson_r": round(r, 4) if (r := _pearson_r(recon[valid], source[valid])) is not None else None,
                "coverage_pct": cov_pct,
                "n_valid": n_valid,
            }

        else:  # categorical
            src_int = source[valid].astype(np.int32)
            acc = float(np.mean(recon[valid] == src_int))
            label_names = atlas.get("label_names", {})
            per_label = {}
            for lbl in atlas["labels"]:
                lbl_mask = (source == lbl) & valid
                if lbl_mask.sum() > 0:
                    lbl_acc = float(np.mean(recon[lbl_mask] == lbl))
                    per_label[label_names.get(lbl, str(lbl))] = round(lbl_acc, 3)

            bnd_acc = None
            if faces is not None:
                bnd = _find_boundary_vertices(source.astype(np.int32), faces)
                bnd_valid = bnd & valid
                if bnd_valid.sum() > 10:
                    bnd_acc = round(float(np.mean(recon[bnd_valid] == source[bnd_valid].astype(np.int32))), 4)

            hemi_res[hemi] = {
                "overall_accuracy": round(acc, 4),
                "boundary_accuracy": bnd_acc,
                "per_label_accuracy": per_label,
                "coverage_pct": cov_pct,
                "n_valid": n_valid,
            }

    # Compute aggregate pass/fail
    rt = {"lh": hemi_res.get("lh", {}), "rh": hemi_res.get("rh", {})}

    if atype == "polar_angle":
        vals = [v["circular_mae_deg"] for v in rt.values() if isinstance(v, dict) and "circular_mae_deg" in v]
        mean = round(float(np.mean(vals)), 2) if vals else None
        rt["mean_circular_mae_deg"] = mean
        rt["pass"] = mean is not None and mean < atlas["pass_threshold"]
        rt["pass_threshold_deg"] = atlas["pass_threshold"]

    elif atype == "eccentricity":
        vals = [v["mae_deg"] for v in rt.values() if isinstance(v, dict) and "mae_deg" in v]
        mean = round(float(np.mean(vals)), 2) if vals else None
        rt["mean_mae_deg"] = mean
        rt["pass"] = mean is not None and mean < atlas["pass_threshold"]
        rt["pass_threshold_deg"] = atlas["pass_threshold"]

    else:
        vals = [v["overall_accuracy"] for v in rt.values() if isinstance(v, dict) and "overall_accuracy" in v]
        mean = round(float(np.mean(vals)), 4) if vals else None
        rt["mean_overall_accuracy"] = mean
        rt["pass"] = mean is not None and mean >= atlas["pass_threshold"]
        rt["pass_threshold_accuracy"] = atlas["pass_threshold"]

    return {"round_trip": rt}


# ---------------------------------------------------------------------------
# neuropythy reference (C)
# ---------------------------------------------------------------------------

def _run_neuropythy_checks(atlas_dir, surfaces):
    """
    Compare source .mgz files and (if already computed) back-projected values
    against neuropythy's canonical benson14 predictions for fsaverage.
    """
    try:
        import neuropythy as ny
        sub = ny.subject("fsaverage")
        lh_pred, rh_pred = ny.predict_retinotopy(sub, template="benson14", registration="fsaverage")
    except ImportError:
        return {"available": False, "reason": "neuropythy not installed"}
    except Exception as e:
        return {"available": False, "reason": str(e)}

    checks = {"available": True}
    pred_map = {"lh": lh_pred, "rh": rh_pred}

    for atlas in ATLASES:
        atype = atlas["type"]
        atlas_checks = {}

        for hemi in ("lh", "rh"):
            mgz_path = Path(atlas_dir) / atlas["family"] / f"{hemi}.{atlas['mgz']}.mgz"
            if not mgz_path.exists():
                continue
            source = _load_mgz(mgz_path)
            pred = pred_map[hemi]

            if atype == "polar_angle" and "angle" in pred:
                npy_vals = np.asarray(pred["angle"], dtype=np.float32)
                if len(npy_vals) != len(source):
                    atlas_checks[f"{hemi}_note"] = f"vertex count mismatch: source={len(source)}, neuropythy={len(npy_vals)}"
                    continue
                valid = (source > 0) & (npy_vals > 0)
                if valid.sum() > 100:
                    mae = _circular_mae_180(source[valid], npy_vals[valid])
                    atlas_checks[f"{hemi}_source_vs_npy_mae_deg"] = round(mae, 2)

            elif atype == "eccentricity" and "eccen" in pred:
                npy_vals = np.asarray(pred["eccen"], dtype=np.float32)
                if len(npy_vals) != len(source):
                    continue
                valid = (source > 0) & (npy_vals > 0)
                if valid.sum() > 100:
                    mae = float(np.mean(np.abs(source[valid] - npy_vals[valid])))
                    atlas_checks[f"{hemi}_source_vs_npy_mae_deg"] = round(mae, 2)

            elif atype == "categorical" and "varea" in pred:
                npy_vals = np.asarray(pred["varea"], dtype=np.int32)
                if len(npy_vals) != len(source):
                    continue
                valid = (source > 0) & (npy_vals > 0)
                if valid.sum() > 100:
                    acc = float(np.mean(source[valid].astype(np.int32) == npy_vals[valid]))
                    atlas_checks[f"{hemi}_source_vs_npy_accuracy"] = round(acc, 4)

        if atlas_checks:
            checks[atlas["key"]] = atlas_checks

    return checks


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(atlas_dir):
    """
    Run round-trip + neuropythy validation. Returns a JSON-serialisable dict.
    atlas_dir: Path or str pointing to the directory containing .nii.gz and .mgz files.
    """
    atlas_dir = Path(atlas_dir)
    print(f"[round_trip] atlas_dir={atlas_dir}")

    print("[round_trip] fetching fsaverage surfaces…")
    fs = fetch_surf_fsaverage("fsaverage")
    surfaces = {
        "lh": (*_load_surface(fs.white_left),),   # (white_verts, faces)
        "rh": (*_load_surface(fs.white_right),),
    }
    # Unpack separately for pial
    pial = {
        "lh": _load_surface(fs.pial_left)[0],
        "rh": _load_surface(fs.pial_right)[0],
    }
    # Rebuild with (white, pial, faces) tuples
    surfaces = {
        hemi: (surfaces[hemi][0], pial[hemi], surfaces[hemi][1])
        for hemi in ("lh", "rh")
    }

    # Compute inverse affine from any atlas volume (they all share MNI152 space)
    ref_vol_path = atlas_dir / "benson14" / "benson14_polar_angle.nii.gz"
    if not ref_vol_path.exists():
        # Atlases live one folder per family under atlas_dir.
        ref_vol_path = next(iter(sorted(atlas_dir.glob("*/*.nii.gz"))), None)
    if ref_vol_path is None:
        return {"error": "No .nii.gz atlas files found", "atlases": {}}
    inv_affine = np.linalg.inv(nib.load(str(ref_vol_path)).affine).astype(np.float32)

    # Validate each atlas
    results = {}
    for atlas in ATLASES:
        print(f"[round_trip] validating {atlas['key']}…")
        results[atlas["key"]] = {
            "name": atlas["name"],
            **_validate_atlas(atlas, atlas_dir, surfaces, inv_affine),
        }

    # neuropythy reference (C) — optional
    print("[round_trip] running neuropythy reference check…")
    npy_result = _run_neuropythy_checks(atlas_dir, surfaces)

    return {
        "run_timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "pipeline_params": {"n_depths": N_DEPTHS, "radius_mm": 3.0},
        "atlases": results,
        "neuropythy_reference": npy_result,
    }


if __name__ == "__main__":
    atlas_dir = sys.argv[1] if len(sys.argv) > 1 else "data/modules/atlases"
    report = run(atlas_dir)
    print(json.dumps(report, indent=2))
