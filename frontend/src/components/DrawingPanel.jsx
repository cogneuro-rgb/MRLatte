import React, { useState } from "react";
import { Pencil, Eraser, Save, Trash2, Undo2, Expand, Shrink, Waves } from "lucide-react";
import { toast } from "sonner";
import { Slider } from "@/components/ui/slider";
import { uploadLesion } from "@/lib/lesions";

/**
 * DrawingPanel - MRIcroGL-style lesion drawing controls.
 * Niivue's built-in drawing API: setDrawingEnabled, setPenValue,
 * penType (PEN), drawOpacity, drawUndo, saveImage({ filename, isSaveDrawing: true }).
 * Pen paints the selected label value; the eraser is the freehand pen with
 * pen value 0 (Niivue treats penValue 0 as erase).
 */
export const DrawingPanel = ({ viewerRef, baseName }) => {
  const [enabled, setEnabled] = useState(false);
  const [tool, setTool] = useState("pen"); // "pen" | "eraser"
  const [penValue, setPenValue] = useState(1);
  const [opacity, setOpacity] = useState(0.8);
  const [showCrosshair, setShowCrosshair] = useState(false);
  const [saving, setSaving] = useState(false);

  const applyDraw = (t = tool) => {
    viewerRef.current?.setClickToSegment?.(false);
    viewerRef.current?.setDrawingEnabled(true, !showCrosshair);
    viewerRef.current?.setPenType("pen");
    viewerRef.current?.setPenValue(t === "eraser" ? 0 : penValue, true);
    viewerRef.current?.setDrawOpacity(opacity);
  };

  const toggleEnabled = () => {
    const next = !enabled;
    if (next) {
      applyDraw();
    } else {
      viewerRef.current?.setClickToSegment?.(false);
      viewerRef.current?.setDrawingEnabled(false, true);
    }
    setEnabled(next);
  };

  const toggleCrosshair = () => {
    const next = !showCrosshair;
    setShowCrosshair(next);
    if (enabled) viewerRef.current?.setCrosshairWhileDrawing(next);
  };

  const changeTool = (t) => {
    setTool(t);
    if (enabled) viewerRef.current?.setPenValue(t === "eraser" ? 0 : penValue, true);
  };

  const changePenValue = (v) => {
    setPenValue(v);
    if (!enabled || tool !== "pen") return;
    viewerRef.current?.setPenValue(v, true);
  };

  const changeOpacity = (v) => {
    setOpacity(v);
    if (enabled) viewerRef.current?.setDrawOpacity(v);
  };

  // Non-destructive morphological op on the scratch drawing (undoable).
  const morph = (op) => {
    const ok = viewerRef.current?.drawMorph?.(op);
    if (ok) toast.success(`${op[0].toUpperCase()}${op.slice(1)} applied`, { description: "Undo to revert" });
  };

  // Save the drawn lesion to BOTH the local machine (download) and the server.
  // Prompts for a name that identifies/organises the lesion server-side.
  const handleSave = async () => {
    const name = window.prompt("Name this lesion (case / patient):");
    if (!name || !name.trim()) return; // cancelled or empty → abort
    const trimmed = name.trim();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const slug = trimmed.replace(/[^a-z0-9_-]/gi, "_").replace(/^[._]+|[._]+$/g, "") || "lesion";

    setSaving(true);
    try {
      // 1) Local download (unchanged behaviour).
      const ok = await viewerRef.current?.saveDrawing(`lesion_${slug}_${ts}.nii.gz`);
      if (!ok) return; // saveDrawing already surfaced an error toast

      // 2) Server upload of the same drawing bytes.
      const bytes = await viewerRef.current?.getDrawingBytes();
      if (!bytes) {
        toast.warning("Lesion downloaded, but could not read bytes to upload");
        return;
      }
      try {
        await uploadLesion(bytes, trimmed, baseName);
        toast.success("Lesion saved (server + download)");
      } catch (e) {
        toast.error("Saved locally, but server upload failed", {
          description: e?.message,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const tools = [
    { id: "pen", icon: Pencil, label: "Pen" },
    { id: "eraser", icon: Eraser, label: "Eraser" },
  ];

  return (
    <div className="space-y-3" data-testid="drawing-panel">
      <button
        onClick={toggleEnabled}
        className={`w-full flex items-center justify-center gap-2 px-3 py-2 text-[12px] font-medium uppercase tracking-[0.15em] transition-colors border ${
          enabled
            ? "bg-white text-black border-white"
            : "bg-transparent text-zinc-200 border-[#27272A] hover:border-zinc-500"
        }`}
        data-testid="drawing-toggle"
      >
        <Pencil size={13} />
        {enabled ? "Drawing · Active" : "Enable Drawing"}
      </button>

      {enabled && (
        <>
          {/* Tool: pen vs eraser */}
          <div className="space-y-1.5">
            <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
              tool
            </div>
            <div className="grid grid-cols-2 gap-1">
              {tools.map((t) => {
                const Icon = t.icon;
                const active = tool === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => changeTool(t.id)}
                    className={`flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border ${
                      active
                        ? "bg-white text-black border-white"
                        : "bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
                    }`}
                    data-testid={`pen-${t.id}`}
                  >
                    <Icon size={11} />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Pen value (label color) — only relevant for the pen */}
          {tool === "pen" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
                  label value
                </span>
                <span className="font-mono text-[10px] text-zinc-300 tabular-nums">{penValue}</span>
              </div>
              <div className="grid grid-cols-6 gap-1">
                {[1, 2, 3, 4, 5, 6].map((v) => (
                  <button
                    key={v}
                    onClick={() => changePenValue(v)}
                    className={`py-1.5 text-[10px] font-mono transition-colors border ${
                      penValue === v
                        ? "bg-white text-black border-white"
                        : "bg-transparent text-zinc-400 border-[#27272A] hover:border-zinc-500"
                    }`}
                    data-testid={`pen-value-${v}`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Crosshair-while-drawing toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
              show crosshair
            </span>
            <button
              onClick={toggleCrosshair}
              className={`relative inline-flex h-4 w-8 transition-colors border ${
                showCrosshair ? "bg-white border-white" : "bg-transparent border-[#27272A]"
              }`}
              data-testid="drawing-crosshair-toggle"
            >
              <span
                className={`inline-block h-3 w-3 transition-transform ${
                  showCrosshair ? "translate-x-4 bg-black" : "translate-x-0 bg-zinc-500"
                }`}
              />
            </button>
          </label>

          {/* Opacity */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
                draw opacity
              </span>
              <span className="font-mono text-[10px] text-zinc-300 tabular-nums">
                {Math.round(opacity * 100)}%
              </span>
            </div>
            <Slider
              value={[opacity * 100]}
              max={100}
              step={1}
              onValueChange={(v) => changeOpacity(v[0] / 100)}
              data-testid="draw-opacity-slider"
            />
          </div>

          {/* Morphological operations (non-destructive · undoable) */}
          <div className="space-y-1.5">
            <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
              morphology
            </div>
            <div className="grid grid-cols-3 gap-1">
              <button
                onClick={() => morph("dilate")}
                className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
                data-testid="draw-dilate"
              >
                <Expand size={11} />
                Dilate
              </button>
              <button
                onClick={() => morph("erode")}
                className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
                data-testid="draw-erode"
              >
                <Shrink size={11} />
                Erode
              </button>
              <button
                onClick={() => morph("smooth")}
                className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
                data-testid="draw-smooth"
              >
                <Waves size={11} />
                Smooth
              </button>
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-3 gap-1.5">
            <button
              onClick={() => viewerRef.current?.drawUndo()}
              className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
              data-testid="drawing-undo"
            >
              <Undo2 size={11} />
              Undo
            </button>
            <button
              onClick={() => viewerRef.current?.drawClear()}
              className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-[#FF3B30] border-[#27272A] hover:border-[#FF3B30]"
              data-testid="drawing-clear"
            >
              <Trash2 size={11} />
              Clear
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-white text-black border-white hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="drawing-save"
            >
              <Save size={11} />
              {saving ? "Saving…" : "Save"}
            </button>
          </div>

          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600 leading-relaxed">
            click + drag to draw; switch to eraser to remove. save prompts for a name and stores the lesion (.nii.gz) on the server and downloads a copy.
          </div>
        </>
      )}
    </div>
  );
};

export default DrawingPanel;
