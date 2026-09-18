"""Differential test: vendored `worker_common.resample_to_img` vs nilearn's.

Phase 1b removes `nilearn` (+ its hard pandas/scikit-learn deps) from the core
install by vendoring the single symbol the workers use. This file is the gate
on that swap: it drives BOTH implementations over the geometries the nine real
call sites exercise and asserts the outputs are bit-identical
(`np.array_equal`, not `allclose`) with equal affines and equal dtypes.

Deliberately NOT built on the 673 MB tractogram or the full dissection
pipeline: that is slow and tests the wrong layer. Every case here is a direct
`resample_to_img(source, target, interpolation=...)` call.

Cases cover, per the call sites:
  * `interpolation='nearest'` (what all nine sites pass) and the `'continuous'`
    default, plus `'linear'`;
  * source and target on different grids/shapes, isotropic and anisotropic;
  * target grid a strict subset and a strict superset of the source extent
    (out-of-bounds must fill 0);
  * pure integer-voxel translation on a shared voxel size — the real
    lesion -> tractogram-grid geometry, and the one case where nilearn's
    `force_resample=False` "padding optimization" kicks in;
  * oblique (rotated, non-diagonal) affines;
  * negative-determinant (radiological) affines;
  * integer LABEL volumes, incl. real shipped atlases — nearest-neighbour must
    not invent label values that are absent from the input;
  * 4D source volumes (the tractography atlases);
  * the degenerate identical-affine-and-shape no-op;
  * dtype preservation across int16/int32/uint8/float32/float64.

Run: python -m pytest backend/tests/test_resample_parity.py -v
"""
import sys
import warnings
from pathlib import Path

import numpy as np
import pytest

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

nib = pytest.importorskip("nibabel")
nilearn_image = pytest.importorskip("nilearn.image")

from worker_common import resample_to_img as vendored  # noqa: E402

nilearn_resample = nilearn_image.resample_to_img

# Where the shipped atlases live. Mirrors backend/deps.py's ATLAS_DIR
# resolution (under the module root) but without importing deps.py, which has
# server-side side effects at import.
_REPO = BACKEND.parent
ATLAS_DIRS = [_REPO / "data" / "modules" / "atlases"]


def _atlas(name):
    for d in ATLAS_DIRS:
        p = d / name
        if p.exists():
            return p
    return None


# --------------------------------------------------------------------------- #
#  Fixture builders
# --------------------------------------------------------------------------- #
def _img(data, affine):
    return nib.Nifti1Image(np.asarray(data), np.asarray(affine, dtype=float))


def _grid(shape, affine, dtype=np.int16, seed=0, labels=None):
    """Deterministic synthetic volume on a given grid."""
    rng = np.random.default_rng(seed)
    if labels is not None:
        data = rng.choice(np.asarray(labels), size=shape).astype(dtype)
    elif np.dtype(dtype).kind in "iu":
        data = rng.integers(0, 97, size=shape).astype(dtype)
    else:
        data = rng.random(shape).astype(dtype) * 100.0
    return _img(data, affine)


def _aff(zooms, origin, rot=None, flip_x=False):
    a = np.eye(4)
    m = np.diag(np.asarray(zooms, dtype=float))
    if flip_x:
        m[0, 0] = -m[0, 0]
    if rot is not None:
        th = np.deg2rad(rot)
        r = np.array([[np.cos(th), -np.sin(th), 0.0],
                      [np.sin(th), np.cos(th), 0.0],
                      [0.0, 0.0, 1.0]])
        m = r @ m
    a[:3, :3] = m
    a[:3, 3] = origin
    return a


# Common source used by most geometry cases: 1 mm isotropic, 40x36x32.
SRC_1MM = dict(shape=(40, 36, 32), affine=_aff((1, 1, 1), (-20, -18, -16)))


def _cases():
    """(id, source_img, target_img) tuples."""
    c = []

    src1 = _grid(SRC_1MM["shape"], SRC_1MM["affine"], seed=1)

    # 1. downsample onto a coarser, offset grid
    c.append(("downsample_1mm_to_2mm", src1,
              _img(np.zeros((22, 20, 18), np.int16),
                   _aff((2, 2, 2), (-21, -19, -17)))))

    # 2. upsample onto a finer grid
    c.append(("upsample_1mm_to_0p5mm", src1,
              _img(np.zeros((50, 44, 40), np.int16),
                   _aff((0.5, 0.5, 0.5), (-12.25, -11.75, -9.5)))))

    # 3. anisotropic source -> anisotropic target
    src_aniso = _grid((30, 26, 14), _aff((1.0, 1.2, 3.0), (-15, -16, -21)), seed=2)
    c.append(("anisotropic_to_anisotropic", src_aniso,
              _img(np.zeros((24, 30, 22), np.int16),
                   _aff((2.5, 1.7, 0.9), (-16.3, -15.4, -9.1)))))

    # 4. target grid strictly INSIDE the source extent (no fill needed)
    c.append(("target_subset_of_source", src1,
              _img(np.zeros((12, 10, 9), np.int16),
                   _aff((1, 1, 1), (-8, -6, -5)))))

    # 5. target grid strictly OUTSIDE/AROUND the source (out-of-bounds -> 0)
    c.append(("target_superset_of_source", src1,
              _img(np.zeros((60, 56, 52), np.int16),
                   _aff((1, 1, 1), (-30, -28, -26)))))

    # 6. pure integer-voxel translation, identical voxel size. This is the real
    #    lesion -> tractogram-grid geometry AND the trigger for nilearn's
    #    force_resample=False padding shortcut.
    c.append(("integer_translation_same_zooms", src1,
              _img(np.zeros((44, 40, 36), np.int16),
                   _aff((1, 1, 1), (-23, -21, -19)))))

    # 7. sub-voxel (half-voxel) translation — no shortcut, real interpolation
    c.append(("half_voxel_translation", src1,
              _img(np.zeros((40, 36, 32), np.int16),
                   _aff((1, 1, 1), (-20.5, -18.5, -16.5)))))

    # 8. oblique (rotated, non-diagonal) TARGET affine
    c.append(("oblique_target_affine", src1,
              _img(np.zeros((30, 28, 26), np.int16),
                   _aff((1.3, 1.3, 1.3), (-19, -17, -15), rot=23.0))))

    # 9. oblique SOURCE affine
    src_obl = _grid((34, 30, 28), _aff((1.1, 1.1, 1.4), (-18, -16, -19), rot=-17.0), seed=3)
    c.append(("oblique_source_affine", src_obl,
              _img(np.zeros((26, 24, 22), np.int16),
                   _aff((1.5, 1.5, 1.5), (-19, -17, -16)))))

    # 10. negative-determinant (radiological, LAS) source onto a neurological
    #     target — the orientation flip most likely to be silently mishandled
    src_rad = _grid((36, 34, 30), _aff((1, 1, 1), (18, -17, -15), flip_x=True), seed=4)
    c.append(("radiological_source_to_neurological_target", src_rad,
              _img(np.zeros((30, 28, 26), np.int16),
                   _aff((1.2, 1.2, 1.2), (-17, -16, -14)))))

    # 11. neurological source onto a radiological target
    c.append(("neurological_source_to_radiological_target", src1,
              _img(np.zeros((28, 26, 24), np.int16),
                   _aff((1.4, 1.4, 1.4), (19, -18, -16), flip_x=True))))

    # 12. both oblique AND negative determinant
    src_ro = _grid((30, 28, 26), _aff((1.1, 1.1, 1.1), (16, -15, -14),
                                      rot=11.0, flip_x=True), seed=5)
    c.append(("oblique_negative_determinant", src_ro,
              _img(np.zeros((26, 24, 22), np.int16),
                   _aff((1.3, 1.3, 1.3), (-16, -15, -14), rot=-7.0))))

    # 13. sparse integer LABEL volume (the highest-risk payload: interpolating
    #     labels invents values that do not exist)
    src_lab = _grid((32, 30, 28), _aff((2, 2, 2), (-32, -30, -28)),
                    dtype=np.int32, seed=6, labels=[0, 1, 2, 5, 8, 13, 21, 48])
    c.append(("integer_label_volume", src_lab,
              _img(np.zeros((26, 24, 22), np.int16),
                   _aff((2.4, 2.4, 2.4), (-31, -29, -27)))))

    # 14. 4D source (tractography atlases are 4D stacks of binary masks)
    src4d = _grid((20, 18, 16, 3), _aff((2, 2, 2), (-20, -18, -16)),
                  dtype=np.int16, seed=7, labels=[0, 1])
    c.append(("source_4d_stack", src4d,
              _img(np.zeros((18, 16, 14), np.int16),
                   _aff((2.2, 2.2, 2.2), (-19, -17, -15)))))

    # 15. binary lesion-style mask (uint8 0/1), the dissect-worker payload
    src_mask = _grid((36, 34, 30), _aff((1, 1, 1), (-18, -17, -15)),
                     dtype=np.uint8, seed=8, labels=[0, 0, 0, 1])
    c.append(("binary_mask_uint8", src_mask,
              _img(np.zeros((40, 38, 34), np.int16),
                   _aff((0.9, 0.9, 0.9), (-18.4, -17.2, -15.3)))))

    # 16. float32 continuous data (a density/statistic map)
    src_f32 = _grid((28, 26, 24), _aff((2, 2, 2), (-28, -26, -24)),
                    dtype=np.float32, seed=9)
    c.append(("float32_statistic_map", src_f32,
              _img(np.zeros((24, 22, 20), np.int16),
                   _aff((2.3, 2.3, 2.3), (-27, -25, -23)))))

    # 17. float64
    src_f64 = _grid((24, 22, 20), _aff((2, 2, 2), (-24, -22, -20)),
                    dtype=np.float64, seed=10)
    c.append(("float64_statistic_map", src_f64,
              _img(np.zeros((20, 18, 16), np.int16),
                   _aff((2.6, 2.6, 2.6), (-23, -21, -19)))))

    return c


CASES = _cases()
CASE_IDS = [c[0] for c in CASES]


# Real shipped atlases (the actual `ho_overlap` / retinotopy payloads).
# Paths are relative to ATLAS_DIR, which is grouped one folder per atlas family.
REAL_ATLASES = ["harvard_oxford/harvard_oxford_cort.nii.gz",
                "jhu/jhu_wm_atlas.nii.gz",
                "juelich/juelich_atlas.nii.gz",
                "aal/aal_atlas.nii.gz"]


def _real_case(name):
    p = _atlas(name)
    if p is None:
        pytest.skip(f"atlas {name} not present")
    src = nib.load(str(p))
    # Target: an offset, slightly-rescaled grid — i.e. exactly what
    # `resample_to_img(atlas_img, dm_img)` faces when the density map lives on
    # the tractogram's own grid rather than the atlas's.
    aff = src.affine.copy()
    aff[:3, :3] = aff[:3, :3] * 1.1
    aff[:3, 3] = aff[:3, 3] + np.array([1.5, -2.5, 3.5])
    shape = tuple(max(4, int(s * 0.9)) for s in src.shape[:3])
    return src, _img(np.zeros(shape, np.int16), aff)


# --------------------------------------------------------------------------- #
#  Comparison helper
# --------------------------------------------------------------------------- #
def _data(img):
    return np.asanyarray(img.dataobj)


def _compare(src, tgt, interpolation, force_resample):
    """Run both implementations and assert bit-for-bit parity."""
    with warnings.catch_warnings():
        # nilearn warns about int->float casts and binary+continuous combos;
        # neither changes the numbers, and both are expected in these cases.
        warnings.simplefilter("ignore")
        ref = nilearn_resample(src, tgt, interpolation=interpolation,
                               copy_header=True, force_resample=force_resample)
        got = vendored(src, tgt, interpolation=interpolation,
                       copy_header=True, force_resample=force_resample)

    ref_d, got_d = _data(ref), _data(got)
    assert got_d.shape == ref_d.shape, (
        f"shape: vendored {got_d.shape} != nilearn {ref_d.shape}")
    assert got_d.dtype == ref_d.dtype, (
        f"dtype: vendored {got_d.dtype} != nilearn {ref_d.dtype}")
    assert np.allclose(got.affine, ref.affine), (
        f"affine differs by {np.abs(got.affine - ref.affine).max()}")
    if not np.array_equal(got_d, ref_d):
        diff = got_d.astype(np.float64) - ref_d.astype(np.float64)
        n = int(np.count_nonzero(diff))
        raise AssertionError(
            f"data differs in {n}/{diff.size} voxels "
            f"({100.0 * n / diff.size:.4f}%), max |delta| = "
            f"{np.abs(diff).max()}")
    return got, ref


# --------------------------------------------------------------------------- #
#  Parity — nilearn's real resampling path (force_resample=True)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("interpolation", ["nearest", "continuous", "linear"])
@pytest.mark.parametrize("name,src,tgt", CASES, ids=CASE_IDS)
def test_parity_force_resample_true(name, src, tgt, interpolation):
    """Bit-for-bit parity against nilearn's always-resample path.

    This is the semantics the vendored function implements, and the semantics
    nilearn itself makes the default in 0.13.
    """
    _compare(src, tgt, interpolation, force_resample=True)


# --------------------------------------------------------------------------- #
#  Parity — nilearn's padding-optimized path (force_resample=False)
# --------------------------------------------------------------------------- #
# Five of the nine call sites pass force_resample=False (worker_common x2,
# dissect_worker, dissect_between_worker, summary_render_worker); the four in
# lnm_backend pass force_resample=True. force_resample=False lets nilearn
# replace the resampling with a crop-and-paste whenever the voxel-to-voxel
# matrix is the identity and the translation is integral. nilearn is retiring
# that shortcut in 0.13 precisely because it is not equivalent.
def test_nilearn_force_resample_false_is_wrong_and_vendored_is_right():
    """The bug that motivated flipping all five call sites to force_resample=True.

    Do NOT assert vendored-vs-nilearn parity for force_resample=False: nilearn is
    the one that is wrong there, so parity would mean reproducing a defect. This
    pins the truth instead.

    A pure integer translation with matching zooms makes the correct answer
    computable directly - target voxel i comes from source voxel i+offset - so
    neither implementation is being trusted as the reference.
    """
    src_arr = np.random.RandomState(1).randint(0, 5, size=(80, 90, 70)).astype(np.int16)
    sa = np.eye(4); sa[:3, 3] = [-40.0, -50.0, -30.0]
    ta = np.eye(4); ta[:3, 3] = [-20.0, -25.0, -15.0]
    off = np.array([20, 25, 15])          # (ta - sa) translation, in voxels
    truth = src_arr[off[0]:off[0] + 30, off[1]:off[1] + 35, off[2]:off[2] + 25]

    src = _img(src_arr, sa)
    tgt = _img(np.zeros((30, 35, 25), np.int16), ta)
    kw = dict(interpolation="nearest", copy_header=True)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        vendored_false = _data(vendored(src, tgt, force_resample=False, **kw))
        vendored_true = _data(vendored(src, tgt, force_resample=True, **kw))
        nilearn_false = _data(nilearn_resample(src, tgt, force_resample=False, **kw))
        nilearn_true = _data(nilearn_resample(src, tgt, force_resample=True, **kw))

    # The vendored resampler ignores force_resample and is correct either way.
    assert np.array_equal(vendored_true, truth)
    assert np.array_equal(vendored_false, truth)
    # nilearn is correct only when the shortcut is disabled.
    assert np.array_equal(nilearn_true, truth)
    wrong = int(np.count_nonzero(nilearn_false != truth))
    assert wrong > 0.5 * truth.size, (
        "nilearn's force_resample=False shortcut appears to have been fixed "
        f"({wrong}/{truth.size} voxels wrong). If nilearn now agrees with ground "
        "truth, this test and the warnings at the five call sites can be relaxed.")


# --------------------------------------------------------------------------- #
#  Parity on the real shipped atlases
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("atlas_name", REAL_ATLASES)
def test_parity_real_atlas_nearest(atlas_name):
    """The `ho_overlap` / retinotopy payload: a real integer atlas resampled
    onto a foreign grid with nearest-neighbour."""
    src, tgt = _real_case(atlas_name)
    _compare(src, tgt, "nearest", force_resample=False)
    _compare(src, tgt, "nearest", force_resample=True)


# --------------------------------------------------------------------------- #
#  Label integrity — the highest-risk property
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("force_resample", [True, False])
def test_nearest_never_invents_labels(force_resample):
    """Nearest-neighbour output labels must be a SUBSET of the input labels
    (plus the 0 fill). Anything else means a region id that does not exist in
    the atlas ends up in an overlap table."""
    labels = [0, 1, 2, 5, 8, 13, 21, 48]
    src = _grid((32, 30, 28), _aff((2, 2, 2), (-32, -30, -28)),
                dtype=np.int32, seed=6, labels=labels)
    tgt = _img(np.zeros((40, 38, 36), np.int16),
               _aff((1.7, 1.7, 1.7), (-34, -32, -30)))
    got = vendored(src, tgt, interpolation="nearest",
                   force_resample=force_resample, copy_header=True)
    out = set(np.unique(_data(got)).tolist())
    allowed = set(labels) | {0}
    assert out <= allowed, f"invented labels: {sorted(out - allowed)}"


def test_real_atlas_nearest_never_invents_labels():
    src, tgt = _real_case("harvard_oxford/harvard_oxford_cort.nii.gz")
    got = vendored(src, tgt, interpolation="nearest", copy_header=True)
    src_labels = set(np.unique(_data(src)).tolist())
    out_labels = set(np.unique(_data(got)).tolist())
    assert out_labels <= (src_labels | {0}), (
        f"invented labels: {sorted(out_labels - src_labels - {0})}")


def test_continuous_on_labels_does_invent_values():
    """Guard on the documented hazard: this is WHY every call site passes
    nearest. If this ever stops being true the call sites' rationale changed."""
    labels = [0, 1, 2, 5, 8, 13, 21, 48]
    src = _grid((32, 30, 28), _aff((2, 2, 2), (-32, -30, -28)),
                dtype=np.int32, seed=6, labels=labels)
    tgt = _img(np.zeros((40, 38, 36), np.int16),
               _aff((1.7, 1.7, 1.7), (-34, -32, -30)))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        got = vendored(src, tgt, interpolation="continuous", copy_header=True)
    out = set(np.unique(np.round(_data(got)).astype(int)).tolist())
    assert not out <= (set(labels) | {0})


# --------------------------------------------------------------------------- #
#  Out-of-bounds fill
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("interpolation", ["nearest", "continuous", "linear"])
def test_out_of_bounds_fills_zero(interpolation):
    """A target voxel outside the source FOV must be 0, in both
    implementations."""
    src = _grid((16, 16, 16), _aff((1, 1, 1), (-8, -8, -8)),
                dtype=np.int16, seed=11)
    # Every value in the source is >= 1 so any 0 in the output is fill.
    data = np.maximum(_data(src), 1).astype(np.int16)
    src = _img(data, src.affine)
    tgt = _img(np.zeros((40, 40, 40), np.int16), _aff((1, 1, 1), (-20, -20, -20)))
    got, ref = _compare(src, tgt, interpolation, force_resample=True)
    g = _data(got)
    assert g[0, 0, 0] == 0 and g[-1, -1, -1] == 0
    assert np.count_nonzero(g == 0) > 0


# --------------------------------------------------------------------------- #
#  Degenerate no-op
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("interpolation", ["nearest", "continuous", "linear"])
def test_identical_grid_is_passthrough(interpolation):
    """Identical affine AND identical shape must not touch the data at all."""
    src = _grid((20, 18, 16), _aff((1.5, 1.5, 1.5), (-15, -13, -12)),
                dtype=np.int16, seed=12)
    tgt = _img(np.zeros(src.shape, np.int16), src.affine.copy())
    got = vendored(src, tgt, interpolation=interpolation, copy_header=True)
    assert np.array_equal(_data(got), _data(src))
    assert np.array_equal(got.affine, src.affine)
    assert _data(got).dtype == _data(src).dtype
    # ...and matches nilearn's own no-op result.
    _compare(src, tgt, interpolation, force_resample=True)
    _compare(src, tgt, interpolation, force_resample=False)


def test_identical_grid_4d_source_passthrough():
    """A 4D source already on the 3D target grid is returned whole (nilearn's
    `_resampling_not_needed` compares only the first three axes)."""
    src = _grid((14, 12, 10, 4), _aff((2, 2, 2), (-14, -12, -10)),
                dtype=np.int16, seed=13)
    tgt = _img(np.zeros((14, 12, 10), np.int16), src.affine.copy())
    got = vendored(src, tgt, interpolation="nearest", copy_header=True)
    assert np.array_equal(_data(got), _data(src))
    _compare(src, tgt, "nearest", force_resample=True)


# --------------------------------------------------------------------------- #
#  dtype preservation
# --------------------------------------------------------------------------- #
# np.int64 is deliberately absent: NIfTI-1 has no int64 datatype, and nibabel
# refuses to build a Nifti1Image from int64 without an explicit header/dtype
# ("To use this type, pass an explicit header or dtype argument"). The fixture
# itself fails before either implementation runs, so parametrising it tests
# nibabel, not this port. No caller produces int64 images.
@pytest.mark.parametrize("dtype", [np.uint8, np.int16, np.int32,
                                   np.float32, np.float64])
@pytest.mark.parametrize("interpolation", ["nearest", "linear", "continuous"])
def test_dtype_matches_nilearn(dtype, interpolation):
    """dtype is part of the contract: `ho_overlap` reads the result back with
    `np.asarray(..., dtype=int)` and a surprise float would round differently."""
    src = _grid((22, 20, 18), _aff((2, 2, 2), (-22, -20, -18)),
                dtype=dtype, seed=14)
    tgt = _img(np.zeros((18, 16, 14), np.int16),
               _aff((2.4, 2.4, 2.4), (-21, -19, -17)))
    got, ref = _compare(src, tgt, interpolation, force_resample=True)
    # nearest/linear preserve the input dtype exactly; continuous promotes
    # SIGNED ints to the same-width float (nilearn's documented behaviour).
    if interpolation != "continuous" or np.dtype(dtype).kind != "i":
        assert _data(got).dtype == np.dtype(dtype)


# --------------------------------------------------------------------------- #
#  The exact call-site signatures
# --------------------------------------------------------------------------- #
def test_call_site_kwargs_are_accepted():
    """Every kwarg combination the nine call sites pass must be accepted."""
    src = _grid((20, 18, 16), _aff((2, 2, 2), (-20, -18, -16)), seed=15)
    tgt = _img(np.zeros((16, 14, 12), np.int16),
               _aff((2.5, 2.5, 2.5), (-19, -17, -15)))
    # worker_common / dissect_worker / dissect_between_worker / summary_render
    vendored(src, tgt, interpolation='nearest',
             copy_header=False, force_resample=False)
    # lnm_backend (all four sites)
    vendored(src, tgt, interpolation="nearest",
             force_resample=True, copy_header=True)
    # bare default
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        vendored(src, tgt)


def test_rejects_unknown_interpolation():
    src = _grid((8, 8, 8), np.eye(4), seed=16)
    tgt = _img(np.zeros((6, 6, 6), np.int16), _aff((1.5, 1.5, 1.5), (0, 0, 0)))
    with pytest.raises(ValueError):
        vendored(src, tgt, interpolation="cubic")
