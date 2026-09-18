#!/usr/bin/env python3
"""
prepare_connectome.py  --  run ONCE, offline.

Collapses the HCP S1200 PTN release (a chosen ICA dimensionality) into a single
compact .npz bundle for volumetric lesion network mapping (LNM). The bundle holds
the volumetric group-ICA spatial basis + a per-subject covariance stack, so the
runtime backend never touches the raw timeseries again.

Requires the groupICA and NodeTimeseries tars to be EXTRACTED on disk.

Example:
    python prepare_connectome.py --root "Z:\\HCP unzipped\\HCP1200_Parcellation_Timeseries_Netmats\\HCP_PTN1200" --dim 100

Dependencies:  numpy, nibabel   (pip install numpy nibabel)
"""
import argparse, glob, os, sys
import numpy as np
import nibabel as nib

# --- EDIT THESE if you just want to press Run (no command-line needed) ------- #
DEFAULT_ROOT = r"Z:\HCP unzipped\HCP1200_Parcellation_Timeseries_Netmats\HCP_PTN1200"
DEFAULT_DIM = 100
# ---------------------------------------------------------------------------- #


def find_one(pattern):
    hits = sorted(glob.glob(pattern))
    if not hits:
        raise FileNotFoundError(f"No match for:\n  {pattern}")
    if len(hits) > 1:
        print("[warn] multiple matches, using first:\n  " + "\n  ".join(hits))
    return hits[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT,
                    help=r"...\HCP1200_Parcellation_Timeseries_Netmats\HCP_PTN1200")
    ap.add_argument("--dim", type=int, default=DEFAULT_DIM,
                    choices=[15, 25, 50, 100, 200, 300])
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    D, root = args.dim, args.root
    out = args.out or os.path.join(root, f"lnm_bundle_d{D}.npz")

    # 1) volumetric group-ICA spatial maps (MNI152), 4D: X, Y, Z, D --------------
    ica_path = find_one(os.path.join(
        root, "groupICA*", "groupICA", f"*_d{D}.ica", "melodic_IC_sum.nii.gz"))
    print(f"[ica] {ica_path}")
    img = nib.load(ica_path)
    vol = np.asarray(img.get_fdata(dtype=np.float32))
    if vol.ndim != 4 or vol.shape[3] != D:
        print(f"[warn] expected 4D with {D} comps, got shape {vol.shape}")
    X, Y, Z, Dv = vol.shape
    A_full = vol.reshape(-1, Dv)
    mask = np.any(A_full != 0, axis=1)          # brain voxels with any signal
    A = np.ascontiguousarray(A_full[mask], dtype=np.float32)   # V x D
    print(f"[ica] grid={vol.shape[:3]}  brain_voxels={A.shape[0]}  D={Dv}")

    # 2) per-subject node timeseries -> per-subject covariance (D x D) ------------
    ts_dir = find_one(os.path.join(
        root, f"NodeTimeseries*ICAd{D}_ts2*", "node_timeseries", f"*_d{D}_ts2"))
    ts_files = sorted(glob.glob(os.path.join(ts_dir, "*.txt")))
    if not ts_files:
        sys.exit(f"[error] no node-timeseries .txt found in:\n  {ts_dir}\n"
                 f"        Extract NodeTimeseries_*ICAd{D}_ts2.tar first.")
    print(f"[ts ] {len(ts_files)} subjects in {ts_dir}")

    covs = np.zeros((len(ts_files), Dv, Dv), dtype=np.float32)
    for i, f in enumerate(ts_files):
        t = np.loadtxt(f, dtype=np.float32)     # T x D (concatenated runs)
        if t.ndim == 1:
            t = t[:, None]
        t -= t.mean(0, keepdims=True)
        covs[i] = (t.T @ t) / (t.shape[0] - 1)
        if (i + 1) % 100 == 0 or (i + 1) == len(ts_files):
            print(f"      {i + 1}/{len(ts_files)}")

    G = covs.mean(0).astype(np.float32)         # group covariance (for degree)

    np.savez_compressed(
        out, A=A, mask=mask.reshape(X, Y, Z), affine=img.affine,
        grid=np.array([X, Y, Z]), covs=covs, G=G, dim=Dv,
    )
    print(f"[done] {out}  ({os.path.getsize(out) / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
