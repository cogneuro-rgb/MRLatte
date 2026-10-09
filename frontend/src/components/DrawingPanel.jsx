import React, { useState, useEffect, useRef } from "react";
import {
  Pencil, Brush, Save, Trash2, Undo2, Redo2, Expand, Shrink, Waves,
  AlignVerticalSpaceAround, Target, Crosshair, Download, Box, Square, Eraser, Scissors, ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { Slider } from "@/components/ui/slider";
import FileUploader from "@/components/FileUploader";
import { saveBinaryFile } from "@/lib/workspace";
import { currentDrawingAsFile } from "@/lib/lesions";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { ghostBtnCls } from "@/lib/buttonVariants";
import { BASE_VOLUME } from "@/lib/atlasConfig";
import { runLesionQc } from "@/lib/lesionQc";
import { LesionQcDialog } from "@/components/LesionQcDialog";

/**
 * DrawingPanel — unified MRIcroGL-style mask editor.
 * Two tools: Pen (native NiiVue path, interpolate-eligible) and Brush
 * (custom sphere/disc stamp pipeline, not interpolate-eligible).
 * Right-click erases using the mode-appropriate path:
 *   Pen  → 2D cutout (flood-fill erase)
 *   Brush 3D → true-3D sphere erase
 *   Brush 2D → flat-disc erase on the current slice
 * The 4th "right-drag: erase" indicator in the topbar is managed by
 * Dashboard using the drawingActive state emitted by onDrawingActiveChange.
 */
export const DrawingPanel = ({
  viewerRef, baseName, baseIsMni, crosshair, onToggleCrosshair, onCrosshairOff,
  onSetCrosshair, onSaveDrawing, clearNonce, editingSaveName, editNonce,
  // Lifted state for Dashboard to know tool / mode / active so it can
  // update the topbar indicator and canvas label.
  brushMode = "2D", onBrushModeChange, onDrawingActiveChange, onToolChange, scrollIntoView,
  // Set by Dashboard's "D" shortcut to request the SAME toggle the button
  // performs. A request survives this panel being mounted by the very act of
  // opening the section, which a nonce couldn't: the effect below runs on
  // mount, sees the flag, and acts — then clears it so a later manual
  // open/close of the section never replays it.
  drawTogglePending = false, onDrawToggleHandled,
}) => {
  const [enabled, setEnabled] = useState(false);
  // "pen" | "brush": pen uses niivue's native pipeline; brush uses our own
  // true-3D sphere / 2D circle pipeline. Right-click always erases using the
  // mode appropriate for the current tool + brushMode.
  const [tool, setTool] = useState("pen");
  const [penValue, setPenValue] = useState(1);
  const [opacity, setOpacity] = useState(0.5);
  const [saving, setSaving] = useState(false);
  const [brushRadius, setBrushRadiusState] = useState(5);
  // Enabled once two same-orientation slices have been drawn (see viewer).
  const [canInterpolate, setCanInterpolate] = useState(false);
  // Enabled once >=2 distinct slices are drawn in the CURRENTLY RESOLVED
  // orientation (item 62 — "Interpolate All"; item 3 — resolution below).
  const [canInterpolateAll, setCanInterpolateAll] = useState(false);
  // Interpolate-All orientation resolution, mirrored from the viewer (the
  // single source of truth — see resolveInterpolateAllOrientation in
  // NiivueViewer.jsx). resolvedOrientation is what the button/shortcut will
  // actually target right now — the last drawn view, or a manual pick until
  // the next stroke. validOrientations[o] says whether view o has the two
  // drawn slices Interpolate All needs (greys out the others in the menu).
  const [resolvedOrientation, setResolvedOrientation] = useState(null);
  const [validOrientations, setValidOrientations] = useState([false, false, false]);
  const [interpolateMenuOpen, setInterpolateMenuOpen] = useState(false);
  const interpolateMenuRef = useRef(null);
  // Undo/redo availability, mirrored from the viewer's draw history.
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // Spherical-ROI sub-tool — paints a sphere into the SAME drawing bitmap.
  const [sphere, setSphere] = useState({ x: "0", y: "0", z: "0", r: "5" });
  // Name for the next saved object.
  const [saveName, setSaveName] = useState("");
  // Briefly true when brushMode changes from outside, to fade the 2D/3D toggle
  // in and out if the pen tool is currently selected.
  const [flashBrushMode, setFlashBrushMode] = useState(false);
  // Lesion quality-check confirmation, shown before Save/Download when
  // lqtpy.qc finds issues — { flags, actionLabel, resolve } or null.
  // `resolve` is the requestQcConfirmation() promise's resolver (see below).
  const [qcPrompt, setQcPrompt] = useState(null);

  // mni=true only for the default MNI152 template (baseName === the
  // BASE_VOLUME's own name); any replacement base (custom upload, DICOM
  // import) is native-space, where lqtpy's brain-mask checks
  // (outside_brain/not_mni) would false-alarm on every drawing.
  // Dashboard decides (name match or an exact MNI template grid, lib/mniGrid.js);
  // the name comparison is only the fallback for a caller that doesn't say.
  const mni = baseIsMni ?? (baseName === BASE_VOLUME.name);

  // Run QC on `file` (already-serialised current drawing) and, if it finds
  // anything, block on a confirmation dialog before the caller proceeds.
  // Resolves true immediately (no dialog) when QC has nothing to say —
  // unavailable/timeout/error (fail-open, see lib/lesionQc.js) or a clean
  // drawing — so Save/Download behave exactly as today in the common case.
  const acceptedQcIdRef = useRef(null);
  const requestQcConfirmation = (file, actionLabel) => new Promise((resolve) => {
    runLesionQc({ file, viewerRef, mni, fileName: file.name }).then((result) => {
      if (!result || !result.needsAttention) { resolve(true); return; }
      // Already answered for this exact drawing: "Save anyway" followed by
      // Download (or the other way round) must not ask the same question twice.
      // lesionId is a hash of the drawing's bytes, so any edit asks again.
      if (acceptedQcIdRef.current === result.lesionId) { resolve(true); return; }
      setQcPrompt({ flags: result.flags, verdict: result.verdict, lesionId: result.lesionId, actionLabel, resolve });
    });
  });

  // True while WE auto-turned the crosshair off on draw-enter (item 30), so we
  // know to turn it back on when drawing is disabled (item 42). Only restore
  // when we were the one who turned it off — never force it off.
  const didAutoOffCrosshairRef = useRef(false);
  const rootRef = useRef(null);
  // Live mirror of `enabled` so document-level listeners / handlers never read a
  // stale value.
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const applyDraw = (t = tool) => {
    viewerRef.current?.setClickToSegment?.(false);
    viewerRef.current?.setDrawingEnabled(true);
    viewerRef.current?.setToolMode?.(t);
    viewerRef.current?.setPenType("pen");
    // Pen and Brush both paint with penValue. Brush reads it directly on the
    // viewer side; push it here so nv.opts.penValue is always current.
    viewerRef.current?.setPenValue(penValue, true);
    viewerRef.current?.setDrawOpacity(opacity);
  };

  // Enter draw mode: turn the crosshair off (item 30) but remember we did so so
  // disableDrawing can restore it (item 42).
  const enterDrawing = () => {
    setEnabled(true);
    enabledRef.current = true;
    if (crosshair) {
      didAutoOffCrosshairRef.current = true;
      onCrosshairOff?.();
    }
    // Bring the Draw controls into view on EVERY entry into paint mode, not
    // just when a stroke starts on the canvas (setDrawStartCallback). Enabling
    // drawing and then having to hunt for the tools was the odd part: by the
    // time the first stroke scrolled them into frame, the user had already gone
    // looking. Covers the button, the "D" shortcut, and a tool switch alike.
    scrollIntoView?.();
  };

  // Turn paint mode off and drop out of drawing. Restores the crosshair if we
  // auto-turned it off on entry (item 42).
  const disableDrawing = () => {
    viewerRef.current?.setClickToSegment?.(false);
    viewerRef.current?.setDrawingEnabled(false);
    setEnabled(false);
    enabledRef.current = false;
    onDrawingActiveChange?.(false);
    if (didAutoOffCrosshairRef.current) {
      didAutoOffCrosshairRef.current = false;
      onSetCrosshair?.(true);
    }
  };

  // Ensure paint mode is on (allocates nv.drawBitmap) before a bitmap edit.
  const ensureDrawing = (t = tool) => {
    if (!enabledRef.current) { applyDraw(t); enterDrawing(); }
  };

  const toggleEnabled = () => {
    if (enabled) { disableDrawing(); return; }
    applyDraw();
    enterDrawing();
    onDrawingActiveChange?.(true);
  };

  // Service a toggle requested from outside (Dashboard's "D" shortcut) by
  // running the SAME toggleEnabled the button runs. The shortcut deliberately
  // does not touch the viewer itself: enabling paint mode also has to clear
  // click-to-segment, set the tool mode, set penValue with `filled` ON, push
  // the draw opacity, and hand off the crosshair — a shortcut that only called
  // setDrawingEnabled looked identical but painted unfilled outlines.
  useEffect(() => {
    if (!drawTogglePending) return;
    onDrawToggleHandled?.();
    toggleEnabled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawTogglePending]);

  // Upload a lesion NIfTI directly as the editable drawing (item 37).
  const handleEditLesionFile = async (file) => {
    const ok = await viewerRef.current?.loadDrawingFromVolume?.(file);
    if (!ok) return;
    applyDraw();
    enterDrawing();
    onDrawingActiveChange?.(true);
  };



  // Register draw-coordination callbacks with the viewer:
  //  • draw-start → scroll the Draw Lesion controls into view.
  //  • draw-commit → enable "Interpolate slices" once two parallel
  //    same-orientation slices have been drawn.
  //  • history → mirror undo/redo availability.
  useEffect(() => {
    const viewer = viewerRef.current;
    viewer?.setDrawStartCallback?.(scrollIntoView);
    viewer?.setDrawCommitCallback?.((info) => {
      setCanInterpolate(!!info?.canInterpolate);
      setCanInterpolateAll(!!info?.canInterpolateAll);
      setResolvedOrientation(info?.resolvedOrientation ?? null);
      setValidOrientations(info?.validOrientations ?? [false, false, false]);
    });
    viewer?.setHistoryCallback?.(({ canUndo: u, canRedo: r }) => {
      setCanUndo(!!u);
      setCanRedo(!!r);
    });
    // The viewer owns paint mode; mirror it so this button can never disagree with
    // the canvas — covers paths that flip it from outside this panel (the layer
    // list's "Edit" button, Clear All, loadDrawingFromVolume). Item 51.
    viewer?.setDrawingActiveCallback?.((active) => {
      setEnabled(!!active);
      enabledRef.current = !!active;
      onDrawingActiveChange?.(!!active);
    });
    return () => {
      viewer?.setDrawStartCallback?.(null);
      viewer?.setDrawCommitCallback?.(null);
      viewer?.setHistoryCallback?.(null);
      viewer?.setDrawingActiveCallback?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo, while the
  // drawing tool is active. Skip when focus is in a text field.
  useEffect(() => {
    const onKey = (e) => {
      if (!enabledRef.current) return;
      const t = e.target;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        viewerRef.current?.drawUndo?.();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        viewerRef.current?.drawRedo?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Disable paint mode when this panel unmounts (Draw Lesion section collapsed —
  // SidebarSection unmounts its children). Collapsing counts as disabling, so
  // restore the crosshair too if we auto-offed it (item 42).
  useEffect(() => {
    const viewer = viewerRef.current;
    return () => {
      viewer?.setDrawingEnabled(false);
      if (didAutoOffCrosshairRef.current) {
        didAutoOffCrosshairRef.current = false;
        onSetCrosshair?.(true);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While drawing is active, engaging another crosshair-driven tool
  // (Measurements, Tract Dissection, Clip Plane) auto-disables drawing so those
  // tools' canvas clicks position the crosshair instead of painting. (Create ROI
  // is now part of THIS panel, so it's no longer in this list.)
  useEffect(() => {
    if (!enabled) return;
    const onPointerDown = (e) => {
      if (!(e.target instanceof Element)) return;
      if (
        e.target.closest(
          '[data-testid="section-measure"], [data-testid="section-tract-dissect"], [data-testid="clip-plane-control"]'
        )
      ) {
        disableDrawing();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Clear All resets the panel to its idle state. Route through disableDrawing so
  // the VIEWER's paint mode is actually turned off too — setting the local flag
  // alone left the canvas painting while the button read "Enable Drawing" (item 51).
  useEffect(() => {
    if (!clearNonce) return;
    disableDrawing();
    setSaveName("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearNonce]);

  // Edit (item 5): prefill the save-name box with the mask's original name so
  // pressing Save again reuses it by default — still freely editable. Keyed
  // off editNonce (not editingSaveName) so re-editing the same-named mask
  // twice in a row still re-fires this.
  useEffect(() => {
    if (!editNonce) return;
    setSaveName(editingSaveName || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editNonce]);

  const changeTool = (t) => {
    setTool(t);
    onToolChange?.(t);
    if (!enabledRef.current) { applyDraw(t); enterDrawing(); onDrawingActiveChange?.(true); }
    else {
      viewerRef.current?.setToolMode?.(t);
      viewerRef.current?.setPenValue(penValue, true);
    }
  };

  // Sync brushMode from Dashboard prop to the viewer.
  useEffect(() => {
    viewerRef.current?.setBrushMode?.(brushMode);
    setFlashBrushMode(true);
    const t = setTimeout(() => setFlashBrushMode(false), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brushMode]);
  // Push initial brushMode once the viewer ref is ready.
  useEffect(() => {
    viewerRef.current?.setBrushMode?.(brushMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeBrushMode = (m) => {
    onBrushModeChange?.(m);
    viewerRef.current?.setBrushMode?.(m);
  };

  // Pen and Brush both paint with the chosen label value.
  const changePenValue = (v) => {
    setPenValue(v);
    if (!enabledRef.current) return;
    viewerRef.current?.setPenValue(v, true);
  };

  const changeOpacity = (v) => {
    setOpacity(v);
    // Always push to the viewer — draw opacity is a RENDER setting for the
    // existing drawing, not a paint-mode setting. Gating this on `enabled` meant
    // dragging the slider with paint mode off silently did nothing (item 50),
    // which item 41 made easy to hit now that the slider is always visible.
    viewerRef.current?.setDrawOpacity(v);
  };

  // Brush radius (voxels 1..30) — used by both 3D sphere and 2D circle modes.
  const changeBrushRadius = (v) => {
    const r = Math.max(1, Math.min(30, Math.round(v) || 1));
    setBrushRadiusState(r);
    viewerRef.current?.setBrushRadius?.(r);
  };
  // Push the initial radius once the viewer ref is available.
  useEffect(() => {
    viewerRef.current?.setBrushRadius?.(brushRadius);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Non-destructive morphological op on the scratch drawing (undoable).
  const morph = (op) => {
    const ok = viewerRef.current?.drawMorph?.(op);
    if (ok) toast.success(`${op[0].toUpperCase()}${op.slice(1)} applied`, { description: "Undo to revert" });
  };

  // ── Sphere ("ROI") sub-tool ────────────────────────────────────────────────
  const setSphereField = (k, val) => setSphere((s) => ({ ...s, [k]: val }));

  const useSphereCrosshair = () => {
    try {
      const nv = viewerRef.current?.getNiivue?.();
      const mm = nv?.frac2mm?.(nv.scene.crosshairPos);
      if (mm && mm.length >= 3 && mm.every((v) => Number.isFinite(v))) {
        setSphere((s) => ({ ...s, x: mm[0].toFixed(1), y: mm[1].toFixed(1), z: mm[2].toFixed(1) }));
      } else {
        toast.error("Crosshair position unavailable.");
      }
    } catch {
      toast.error("Crosshair position unavailable.");
    }
  };

  const addSphere = () => {
    const x = parseFloat(sphere.x), y = parseFloat(sphere.y), z = parseFloat(sphere.z);
    const r = parseFloat(sphere.r);
    if (![x, y, z].every(Number.isFinite)) { toast.error("Enter numeric X, Y, Z (mm)."); return; }
    if (!Number.isFinite(r) || r <= 0) { toast.error("Radius must be a positive number (mm)."); return; }
    ensureDrawing("pen");
    // Spheres always paint (never erase), using the current pen label.
    const ok = viewerRef.current?.drawSphere?.([x, y, z], r, penValue);
    if (ok) toast.success("Sphere added to drawing", { description: `r=${r} mm @ ${x}, ${y}, ${z}` });
  };

  // ── Save / Download ─────────────────────────────────────────────────────────
  const derivedName = () => {
    const slug = (baseName || "scan").replace(/[^a-z0-9_-]/gi, "_").replace(/^[._]+|[._]+$/g, "") || "scan";
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(11, 19);
    return `mask_${slug}_${ts}`;
  };

  // Save = snapshot the drawing into the layer list as a named overlay (no
  // download, no server upload), then clear the scratch so the next object
  // starts fresh. The saved object is re-editable (Edit in the list) and
  // downloadable (Download in the list) — download stays separate/explicit.
  const handleSave = async () => {
    setSaving(true);
    try {
      // getDrawingBytes() returns a full-volume NIfTI even for an all-zero
      // bitmap, so a `!bytes.length` check never catches an empty drawing —
      // ask the viewer directly instead (item 60).
      const name = saveName.trim() || derivedName();
      const file = await currentDrawingAsFile(viewerRef, `${name}.nii.gz`);
      if (!file) { toast.warning("Drawing is empty"); return; }
      if (!(await requestQcConfirmation(file, "Save anyway"))) return;
      const id = await onSaveDrawing?.(file, name);
      if (!id) { toast.error("Save failed"); return; }
      viewerRef.current?.drawClear?.(); // clear scratch for the next object
      setSaveName("");
      toast.success("Saved to layer list", { description: name });
      // Turning drawing mode off after Save (item 54) — reuse disableDrawing()
      // so the crosshair-restore and paint-mode-off logic (item 42) stay in
      // one place instead of hand-rolling the state flip here.
      disableDrawing();
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadCurrent = async () => {
    const name = saveName.trim() || derivedName();
    const file = await currentDrawingAsFile(viewerRef, `${name}.nii.gz`);
    if (!file) { toast.warning("Drawing is empty"); return; }
    if (!(await requestQcConfirmation(file, "Download anyway"))) return;
    await saveBinaryFile(`${name}.nii.gz`, "application/gzip", await file.arrayBuffer());
  };

  const tools = [
    { id: "pen",   icons: [Pencil, Scissors], label: "Pen/Cutout" },
    { id: "brush", icons: [Brush, Eraser],  label: "Brush/Eraser" },
  ];

  // Interpolate-All orientation label (0 axial / 1 coronal / 2 sagittal —
  // same convention used throughout Dashboard/NiivueViewer): what the split
  // button targets RIGHT NOW.
  const orientationName = (o) => (o === 1 ? "Coronal" : o === 2 ? "Sagittal" : "Axial");
  const orientationLabel = orientationName(resolvedOrientation);

  // Split-button dropdown: outside-click and Escape close it, matching the
  // topbar's GotoMniInput pattern.
  useEffect(() => {
    if (!interpolateMenuOpen) return;
    const onDown = (e) => {
      if (interpolateMenuRef.current && !interpolateMenuRef.current.contains(e.target)) {
        setInterpolateMenuOpen(false);
      }
    };
    const onKey = (e) => { if (e.key === "Escape") setInterpolateMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [interpolateMenuOpen]);

  // value: 0/1/2 = pick axial/coronal/sagittal until the next stroke. The
  // viewer is the single source of truth (see setInterpolateAllOrientation in
  // drawingApi.js) — this just forwards the pick and lets the resulting
  // setDrawCommitCallback round-trip update resolvedOrientation above,
  // rather than keeping a second copy of the state
  // here that could drift from what the button/shortcut actually use.
  const chooseInterpolateOrientation = (value) => {
    viewerRef.current?.setInterpolateAllOrientation?.(value);
    setInterpolateMenuOpen(false);
  };

  const num = (val, onChange, testId) => (
    <input
      type="number"
      value={val}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
      data-testid={testId}
    />
  );

  return (
    <div ref={rootRef} className="space-y-3" data-testid="drawing-panel">
      <button
        onClick={toggleEnabled}
        className={`w-full flex items-center justify-center gap-2 px-3 py-2 text-[12px] font-medium uppercase tracking-[0.15em] transition-colors border ${
          enabled
            ? "bg-primary text-primary-foreground border-primary"
            : "bg-transparent text-foreground border-border hover:border-muted-foreground"
        }`}
        data-testid="drawing-toggle"
      >
        <Pencil size={13} />
        {enabled ? "Drawing · Active" : "Enable Drawing"}
      </button>

      {/* Upload a lesion/ROI file directly as the editable drawing — erase or
          continue drawing it. Requires the file's voxel grid to match the base
          scan exactly. (Replaces the old "Upload ROI" section too.) */}
      <FileUploader
        label="Load Mask File"
        description=".nii / .nii.gz — loads as an editable drawing (erase or continue)"
        accept=".nii,.nii.gz"
        onFile={handleEditLesionFile}
        testId="drawing-edit-lesion-upload"
      />

      {/* All controls below are visible whenever the section is open (item 41),
          not only while drawing is active. */}

      {/* Tool selection: Pen (top row) and Brush (bottom row with 2D/3D toggle) */}
      <div className="space-y-1.5">
        <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">tool</div>
        {/* Pen row */}
        {tools.map((t) => {
          const active = enabled && tool === t.id;
          return (
            <div key={t.id} className="flex items-center gap-1">
              <button
                onClick={() => changeTool(t.id)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
                }`}
                data-testid={`pen-${t.id}`}
              >
                {React.createElement(t.icons[0], { size: 11 })}
                <span>{t.label}</span>
                {React.createElement(t.icons[1], { size: 11, className: "opacity-60" })}
              </button>
              {/* 2D/3D brush mode toggle — only shown on the Brush row */}
              {t.id === "brush" && (
                <div className={`flex border transition-all duration-700 ${
                  tool === "brush" || flashBrushMode ? "border-border opacity-100" : "border-transparent opacity-30 pointer-events-none"
                }`}>
                  {["2D", "3D"].map((m) => {
                    const active = brushMode === m && (tool === "brush" || flashBrushMode);
                    return (
                      <button
                        key={m}
                        onClick={() => changeBrushMode(m)}
                        className={`px-2 py-1.5 text-[10px] font-mono uppercase tracking-[0.1em] transition-colors ${
                          active
                            ? "bg-primary text-primary-foreground"
                            : "bg-transparent text-muted-foreground hover:text-foreground"
                        }`}
                        title={m === "3D" ? "3D sphere stamp across all slices" : "2D disc stamp on the current slice"}
                        data-testid={`brush-mode-${m.toLowerCase()}`}
                      >
                        {m === "3D" ? <Box size={11} /> : <Square size={11} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Brush radius (voxels 1..30) — shown whenever Brush tool is active.
          Controls both 3D sphere and 2D circle stamp radius. */}
      {tool === "brush" && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
              brush radius
            </span>
            <span className="font-mono text-[10px] text-foreground tabular-nums">{brushRadius} vox</span>
          </div>
          <Slider
            value={[brushRadius]}
            min={1}
            max={30}
            step={1}
            onValueChange={(v) => changeBrushRadius(v[0])}
            data-testid="brush-radius-slider"
          />
        </div>
      )}

      {/* Pen value (label color) */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">label value</span>
          <span className="font-mono text-[10px] text-foreground tabular-nums">{penValue}</span>
        </div>
        <div className="grid grid-cols-6 gap-1">
          {[1, 2, 3, 4, 5, 6].map((v) => (
            <button
              key={v}
              onClick={() => changePenValue(v)}
              className={`py-1.5 text-[10px] font-mono transition-colors border ${
                penValue === v
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-transparent text-muted-foreground border-border hover:border-muted-foreground"
              }`}
              data-testid={`pen-value-${v}`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Shares the topbar's crosshair toggle — same state, same effect everywhere. */}
      <label className="flex items-center justify-between cursor-pointer">
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">show crosshair</span>
        <button
          onClick={onToggleCrosshair}
          className={`relative inline-flex h-4 w-8 transition-colors border ${
            crosshair ? "bg-primary border-primary" : "bg-transparent border-border"
          }`}
          data-testid="drawing-crosshair-toggle"
        >
          <span
            className={`inline-block h-3 w-3 transition-transform ${
              crosshair ? "translate-x-4 bg-primary-foreground" : "translate-x-0 bg-muted-foreground"
            }`}
          />
        </button>
      </label>

      {/* Opacity */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">draw opacity</span>
          <span className="font-mono text-[10px] text-foreground tabular-nums">{Math.round(opacity * 100)}%</span>
        </div>
        <Slider
          value={[opacity * 100]}
          max={100}
          step={1}
          onValueChange={(v) => changeOpacity(v[0] / 100)}
          data-testid="draw-opacity-slider"
        />
      </div>

      {/* Spherical ROI — paints a sphere into the SAME drawing, at the current label. */}
      <div className="space-y-1.5 border-t border-border pt-3" data-testid="draw-sphere">
        <SectionLabel icon={Target}>add sphere (MNI mm)</SectionLabel>
        <div className="grid grid-cols-3 gap-1.5">
          {num(sphere.x, (v) => setSphereField("x", v), "sphere-x")}
          {num(sphere.y, (v) => setSphereField("y", v), "sphere-y")}
          {num(sphere.z, (v) => setSphereField("z", v), "sphere-z")}
        </div>
        <button
          onClick={useSphereCrosshair}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground"
          data-testid="sphere-use-crosshair"
        >
          <Crosshair size={11} />Use crosshair
        </button>
        <div className="grid grid-cols-[1fr_auto] gap-1.5 items-center">
          <input
            type="number" min="0" step="0.5" value={sphere.r}
            onChange={(e) => setSphereField("r", e.target.value)}
            className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
            placeholder="radius (mm)"
            data-testid="sphere-radius"
          />
          <button
            onClick={addSphere}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:border-muted-foreground"
            data-testid="sphere-add"
          >
            <Target size={11} />Add
          </button>
        </div>
      </div>

      {/* Interpolate: last-2 (left) vs ALL adjacent same-orientation slices
          (right, item 62) — the right one is a split button: the main part
          runs "All" against the RESOLVED orientation (the most recent drawn
          stroke's view, unless picked otherwise since); the chevron opens a
          menu to pick Axial/Coronal/Sagittal until the next stroke. Shift+I (Dashboard.jsx)
          calls the exact same interpolateAllDrawnSlices(), so it always
          agrees with this button (item 3). */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => viewerRef.current?.interpolateDrawnSlices?.()}
          disabled={!canInterpolate}
          className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-foreground disabled:hover:border-border"
          data-testid="draw-interpolate"
          title="Fill the gap between the last two slices you drew in the same view (axial/coronal/sagittal)"
        >
          <AlignVerticalSpaceAround size={11} />
          Interpolate last 2
        </button>
        <div className="relative flex" ref={interpolateMenuRef}>
          <button
            onClick={() => viewerRef.current?.interpolateAllDrawnSlices?.()}
            disabled={!canInterpolateAll}
            className="min-w-0 flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border border-r-0 bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-foreground disabled:hover:border-border"
            data-testid="draw-interpolate-all"
            title={`Fill between every pair of adjacent drawn slices in the ${orientationLabel} view (Shift+I)`}
          >
            <AlignVerticalSpaceAround size={11} className="shrink-0" />
            <span className="truncate">{`Interpolate All (${orientationLabel})`}</span>
          </button>
          <button
            onClick={() => setInterpolateMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={interpolateMenuOpen}
            aria-label="Choose Interpolate All orientation"
            className="shrink-0 px-1 py-1.5 border transition-colors bg-transparent text-foreground border-border hover:text-foreground hover:border-muted-foreground"
            data-testid="draw-interpolate-all-menu-toggle"
          >
            <ChevronDown size={11} />
          </button>
          {interpolateMenuOpen && (
            <div
              role="menu"
              aria-label="Interpolate All orientation"
              className="absolute right-0 top-full z-50 mt-1 w-48 border border-border bg-panel p-1 shadow-lg"
              data-testid="draw-interpolate-all-menu"
            >
              {/* No separate "Auto" row: every new stroke re-selects the view
                  it was drawn in (recordDrawEntry in NiivueViewer), so the
                  selected row IS the last drawn view unless you've picked
                  another since. Outline = selected; greyed = fewer than two
                  drawn slices in that view, so Interpolate All can't run. */}
              {[
                { key: "axial", value: 0, label: "Axial" },
                { key: "coronal", value: 1, label: "Coronal" },
                { key: "sagittal", value: 2, label: "Sagittal" },
              ].map((opt) => {
                const active = resolvedOrientation === opt.value;
                const valid = !!validOrientations[opt.value];
                return (
                  <button
                    key={opt.key}
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={!valid}
                    onClick={() => chooseInterpolateOrientation(opt.value)}
                    title={valid ? undefined : `Draw on at least two ${opt.label.toLowerCase()} slices first`}
                    className={`w-full px-2 py-1.5 text-left text-[10px] uppercase tracking-[0.1em] transition-colors border ${
                      active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground"
                    } ${valid ? "hover:bg-panel-hover hover:text-foreground" : "opacity-40 cursor-not-allowed"}`}
                    data-testid={`draw-interpolate-all-opt-${opt.key}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Morphological operations (non-destructive · undoable) */}
      <div className="space-y-1.5">
        <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">morphology</div>
        <div className="grid grid-cols-3 gap-1">
          <button onClick={() => morph("dilate")} className={ghostBtnCls} data-testid="draw-dilate">
            <Expand size={11} />Dilate
          </button>
          <button onClick={() => morph("erode")} className={ghostBtnCls} data-testid="draw-erode">
            <Shrink size={11} />Erode
          </button>
          <button onClick={() => morph("smooth")} className={ghostBtnCls} data-testid="draw-smooth">
            <Waves size={11} />Smooth
          </button>
        </div>
      </div>

      {/* Undo / Redo */}
      <div className="grid grid-cols-2 gap-1.5">
        <button onClick={() => viewerRef.current?.drawUndo()} disabled={!canUndo} className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground disabled:hover:border-border" data-testid="drawing-undo" title="Undo (Ctrl+Z)">
          <Undo2 size={11} />Undo
        </button>
        <button onClick={() => viewerRef.current?.drawRedo()} disabled={!canRedo} className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground disabled:hover:border-border" data-testid="drawing-redo" title="Redo (Ctrl+Shift+Z)">
          <Redo2 size={11} />Redo
        </button>
      </div>

      {/* Save (→ named layer, no download) / Clear */}
      <div className="space-y-1.5 border-t border-border pt-3">
        <input
          type="text"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          placeholder="name for saved mask…"
          className="w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5"
          data-testid="drawing-save-name"
        />
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => viewerRef.current?.drawClear()}
            className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-destructive border-border hover:border-destructive"
            data-testid="drawing-clear"
          >
            <Trash2 size={11} />Clear
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-primary text-primary-foreground border-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="drawing-save"
          >
            <Save size={11} />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        <button
          onClick={handleDownloadCurrent}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground"
          data-testid="drawing-download"
        >
          <Download size={11} />Download current drawing
        </button>
      </div>

      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-subtle leading-relaxed">
        draw freehand or add spheres into one mask. Save adds it to the layer list as a named overlay (no download) and clears the canvas for the next; Download is separate.
      </div>

      {qcPrompt && (
        <LesionQcDialog
          open
          flags={qcPrompt.flags}
          actionLabel={qcPrompt.actionLabel}
          verdict={qcPrompt.verdict}
          onConfirm={() => { acceptedQcIdRef.current = qcPrompt.lesionId; qcPrompt.resolve(true); setQcPrompt(null); }}
          onCancel={() => { qcPrompt.resolve(false); setQcPrompt(null); }}
          // Both of these mean "don't save yet": the save is cancelled exactly
          // as Keep editing would, then the viewer does the helpful thing.
          onGoTo={(mm) => {
            qcPrompt.resolve(false); setQcPrompt(null);
            viewerRef.current?.setCrosshairMM?.(mm[0], mm[1], mm[2]);
          }}
          onInterpolate={() => {
            qcPrompt.resolve(false); setQcPrompt(null);
            viewerRef.current?.interpolateAllDrawnSlices?.();
          }}
        />
      )}
    </div>
  );
};

export default DrawingPanel;
