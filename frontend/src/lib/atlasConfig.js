// Atlas + layer configuration.

export const BASE_VOLUME = {
  id: "mni152",
  name: "MNI152 Template",
  url: "/atlases/mni152/mni152.nii.gz",
  colormap: "gray",
  opacity: 1.0,
  description: "MNI152 ICBM linear T1 average · 0.74mm isotropic",
  isBase: true,
};

// ===== Wang & Benson labels (used for crosshair tooltip & legends) =====
// Wang 2015 max-probability atlas — 25 ROIs, from Kastner Lab's
// lh/rh.wang15_mplbl.v1_0.mgz. Exact ordering matches the labels file
// distributed with the atlas (also written to
// /atlases/wang2015/wang2015_labels.json).
export const WANG_LABELS = {
  1: "V1v", 2: "V1d", 3: "V2v", 4: "V2d", 5: "V3v", 6: "V3d",
  7: "hV4", 8: "VO1", 9: "VO2", 10: "PHC1", 11: "PHC2",
  12: "TO2", 13: "TO1", 14: "LO2", 15: "LO1",
  16: "V3B", 17: "V3A", 18: "IPS0", 19: "IPS1", 20: "IPS2",
  21: "IPS3", 22: "IPS4", 23: "IPS5", 24: "SPL1", 25: "FEF",
};

// Benson 2014 visual_areas (neuropythy `varea`) — 12 labels per the
// neuropythy docs (V1-V3 + hV4 + VO + LO + TO + V3a/b).
export const VAREA_LABELS = {
  1: "V1", 2: "V2", 3: "V3",
  4: "hV4", 5: "VO1", 6: "VO2",
  7: "LO1", 8: "LO2", 9: "TO1", 10: "TO2",
  11: "V3b", 12: "V3a",
};

// ===== Retinotopy section =====
export const RETINOTOPY_LAYERS = [
  {
    id: "benson_polar_angle",
    name: "Polar Angle (0–360°)",
    url: "/atlases/benson14/benson14_polar_angle.nii.gz",
    // Custom circular colormap (defined in NiivueViewer): red→yellow→
    // blue→cyan→red. LH cortex carries 1..180 (right visual field);
    // RH cortex carries 180..360 (left visual field).
    colormap: "polar_angle_360",
    opacity: 0.9,
    cal_min: 1,                       // hide background (value 0) — no bleed
    cal_max: 360,
    ignoreZeroVoxels: true,           // belt-and-suspenders against trilinear interpolation
    description: "Benson 2014 polar angle · merged 0–360° · LH 1–180 (right hemifield) · RH 180–360 (left hemifield)",
    legendType: "polar",
  },
  {
    id: "benson_eccentricity",
    name: "Eccentricity",
    url: "/atlases/benson14/benson14_eccentricity.nii.gz",
    colormap: "warm",
    opacity: 0.85,
    cal_min: 0.5,
    cal_max: 90,
    description: "Benson 2014 eccentricity · 0–90° visual angle (from fsaverage projection)",
    legendType: "eccen",
  },
  {
    id: "benson_visual_areas",
    name: "Visual Areas (Benson 2014)",
    url: "/atlases/benson14/benson14_visual_areas.nii.gz",
    colormap: "actc",
    opacity: 0.75,
    cal_min: 1,
    cal_max: 12,
    description: "Benson 2014 varea · 12 areas (V1, V2, V3, hV4, VO1/2, LO1/2, TO1/2, V3a, V3b) — fsaverage→MNI projection",
    legendType: "labels",
    labels: VAREA_LABELS,
  },
  {
    id: "wang2015_prob",
    name: "Wang 2015 ROIs · Probabilistic",
    url: "/atlases/wang2015/wang2015_prob.nii.gz",
    colormap: "warm",
    opacity: 0.7,
    cal_min: 0.4,
    cal_max: 1.0,
    description: "11 occipital ROIs · continuous probability (0..1)",
    legendType: "prob",
    labelLayerId: "wang2015_maxprob",
    labelLayerUrl: "/atlases/wang2015/wang2015_maxprob.nii.gz",
    labels: WANG_LABELS,
  },
];

// ===== White-matter retinotopy section =====
// Population white-matter analogue of the Benson cortical maps, derived from the
// brainlife "Retinotopic Connectivity Template" (Amorosino et al. 2026, CC-BY,
// DOI 10.25663/brainlife.pub.67) by scripts/build_wm_retinotopy_maps.py. Each
// occipital white-matter voxel carries the polar angle / eccentricity of the
// cortical endpoint of the fibers passing through it, using the SAME value
// conventions as the Benson maps above (polar 1..180 LH/right field,
// 181..360 RH/left field; eccen 0..90). Because the format is identical, the
// existing NiivueViewer colormap + retinotopyAnalysis legend code consumes them
// with no changes.
//
// NOTE: these .nii.gz files are produced offline from the CC-BY template and are
// NOT bundled by default. When absent, the layers simply never load (toggle is a
// graceful no-op) and the white-matter legend stays empty. Output is
// anatomical/illustrative — not a validated clinical prediction.
export const WHITE_MATTER_RETINOTOPY_LAYERS = [
  {
    id: "wm_polar_angle",
    name: "WM Polar Angle (template)",
    url: "/atlases/wm_retinotopy/wm_polar_angle.nii.gz",
    colormap: "polar_angle_360",
    opacity: 0.9,
    cal_min: 1,
    cal_max: 360,
    ignoreZeroVoxels: true,
    description:
      "White-matter polar angle from the retinotopic connectivity template · " +
      "LH 1–180 (right hemifield) · RH 181–360 (left hemifield) · illustrative, population-derived",
    legendType: "polar",
    attribution: "Amorosino et al. 2026 · brainlife.pub.67 (CC-BY)",
  },
  {
    id: "wm_eccentricity",
    name: "WM Eccentricity (template)",
    url: "/atlases/wm_retinotopy/wm_eccentricity.nii.gz",
    colormap: "warm",
    opacity: 0.85,
    cal_min: 0.5,
    cal_max: 90,
    description:
      "White-matter eccentricity from the retinotopic connectivity template · " +
      "0–90° visual angle · illustrative, population-derived",
    legendType: "eccen",
    attribution: "Amorosino et al. 2026 · brainlife.pub.67 (CC-BY)",
  },
];

// ===== Standard atlases =====
// The STANDARD_ATLASES array that used to live here is gone. Atlases are now
// discovered at runtime from /api/atlases (backend/atlas_registry.py) and
// consumed through hooks/use-atlases; a compile-time constant could not react
// to an install, an import, an uninstall or a reorder, and this one had drifted
// to list 6 of the 11 atlases actually on disk.
//
// The registry returns the same per-layer fields this file's other layer
// configs use (id / name / short / url / labelsUrl / colormap / opacity /
// ignoreZeroVoxels), so volumeApi.addOverlayFromUrl takes a registry
// descriptor unchanged.
