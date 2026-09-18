// ===== Shared viewer context =====
//
// The complete set of mutable refs owned by NiivueViewer and shared with the
// extracted viewer modules (meshApi, navigation, layout, markers, drawingApi,
// segmentation, and the GL/pointer pipelines).
//
// Why this exists: those modules are plain functions taking `(ctx, ...args)`
// rather than closures over the component body. Grouping the refs into one
// object means each takes a single parameter instead of twenty-nine, and —
// more importantly — makes the dependency explicit: a module can only touch
// state it was handed.
//
// Invariants:
//   * Every value here is a React ref created by NiivueViewer via useRef, so
//     the object is assembled ONCE and stays referentially stable. Extracted
//     modules must read `ctx.someRef.current` at call time, never capture
//     `.current` at module scope (that would reintroduce the stale-closure
//     bug class this codebase has hit before).
//   * No module may create, replace, or rename a ref. The context is a view
//     onto NiivueViewer's state, not an owner of it.

// Canonical key list — the single source of truth for what a viewer context
// contains. Used by the dev-time completeness check below.
export const VIEWER_CONTEXT_KEYS = [
  // Canvas + niivue instance
  "canvasRef",
  "nvRef",
  // Loaded-object registries
  "volumeMap",
  "meshMap",
  "hiddenLabelLayers",
  // Measurement markers
  "measurementMeshRef",
  "measurementPointsRef",
  // Base volume
  "baseRef",
  "baseFileRef",
  // Host callbacks (kept in refs so listeners registered at mount see live props)
  "onDoubleClickSliceRef",
  "onLocationChangeRef",
  "clickToSegmentCb",
  "drawStartCb",
  "drawCommitCb",
  "historyCb",
  "drawingActiveCb",
  "drawChangeCb",
  // Render scheduling
  "redrawRafRef",
  "pendingVolumeUpdateRef",
  // Drawing / undo state
  "lastDraws",
  "drawHistory",
  "pendingStrokeSnapshot",
  "brushRadiusRef",
  "toolModeRef",
  "brushModeRef",
  "rightDragModeRef",
  // View / layout state
  "sliceTypeRef",
  "sideLayoutRef",
  "activeOrientationRef",
  "singleFillZoomRef",
  "resizeCanvasRef",
];

/**
 * Assemble the viewer context from NiivueViewer's refs.
 *
 * Pure pass-through in production. In development it warns about missing or
 * unexpected keys, so an extraction that forgets to thread a ref fails loudly
 * at mount instead of silently no-opping at some later interaction.
 *
 * @param {Record<string, React.MutableRefObject<any>>} refs
 * @returns {Record<string, React.MutableRefObject<any>>} the same object
 */
export function buildViewerContext(refs) {
  if (process.env.NODE_ENV !== "production") {
    const missing = VIEWER_CONTEXT_KEYS.filter((k) => !(k in refs));
    const unexpected = Object.keys(refs).filter((k) => !VIEWER_CONTEXT_KEYS.includes(k));
    if (missing.length) {
      console.warn("[viewerContext] missing refs:", missing.join(", "));
    }
    if (unexpected.length) {
      console.warn("[viewerContext] unexpected refs (add to VIEWER_CONTEXT_KEYS?):", unexpected.join(", "));
    }
  }
  return refs;
}
