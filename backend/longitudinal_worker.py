#!/usr/bin/env python
"""Isolated worker: longitudinal comparison (SimpleITK affine registration +
voxel-wise difference map).

SimpleITK is a one-click module (longitudinal-simpleitk). Running it here, not
in the server, keeps it out of the server process: Windows locks a loaded
module's compiled files until the process that loaded it exits, so once this
worker is done nothing holds them and the module store can remove the module
at once. While it runs, the server counts SimpleITK as in use
(deps.WORKER_PACKAGES).

Usage: python longitudinal_worker.py <config_json_path>
Config: baseline, followup, out (NIfTI paths); sys_path (module folders).
Output: one JSON line on stdout (the change metrics); traceback to stderr.
"""
import json
import sys
from pathlib import Path


def _run_longitudinal(baseline_path: Path, followup_path: Path, out_path: Path):
    import SimpleITK as sitk
    import numpy as np

    fixed = sitk.ReadImage(str(baseline_path), sitk.sitkFloat32)
    moving = sitk.ReadImage(str(followup_path), sitk.sitkFloat32)

    same_grid = (
        fixed.GetSize() == moving.GetSize()
        and fixed.GetSpacing() == moving.GetSpacing()
    )
    if same_grid:
        resampled = moving
        metric = 0.0
    else:
        reg = sitk.ImageRegistrationMethod()
        reg.SetMetricAsMattesMutualInformation(numberOfHistogramBins=32)
        reg.SetMetricSamplingStrategy(reg.RANDOM)
        reg.SetMetricSamplingPercentage(0.1)
        reg.SetInterpolator(sitk.sitkLinear)
        reg.SetOptimizerAsRegularStepGradientDescent(2.0, 1e-4, 200)
        reg.SetOptimizerScalesFromPhysicalShift()
        init = sitk.CenteredTransformInitializer(
            fixed, moving, sitk.AffineTransform(3),
            sitk.CenteredTransformInitializerFilter.GEOMETRY,
        )
        reg.SetInitialTransform(init, inPlace=False)
        transform = reg.Execute(fixed, moving)
        metric = float(reg.GetMetricValue())
        resampled = sitk.Resample(
            moving, fixed, transform, sitk.sitkLinear, 0.0, sitk.sitkFloat32
        )

    a = sitk.GetArrayFromImage(fixed)
    b = sitk.GetArrayFromImage(resampled)
    diff = b - a
    diff_img = sitk.GetImageFromArray(diff)
    diff_img.CopyInformation(fixed)
    sitk.WriteImage(diff_img, str(out_path))

    rng = float(np.percentile(np.abs(a), 99)) or 1.0
    changed = float(np.count_nonzero(np.abs(diff) > 0.1 * rng))
    nonzero_base = float(np.count_nonzero(a > 0.05 * rng)) or 1.0
    return {
        "registration_metric": metric,
        "same_grid": same_grid,
        "changed_voxel_pct": round(100.0 * changed / nonzero_base, 2),
    }


def main():
    # stdout carries only the JSON result line; everything else goes to stderr.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    cfg = json.loads(Path(sys.argv[1]).read_text())
    # The module folders (see worker_common.extra_sys_path_for_worker); before
    # SimpleITK is imported.
    for p in cfg.get("sys_path") or []:
        if p not in sys.path:
            sys.path.insert(0, p)
    metrics = _run_longitudinal(Path(cfg["baseline"]), Path(cfg["followup"]), Path(cfg["out"]))
    real_stdout.write(json.dumps(metrics) + "\n")
    real_stdout.flush()


if __name__ == "__main__":
    main()
