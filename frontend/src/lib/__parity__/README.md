# JS lesion-math parity harness (Task 0c)

Freezes what today's **JavaScript** lesion/atlas math produces, before it is
replaced by LQTpy (Python). This changes no production behaviour — it only
captures golden values so the upcoming engine swap can be measured instead of
guessed at.

## Run it

```bash
cd frontend
node --import ./src/lib/__parity__/register-hook.mjs ./src/lib/__parity__/run.mjs
```

Writes `golden.json` next to this file. Re-running with no code change
reproduces it byte-for-byte (verified by running twice and diffing — see the
task transcript).

## Why this path (`frontend/src/lib/__parity__/`)

The functions under test (`computeAtlasOverlap`, `computeLesionVolume`) are
plain ES modules with no React/DOM/niivue dependency at call time — only
`downloadText()` in `volumeAnalysis.js` touches `document`/`Blob`, and it's
never called here. Living next to them means importing the real, unmodified
source by relative path (`../lesionReport.js`, `../volumeAnalysis.js`) with
no build step, and it's obviously exempt from `craco`'s app bundle (the
double-underscore name mirrors the `__tests__`-style convention CRA already
ignores).

## Why plain `node`, not `craco test`

`craco test` (CRA's Jest) is the repo's only existing test runner, but it has
no test config wired up here (no `"jest"` key in `package.json`, no
`craco.config.js` jest section) — CRA's default Jest config doesn't know
about the `@` alias, so `lesionReport.js`'s `import ... from "@/lib/..."`
would fail to resolve. The only way to fix that within Jest is to add a
`moduleNameMapper`, which means editing shared config files outside this
harness. Plain Node's `--import`/`module.register()` hook (`register-hook.mjs`
+ `alias-hook.mjs`) gets the same resolution behaviour — `@/` -> `frontend/src/`,
plus retrying extension-less specifiers with `.js` appended (needed for
`retinotopyAnalysis.js`'s `import ... from "./volumeAnalysis"`, statically
pulled in by `lesionReport.js` even though this harness never calls the
retinotopy functions) — with zero changes outside `__parity__/`. That's the
smaller footprint, so it's what's here. (You'll see a harmless
`MODULE_TYPELESS_PACKAGE_JSON` warning on stderr — `frontend/package.json`
has no `"type"` field; fixing that is a repo-wide change out of scope for a
capture harness.)

## `affineDet3`

`affineDet3(M)` is exported from `volumeAnalysis.js`, and the harness calls
that real function (re-exported through `geom.mjs`) rather than a copy.

It was module-private in `lesionReport.js` when this harness was first
written, and `geom.mjs` carried a reimplementation of the formula. Fixing the
`percentOfRegion` bug below required the determinant inside
`computeAtlasOverlap`, so the helper moved to `volumeAnalysis.js` — where the
migration plan already had the affine helpers surviving — and the copy went
away. Each fixture's golden entry still records both `lesionVolume.mm3`
(captured from `computeLesionVolume`) and `affineDet3Check`; they agree
everywhere `voxelCount > 0`, and `affineDet3Check` additionally covers the
`empty` fixture, where `voxelCount` is 0 and `mm3` can't reveal the
determinant.

## What this golden file does and does not vouch for

The golden values are a record of **what MRLatte's JavaScript produces**, for
diffing against LQTpy later. They are not by themselves a claim that each
number is correct — capturing the behaviour is the point, bugs included.

One such bug was found by this harness and **has since been fixed**, so the
golden values below are post-fix: `computeAtlasOverlap` divided a lesion-grid
voxel count by an atlas-grid voxel count, inflating `percentOfRegion` by the
voxel-volume ratio (~8x for a 1 mm lesion on a 2 mm atlas, ~20x at 0.737 mm).
The harness caught it because the same physical sphere reported 38.18% of AAL
region 61 at 1 mm but 99.20% at 0.737 mm; post-fix they read 4.77% and 4.96%,
agreeing to within discretization error. `percentOfLesion` was never affected.
Each `overlapByAtlas[...].stats` now records the `voxVolRatio` applied, which
is exactly 1 whenever the two grids have the same voxel volume.

## Fixtures (`fixtures.mjs`) — generated in code, never written to disk

| name | what it tests |
|---|---|
| `sphere_1mm` | Clean 1mm binary sphere (r=8mm) — the "boring, everything agrees" baseline |
| `native_0737` | Same physical sphere on this lab's real 0.737mm native-grid resolution |
| `oblique` | Same sphere on a non-axis-aligned affine (25° Z, 15° X rotation) |
| `probabilistic` | Radial-falloff values in (0,1], including plenty of voxels in (0, 0.5) |
| `two_blobs_boundary` | Two r=4mm blobs 80mm apart, straddling a real atlas L/R boundary |
| `empty` | All-zero lesion — divide-by-zero / null-centroid guard paths |

All fixtures except `empty` are centered on real MNI coordinates
(`CENTER_A = [-40,-20,50]`, `CENTER_A_MIRROR = [40,-20,50]`,
`CENTER_B = [-30,-60,40]`) chosen by probing the real AAL/Harvard-Oxford
atlases so overlap is non-trivial rather than landing on background.

Fixtures are plain objects shaped like niivue's `NVImage` fields
(`{img, dimsRAS, matRAS}`) — `geom.mjs` builds the affine. They are **not**
actually RAS-reoriented (no niivue running in Node); they only need `img`'s
voxel order and `matRAS` to describe the same grid *consistently*, which is
all `computeAtlasOverlap`/`computeLesionVolume` require (they never inspect
NIfTI headers directly — that's `regionCentroidMM`'s job, a different
function, not under test here). See `volumeAnalysis.js:97-101`.

## Atlases used

- **Real** (primary evidence): `data/modules/atlases/aal/aal.nii.gz` (2mm,
  91x109x91, 166 labels) and
  `data/modules/atlases/harvard_oxford_cort/harvard_oxford_cort.nii.gz` (1mm,
  182x218x182, 48 labels), parsed with the frontend's own `nifti-reader-js`
  dependency (already in `package.json` — no new NIfTI-parsing code added).
- **Synthetic** (`synthetic_hemi`, generated in code, not from a file): a
  hand-built label-1/label-2 hemisphere split (`x<0` / `x>=0`) on AAL's exact
  grid/affine, included alongside the real atlases as a fully controlled
  cross-check whose answer is verifiable by hand (e.g. the symmetric
  `two_blobs_boundary` fixture must split exactly 50/50 across it, and does:
  257/257 voxels in `golden.json`).

No fixture/atlas pair shares an identical grid+affine, so `computeAtlasOverlap`'s
`sameGrid` fast path is never exercised (`stats.sameGrid` is `false`
everywhere in `golden.json`) — that's intentional, not an oversight: a
clinical lesion is drawn on the subject's native scan and is essentially
never pre-resampled onto the atlas grid, so the affine-aware path is the one
that matters for this parity project.

## Hand-checked numbers

- `sphere_1mm`: 2109 voxels x 1mm³ = 2109 mm³ against the theoretical
  `4/3·π·r³` for r=8mm = **2144.66 mm³** (1.7% low — expected voxelization
  bias for a small-radius discretized sphere).
- `native_0737`: same physical sphere, finer grid → 5377 voxels x
  0.737³ mm³/voxel = **2152.50 mm³**, within 0.4% of the theoretical value
  (finer grids approximate a sphere's volume more closely, as expected).
- `affineDet3Check` for `native_0737` = 0.400316 = 0.737³ exactly (0.737³ =
  0.4003156 to 7sf) — confirms the affine's own determinant, independent of
  `computeLesionVolume`.

## Where the three divergence axes already show up in `golden.json`

1. **Binarization** (`> 0` vs lqtpy's **strictly-greater** `> 0.5`): the
   `probabilistic` fixture has 2969 voxels with value `> 0` but only 389 with
   value `> 0.5` (lqtpy independently counted the same 389, so no voxel sits
   exactly on 0.5 and the `>` / `>=` distinction doesn't arise here) — an
   **87% drop** in lesion voxel count from the threshold change alone, before
   any atlas is even involved.
2. **Direction / denominator together**: `sphere_1mm` vs `native_0737` are
   the *same physical lesion*, only the grid resolution differs. Against AAL
   region 61 (`Postcentral_L`), `percentOfRegion` is **38.2%** at 1mm but
   **99.2%** at 0.737mm — for an anatomically identical lesion. This is the
   denominator axis exactly as described in the task: `percentOfRegion`'s
   numerator (`lesionByRegion[a]`) is counted in *lesion* voxels, so a finer
   lesion grid inflates it against the atlas's own (fixed, atlas-grid-based)
   region size — an artifact a resample-lesion-onto-atlas-grid approach
   (LQTpy) would not have.
3. **Direction / parcellation sensitivity**: `two_blobs_boundary` (two
   identical, symmetric blobs) splits into 4 different regions under AAL
   (`Postcentral_L`, `Precentral_R`, `Postcentral_R`, `Precentral_L` —
   AAL keeps hemispheres separate) but only 2 under Harvard-Oxford-cortical
   (`Precentral Gyrus`, `Postcentral Gyrus` — HO-cort is bilateral), each at
   a clean ~50/50 split confirmed against `synthetic_hemi`. Boundary-straddling
   lesions are exactly where a forward-map-and-round-to-nearest-voxel
   approach (current JS) and a proper resample (LQTpy) are most likely to
   disagree on individual voxels.
