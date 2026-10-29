"""Structural checks for the LNM connectome bundle slot (module_slots.py).

The big arrays are checked from their .npy headers only (decompressing them over
a network share made every module-status call take ~15 s), so these tests pin
that the verdicts are unchanged: a good bundle passes with the right details,
and each inconsistency is still caught.
"""
import os
import time

import numpy as np
import pytest

import module_slots
from module_slots import _NpzShape, validate_lnm_bundle


def _bundle(path, *, V=10, D=3, N=4, rows=None, covs_shape=None, compressed=True):
    grid = (4, 4, 4)
    mask = np.zeros(grid, dtype=bool)
    mask.flat[:V] = True
    arrays = dict(
        A=np.random.default_rng(0).normal(size=(rows if rows is not None else V, D)).astype(np.float32),
        mask=mask,
        affine=np.eye(4),
        grid=np.array(grid),
        covs=np.zeros(covs_shape or (N, D, D), dtype=np.float32),
        G=np.eye(D),
        dim=np.array(D),
    )
    (np.savez_compressed if compressed else np.savez)(path, **arrays)
    return path


def test_good_bundle_passes_with_details(tmp_path):
    ok, reason, details = validate_lnm_bundle(_bundle(tmp_path / "b.npz"))
    assert ok, reason
    assert details == {"subjects": 4, "components": 3, "voxels": 10, "grid": [4, 4, 4]}


def test_uncompressed_bundle_passes_too(tmp_path):
    ok, reason, _ = validate_lnm_bundle(_bundle(tmp_path / "b.npz", compressed=False))
    assert ok, reason


def test_rows_that_disagree_with_the_mask_are_caught(tmp_path):
    ok, reason, _ = validate_lnm_bundle(_bundle(tmp_path / "b.npz", rows=9))
    assert not ok and "'mask' selects 10 voxels but 'A' has 9 rows" in reason


def test_wrong_covariance_shape_is_caught(tmp_path):
    ok, reason, _ = validate_lnm_bundle(_bundle(tmp_path / "b.npz", covs_shape=(4, 3, 2)))
    assert not ok and "'covs' is (4, 3, 2)" in reason


def test_shape_comes_from_the_header(tmp_path):
    path = _bundle(tmp_path / "b.npz", V=10, D=3)
    z = np.load(path)
    try:
        assert _NpzShape(z, "A").shape == (10, 3)
        assert _NpzShape(z, "covs").ndim == 3
    finally:
        z.close()


def test_verdict_is_cached_until_the_file_changes(tmp_path):
    check = module_slots.VALIDATORS["lnm-bundle"]
    path = _bundle(tmp_path / "b.npz")
    first = check(path)
    assert check(path) is first                     # unchanged file: same verdict, no re-read
    _bundle(path, rows=9)                           # rewrite with a different size/mtime
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    second = check(path)
    assert second is not first and not second[0]
