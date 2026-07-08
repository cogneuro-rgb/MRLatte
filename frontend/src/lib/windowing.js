// Intensity windowing presets for the base volume.
//
// Brain / stroke / bone / soft-tissue are standard CT Hounsfield windows
// (window level ± window width / 2). They apply directly to CT bases; for
// the default MRI MNI152 template prefer "Full". "Full" stretches to the
// volume's own global range.

export const WINDOW_PRESETS = [
  { id: "full", label: "Full", hu: null },
  { id: "brain", label: "Brain", hu: [0, 80] },        // WL 40 / WW 80
  { id: "stroke", label: "Stroke", hu: [25, 45] },     // narrow WL ~35 / WW ~20
  { id: "soft", label: "Soft Tissue", hu: [-150, 250] },// WL 50 / WW 400
  { id: "bone", label: "Bone", hu: [-500, 1500] },     // WL 500 / WW 2000
];

/**
 * Resolve a preset to [cal_min, cal_max] for a volume given its global range.
 * "Full" → the volume's own global min/max.
 */
export function resolveWindow(presetId, globalMin, globalMax) {
  const p = WINDOW_PRESETS.find((w) => w.id === presetId);
  if (!p || !p.hu) return [globalMin, globalMax];
  return p.hu;
}
