import { SLICE_TYPE } from "@niivue/niivue";

// "Multiplanar + 3D" is rendered via nv.customLayout (a plain 2x2 grid)
// instead of niivue's native SLICE_TYPE.MULTIPLANAR layout. NiiVue's native
// multiplanar renderer skips the 3D tile entirely for the duration of any
// pen stroke (`isDraw3D = !isDrawPenDown && ...`, an internal optimization
// with no opt-out), which made the 3D render flicker out during lesion
// drawing. The customLayout render path doesn't have that skip, so the 3D
// view stays live while drawing. Quadrant order matches niivue's own native
// grid (coronal/sagittal top, axial/render bottom).
export const MULTIPLANAR_GRID_LAYOUT = [
  { sliceType: SLICE_TYPE.CORONAL, position: [0, 0, 0.5, 0.5] },
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0.5, 0, 0.5, 0.5] },
  { sliceType: SLICE_TYPE.AXIAL, position: [0, 0.5, 0.5, 0.5] },
  { sliceType: SLICE_TYPE.RENDER, position: [0.5, 0.5, 0.5, 0.5] },
];
