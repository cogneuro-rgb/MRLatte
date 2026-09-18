import React, { useRef, useState, useEffect } from "react";
import { Waypoints, Loader2, AlertCircle, X, Download, FileCode, Eye, EyeOff, Sun, Scissors, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { SidebarSection } from "@/components/SidebarSection";
import FileUploader from "@/components/FileUploader";
import { Slider } from "@/components/ui/slider";
import { ToggleButton } from "@/components/ui/toggle-button";
import { extractBaseName } from "@/lib/utils";
import { serialUpload } from "@/lib/uploadUtils";
import { tractResultUrl } from "@/lib/tractDissection";
import { DEFAULT_TRACT_RENDER } from "@/lib/gl/tractSettings";
import { useClickOutside } from "@/hooks/use-click-outside";
import { buildReport } from "@/lib/report";
import { ReportDialog } from "@/components/ReportDialog";

const COLOR_MODES = [
  { id: "direction", label: "Direction" },
  { id: "palette", label: "Palette" },
  { id: "solid", label: "Solid" },
];

// Pseudotubes: lib/gl/tractBuffers.js's compacted instanced buffer +
// tractRenderer.js's instanced draw path make 'tubes' a real, functional
// geometry. Points reuses the SAME mesh.__tract
// instanced buffers as tubes (tractBuffers.js does not distinguish geometry
// at all) and the same drawArraysInstanced(TRIANGLE_STRIP, 0, 4, nSegments)
// call in tractRenderer.js's bindTractGeometry/emit — only the compiled
// program differs (getTractProgram's #define POINTS_MODE, tractPrograms.js).
// No geometry mode is disabled anymore.
const GEOMETRY_MODES = [
  { id: "tubes", label: "Pseudotubes", disabled: false },
  { id: "lines", label: "Lines", disabled: false },
  { id: "points", label: "Points", disabled: false },
];

// Global tractography rendering controls: geometry, thickness,
// lighting, crop-to-slab, and display-fraction. Rendered once above the
// per-tract card list, never per-tract.
function TractRenderingControls({ tractRender, onChange, tractLayers }) {
  const { geometry, lighting, thicknessUI, slabMM, displayPct } = tractRender;
  // "showing N / M streamlines" readout, aggregated across
  // every loaded tract — decimation (whether from meshApi's load-time
  // autoStrideFor or this slider) must never be invisible. shownStreamlines
  // is kept in sync with the CURRENT stride by useTracts.js's
  // handleTractRenderChange (on every slider tick, not just after the
  // debounced rebuild lands) and by tractCountsFromMesh at load time.
  const totalStreamlines = tractLayers.reduce((sum, t) => sum + (t.nStreamlines || 0), 0);
  const shownStreamlines = tractLayers.reduce((sum, t) => sum + (t.shownStreamlines ?? t.nStreamlines ?? 0), 0);
  // Lighting is meaningful for both lit geometries — Pseudotubes
  // (TUBE normal) and Points (fragment-derived sphere normal) — and disabled
  // only for Lines, which has no usable normal (TRACT_VERT_LINES never
  // declares one; getTractProgram never defines LIGHTING for 'lines' even if
  // this flag is true — see tractPrograms.js).
  const lightingDisabled = geometry === "lines";
  return (
    <div className="space-y-2.5 border border-border bg-panel px-3 py-2.5 mb-2" data-testid="tract-rendering-controls">
      <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">Rendering</div>

      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">geometry</span>
        <div className="flex border border-border">
          {GEOMETRY_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => onChange({ geometry: m.id })}
              disabled={m.disabled}
              className={`px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] transition-colors ${
                m.disabled
                  ? "bg-transparent text-muted-foreground/40 cursor-not-allowed"
                  : geometry === m.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`tract-geometry-${m.id}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">thickness</span>
          <span className="font-mono text-[10px] text-muted-foreground">{thicknessUI}</span>
        </div>
        {/* thicknessUI drives tractRenderStateRef's
            thicknessMM (via sliderToThicknessMM, NiivueViewer.jsx's
            setTractRenderOptions) which the instanced-tube vertex shader
            reads as a per-frame uniform (uniform-only change, never a
            rebuild). Meaningful for Pseudotubes only (screen-space,
            per-tube); Lines has no usable thickness control, but the slider
            is left interactive regardless of geometry rather than re-gating
            it — matching the Lighting toggle's simpler on/off gating was
            explicitly NOT requested for this control by the spec. */}
        <Slider value={[thicknessUI]} max={100} step={1}
          onValueChange={(v) => onChange({ thicknessUI: v[0] })}
          data-testid="tract-thickness-slider" />
      </div>

      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">lighting</span>
        <ToggleButton
          pressed={lighting}
          onPressedChange={(v) => onChange({ lighting: v })}
          disabled={lightingDisabled}
          title={lightingDisabled ? "Enable Pseudotubes or Points geometry to use lighting" : "Toggle headlight shading"}
          icon={Sun}
          label="Lighting"
          testId="tract-lighting-toggle"
        />
      </div>

      {/* The 3D shader-side slab discard is disabled — this control drives ONLY
          niivue's meshThicknessOn2D (2D slice tiles), never the 3D render.
          Label/title name that scope so it's obvious from the sidebar alone;
          do not restore wording that reads as a global/3D control.
          There is no on/off toggle — the slab is always active — replaced by
          a Reset button that restores the default. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">crop to slab (2D slices)</span>
          <button
            onClick={() => onChange({ slabMM: DEFAULT_TRACT_RENDER.slabMM })}
            className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors"
            title={`Reset slab thickness to the default (${DEFAULT_TRACT_RENDER.slabMM}mm)`}
            data-testid="tract-slab-reset"
          >reset</button>
        </div>
        <div className="flex items-center gap-2">
          <Slider value={[slabMM]} min={0.5} max={50} step={0.5}
            onValueChange={(v) => onChange({ slabMM: v[0] })}
            className="flex-1" data-testid="tract-slab-slider"
            title="Slab thickness applied to the 2D slice views only. The 3D render is never cropped." />
          <span className="font-mono text-[10px] text-foreground tabular-nums w-12 text-right">
            {slabMM.toFixed(1)}mm
          </span>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">display fraction</span>
          <span className="font-mono text-[10px] text-muted-foreground">{displayPct}%</span>
        </div>
        {/* Wired to fiberDecimationStride via pctToStride.
            onChange (useTracts.js's handleTractRenderChange) updates the
            slider label + every tract's shownStreamlines readout on every
            tick (cheap, no GL), and separately debounces the actual
            mesh.updateFibers() rebuild 150ms — never nv.setMeshProperty
            (the one exception: display-fraction changes MAY rebuild). */}
        <Slider value={[displayPct]} min={1} max={100} step={1}
          onValueChange={(v) => onChange({ displayPct: v[0] })}
          data-testid="tract-display-fraction-slider" />
        {/* "decimation is never invisible": shown here whether the
            current stride came from this slider or from meshApi's load-time
            autoStrideFor safety net. */}
        {totalStreamlines > 0 && (
          <div className="font-mono text-[9px] text-muted-foreground mt-1" data-testid="tract-display-fraction-readout">
            showing {shownStreamlines.toLocaleString()} / {totalStreamlines.toLocaleString()} streamlines
          </div>
        )}
      </div>
    </div>
  );
}

// 3-way tract color-mode control. "Solid" reveals a swatch button
// that opens a small color-wheel popover (native <input type="color"> + hex
// text field) — same dismiss-on-click-outside pattern as the crosshair/clip
// popovers in Dashboard.jsx.
function TractColorControl({ tract, onModeChange, onSolidColorChange }) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef(null);
  useClickOutside(popoverRef, () => setOpen(false), open);
  const mode = tract.colorMode || (tract.direction ? "direction" : "palette");

  return (
    <div className="space-y-1.5 mb-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">color</span>
        <div className="flex items-center gap-1">
          <div className="flex border border-border">
            {COLOR_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => onModeChange(m.id)}
                className={`px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] transition-colors ${
                  mode === m.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`tract-color-mode-${m.id}-${tract.id}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {mode === "solid" && (
            <div className="relative" ref={popoverRef}>
              <button
                onClick={() => setOpen((v) => !v)}
                className="h-4 w-6 border border-border"
                style={{ background: tract.solidColor || "#c8c8c8" }}
                title="Pick tract color"
                data-testid={`tract-color-swatch-${tract.id}`}
              />
              {open && (
                <div className="absolute right-0 top-full z-50 mt-1 w-40 border border-border bg-panel p-2 space-y-1.5 shadow-lg"
                  data-testid={`tract-color-popover-${tract.id}`}>
                  <input
                    type="color"
                    value={tract.solidColor || "#c8c8c8"}
                    onChange={(e) => onSolidColorChange(e.target.value)}
                    className="w-full h-7 cursor-pointer bg-transparent border border-border"
                    data-testid={`tract-color-wheel-${tract.id}`}
                  />
                  <input
                    type="text"
                    value={tract.solidColor || "#c8c8c8"}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (/^#[0-9a-fA-F]{6}$/.test(v)) onSolidColorChange(v);
                    }}
                    className="w-full bg-background border border-border text-foreground font-mono text-[10px] px-1.5 py-1 focus:outline-none focus:border-muted-foreground"
                    data-testid={`tract-color-hex-${tract.id}`}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Tractography sidebar section: load a tract file, and manage each loaded
 * tract's visibility/opacity/color mode (direction / palette / solid), plus
 * (for tracts saved from Tract Dissection) stats, downloads, and an HTML
 * report.
 *
 * Extracted from Dashboard.jsx; behaviour and markup are unchanged — this is
 * a relocation, not a redesign.
 */
export function TractographySection({
  open,
  onOpenChange,
  autoExpandId,
  tractLayers,
  tractLoading,
  tractLoadError,
  setTractLoadError,
  handleTractUpload,
  handleTractRemove,
  handleTractColorMode,
  handleTractSolidColor,
  handleTractOpacity,
  buildTractReportModelFor,
  tractRender,
  handleTractRenderChange,
  handleTractVisible,
  handleTractClip,
  layerNotes,
  onNotesChange,
}) {
  // Item 103: one shared report dialog, showing whichever tract's report was
  // last opened (each card's own "Report" button targets this same dialog).
  const [reportTractId, setReportTractId] = useState(null);
  const reportModel = reportTractId
    ? buildTractReportModelFor?.(tractLayers.find((l) => l.id === reportTractId) || {})
    : null;
  const [expandedTracts, setExpandedTracts] = useState({});

  useEffect(() => {
    if (tractLayers.length === 1) {
      setExpandedTracts(prev => ({ ...prev, [tractLayers[0].id]: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tractLayers.length]);

  useEffect(() => {
    if (autoExpandId) {
      setExpandedTracts(prev => ({ ...prev, [autoExpandId]: true }));
    }
  }, [autoExpandId]);

  const toggleTractExpanded = (id) => {
    setExpandedTracts(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <SidebarSection title="Tractography" icon={Waypoints} testId="section-tracts" open={open} onOpenChange={onOpenChange}
      badge={tractLayers.filter((l) => l.visible).length}>
      <FileUploader label="Load Tract File(s)" description=".trk / .tck / .trx / .vtk / .gii / .mz3 — multi-select supported"
        accept=".trk,.tck,.trx,.vtk,.gii,.mz3,.obj,.stl,.ply"
        testId="upload-tract-button" multiple
        onFiles={serialUpload((f) => handleTractUpload(f))}
        onFile={handleTractUpload}
        disabled={!!tractLoading} />
      {tractLoading && (
        <div className="border border-border bg-panel px-3 py-2.5 mt-2">
          <div className="flex items-center gap-2">
            <Loader2 size={11} className="animate-spin text-muted-foreground flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="truncate text-[12px] text-foreground">{tractLoading.name}</div>
              <div className="font-mono text-[10px] text-muted-foreground animate-pulse mt-0.5">{tractLoading.phase}</div>
            </div>
          </div>
          <div className="mt-2 h-px w-full bg-border overflow-hidden">
            <div className="h-px bg-foreground/60 animate-pulse" style={{ width: "100%" }} />
          </div>
        </div>
      )}
      {tractLoadError && (
        <div className="border border-destructive/40 bg-panel px-3 py-2.5 mt-2">
          <div className="flex items-start gap-2">
            <AlertCircle size={11} className="text-destructive mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-destructive">Failed to load</div>
              <div className="font-mono text-[10px] text-muted-foreground mt-0.5 break-all">{tractLoadError.name}</div>
              <div className="font-mono text-[10px] text-muted-foreground mt-1 break-words">{tractLoadError.message}</div>
            </div>
            <button onClick={() => setTractLoadError(null)} className="text-subtle hover:text-muted-foreground flex-shrink-0">
              <X size={11} />
            </button>
          </div>
        </div>
      )}
      {tractLayers.length > 0 && (
        <div className="space-y-1.5 mt-2">
          {tractRender && handleTractRenderChange && (
            <TractRenderingControls tractRender={tractRender} onChange={handleTractRenderChange} tractLayers={tractLayers} />
          )}
          {tractLayers.map((t) => (
            <div key={t.id} className="group border border-border bg-panel hover:bg-panel-hover transition-colors px-3 py-2.5" data-testid={`tract-${t.id}`}>
              {/* Identity row: swatch | name/description | actions (remove, expand) —
                  same shape/order as the LayerControlAdvanced cards (item 119). */}
              <div className="flex items-start gap-2">
                <span className="mt-1 h-3 w-3 flex-shrink-0" style={{
                  background: (t.colorMode || (t.direction ? "direction" : "palette")) === "direction"
                    ? "linear-gradient(45deg, #ff3b30, #34c759, #007aff)"
                    : (t.colorMode === "solid" ? (t.solidColor || "#c8c8c8") : t.color),
                }} />
                <div className="flex-1 min-w-0">
                  <div
                    className="truncate text-[12px] text-foreground cursor-pointer"
                    title={t.fullPath || t.name}
                    onClick={() => toggleTractExpanded(t.id)}
                  >
                    {t.name}
                  </div>
                  <div
                    className="font-mono text-[10px] text-muted-foreground truncate mt-0.5 cursor-pointer"
                    onClick={() => toggleTractExpanded(t.id)}
                  >
                    {t.description}
                  </div>
                  {onNotesChange && (
                    <textarea
                      value={layerNotes?.[t.id] || ""}
                      onChange={(e) => onNotesChange(t.id, e.target.value)}
                      placeholder="Add notes…"
                      rows={1}
                      title={t.fullPath ? `File: ${t.fullPath}` : undefined}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1 w-full resize-y bg-background border border-border text-foreground font-mono text-[10px] px-1.5 py-1 leading-snug placeholder:text-subtle focus:outline-none focus:border-muted-foreground"
                      data-testid={`notes-${t.id}`}
                    />
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button onClick={() => handleTractRemove(t.id)}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                    data-testid={`remove-${t.id}`}
                    title="Remove tract">
                    <Trash2 size={10} />
                  </button>
                  <button
                    onClick={() => toggleTractExpanded(t.id)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    data-testid={`expand-tract-${t.id}`}
                    aria-label={expandedTracts[t.id] ? "Collapse controls" : "Expand controls"}
                  >
                    {expandedTracts[t.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                </div>
              </div>

              {/* Primary controls: visibility, opacity, clip — same row/order
                  as every other card type, always available (not gated behind
                  expand), mirroring LayerControlAdvanced. */}
              <div className="flex items-center gap-2 pt-2">
                {handleTractVisible && (
                  <ToggleButton
                    pressed={!!t.visible}
                    onPressedChange={(v) => handleTractVisible(t.id, v)}
                    icon={t.visible ? Eye : EyeOff}
                    testId={`tract-visible-${t.id}`}
                    title={t.visible ? "Hide tract" : "Show tract"}
                  />
                )}
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-subtle w-12 flex-shrink-0">opacity</span>
                  <Slider value={[t.opacity * 100]} max={100} step={1}
                    onValueChange={(v) => handleTractOpacity(t.id, v[0] / 100)}
                    className="cursor-pointer flex-1"
                    data-testid={`opacity-${t.id}`} />
                  <span className="font-mono text-[10px] text-muted-foreground tabular-nums w-8 text-right">{Math.round(t.opacity * 100)}%</span>
                </div>
                {handleTractClip && (() => {
                  const clipOn = t.clip !== false; // default true, matches mesh.__tractClip's default
                  return (
                    <ToggleButton
                      pressed={clipOn}
                      onPressedChange={(v) => handleTractClip(t.id, v)}
                      icon={Scissors}
                      label="Clip"
                      testId={`tract-clip-${t.id}`}
                      title="Clip this tract to the 3D clip plane"
                    />
                  );
                })()}
              </div>

              {/* Advanced/collapsible: color mode + (for dissection-saved
                  tracts) stats/downloads/report. */}
              {expandedTracts[t.id] && (
                <div className="pt-2 mt-2 border-t border-border">
                  <TractColorControl
                    tract={t}
                    onModeChange={(mode) => handleTractColorMode(t.id, mode)}
                    onSolidColorChange={(hex) => handleTractSolidColor(t.id, hex)}
                  />
                  {t.result && (
                    <div className="mt-2 space-y-1.5 border-t border-border pt-2">
                      <div className="space-y-0.5">
                        <div className="flex justify-between text-[11px]">
                          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Selected streamlines</span>
                          <span className="text-foreground">
                            {t.result.n_selected_streamlines.toLocaleString()} / {t.result.n_input_streamlines.toLocaleString()}{" "}
                            <span className="text-muted-foreground">
                              ({(100 * t.result.n_selected_streamlines / t.result.n_input_streamlines).toFixed(1)}%)
                            </span>
                          </span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Affected-tract volume</span>
                          <span className="text-foreground">{t.result.tract_volume_cm3.toFixed(3)} cm³</span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Affected voxels</span>
                          <span className="text-foreground">{t.result.affected_voxels.toLocaleString()}</span>
                        </div>
                      </div>
                      {t.result.files && (
                        <div className="grid grid-cols-2 gap-1.5">
                          <a href={tractResultUrl(t.result.files.nifti)} download
                            className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:border-muted-foreground no-underline"
                            data-testid={`tract-download-nifti-${t.id}`}>
                            <Download size={11} />NIfTI
                          </a>
                          <a href={tractResultUrl(t.result.files.trk)} download
                            className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:border-muted-foreground no-underline"
                            data-testid={`tract-download-trk-${t.id}`}>
                            <Download size={11} />.trk
                          </a>
                        </div>
                      )}
                      <button onClick={() => setReportTractId(t.id)}
                        className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-foreground border-border hover:border-muted-foreground"
                        data-testid={`tract-report-${t.id}`}>
                        <FileCode size={11} />Report
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <ReportDialog
        open={!!reportTractId}
        onOpenChange={(v) => { if (!v) setReportTractId(null); }}
        title="Tract Disconnection Report"
        subject={reportModel?.lesionName}
        html={reportModel ? buildReport("tract", reportModel) : null}
        filename={`tract_report_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`}
      />
    </SidebarSection>
  );
}

export default TractographySection;
