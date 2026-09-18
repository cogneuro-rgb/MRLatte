import React from "react";
import { Eye } from "lucide-react";
import { SidebarSection } from "@/components/SidebarSection";
import LayerControlAdvanced from "@/components/LayerControlAdvanced";
import { PolarAngleDisc, EccentricityBar } from "@/components/PolarAngleDisc";
import { VisualFieldMap2D } from "@/components/VisualFieldMap2D";
import { RETINOTOPY_LAYERS } from "@/lib/atlasConfig";
import { ModuleGate } from "@/components/ModuleGate";

/**
 * Retinotopy sidebar section: retinotopic atlas display layers, plus the
 * lesion × retinotopy visual-field deficit analysis (cortical Benson map and
 * the optional white-matter population template).
 *
 * Extracted from Dashboard.jsx; behaviour and markup are unchanged — this is
 * a relocation, not a redesign.
 */
export function RetinotopySection({
  retActive,
  overlayMeta,
  retState,
  handleRetToggle,
  handleRetOpacity,
  handleRetColormap,
  handleCalRangeChange,
  handleColorRangeChange,
  handleAutoColorRange,
  handleAutoThreshold,
  handleIgnoreZeroChange,
  handleInvertThresholdChange,
  histograms,
  requestHistogram,
  thresholdVolumes,
  scheduleThresholdVolume,
  lesionLayers,
  lesionPickerOpen,
  setLesionPickerOpen,
  selectedLesionIds,
  toggleLesionSelected,
  bensonViewMode,
  setBensonViewMode,
  bensonVfMap2dRef,
  benson2DGrid,
  polarOverlap,
  polarThresh,
  setPolarThresh,
  polarActive,
  baseLabel,
  eccenOverlap,
  eccenThresh,
  setEccenThresh,
  eccenInverted,
  handleEccenInvert,
  eccenActive,
  wmAvailable,
  wmVfMap2dRef,
  wm2DGrid,
  wmPolarOverlap,
  wmEccenOverlap,
  layerNotes,
  onNotesChange,
}) {
  return (
    <SidebarSection title="Retinotopy" icon={Eye} testId="section-retinotopy" defaultOpen={false} badge={retActive}>
      {/* Everything below needs the Benson/Wang retinotopy atlases. The gate
          wraps the section BODY rather than the section itself so the
          collapsible header stays where users expect it. */}
      <ModuleGate capability="retinotopy" label="Retinotopy">
      {/* ── Group 1: display overlays ─────────────────────────────────
          These four are just layers drawn on the scan. Labelling them
          separately from the deficit analysis below makes it obvious why
          the panel has "4 atlases and then 2 maps" (SMALL-FIXES 53). */}
      <div className="space-y-1.5">
        <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
          atlas layers
        </div>
        <div className="font-mono text-[9px] text-subtle leading-relaxed pb-0.5">
          Retinotopic maps overlaid on the scan. Toggling these only changes what
          you see — the deficit analysis below is computed independently.
        </div>
        {RETINOTOPY_LAYERS.map((l) => {
          const m = overlayMeta[l.id] || {};
          return (
            <LayerControlAdvanced
              key={l.id}
              layer={l}
              visible={retState[l.id].visible}
              opacity={retState[l.id].opacity}
              colormap={retState[l.id].colormap}
              globalMin={m.global_min}
              globalMax={m.global_max}
              calMin={m.cal_min}
              calMax={m.cal_max}
              colorMin={m.color_min}
              colorMax={m.color_max}
              hasZeroVoxels={m.hasZeroVoxels}
              ignoreZeroVoxels={m.ignoreZeroVoxels}
              invertThreshold={m.invertThreshold}
              onToggle={handleRetToggle}
              onOpacityChange={handleRetOpacity}
              onColormapChange={handleRetColormap}
              onCalRangeChange={handleCalRangeChange}
              onColorRangeChange={handleColorRangeChange}
              onAutoColorRange={handleAutoColorRange}
              onAutoThreshold={handleAutoThreshold}
              onIgnoreZeroChange={handleIgnoreZeroChange}
              onInvertThresholdChange={handleInvertThresholdChange}
              onRemove={() => retState[l.id].visible && handleRetToggle(l.id)}
              removable={retState[l.id].visible}
              histogram={histograms[l.id]}
              onRequestHistogram={requestHistogram}
              thresholdVolume={thresholdVolumes[l.id]}
              onRequestThresholdVolume={scheduleThresholdVolume}
              notes={layerNotes?.[l.id]}
              onNotesChange={onNotesChange}
            />
          );
        })}
      </div>


      {/* ── Group 2: analysis ────────────────────────────────────────
          Lesion × retinotopy ⇒ predicted visual-field deficit. Two maps:
          CORTICAL (Benson) and WHITE MATTER (population template). Both are
          computed from the selected lesion(s) — nothing here depends on the
          atlas-layer toggles above (SMALL-FIXES 53). */}
      <div className="border border-border bg-panel p-4 space-y-3" data-testid="retinotopy-deficit">
        <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
          visual field deficit
        </div>
        {/* Lesion-aware legend picker: shared between both wheels. Multi-select
            via checkboxes so the user can union several lesions or focus on one. */}
        {lesionLayers.length > 0 && (
          <div className="relative" data-testid="retinotopy-lesion-picker">
            <button
              type="button"
              onClick={() => setLesionPickerOpen((o) => !o)}
              className="w-full flex items-center justify-between px-2 py-1.5 border border-border bg-background text-foreground text-[11px] hover:text-foreground hover:border-muted-foreground"
              data-testid="retinotopy-lesion-picker-toggle"
            >
              <span className="font-mono uppercase tracking-[0.15em] text-[10px]">
                Lesions for overlap
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {selectedLesionIds.size} / {lesionLayers.length}
              </span>
            </button>
            {lesionPickerOpen && (
              <div className="mt-1 border border-border bg-background divide-y divide-border">
                {lesionLayers.map((l) => {
                  const checked = selectedLesionIds.has(l.id);
                  return (
                    <label
                      key={l.id}
                      className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-foreground cursor-pointer"
                      data-testid={`retinotopy-lesion-opt-${l.id}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleLesionSelected(l.id)}
                        className="accent-foreground"
                      />
                      <span className="truncate font-mono">{l.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {/* No lesion ⇒ nothing to compute. Say so explicitly instead of
            rendering a silently greyed-out map (SMALL-FIXES 53). */}
        {selectedLesionIds.size === 0 && (
          <div className="text-[10px] text-muted-foreground leading-relaxed" data-testid="retinotopy-deficit-empty">
            {lesionLayers.length === 0
              ? "Load or draw a lesion mask to compute the visual-field deficit."
              : "Select a lesion above to compute the visual-field deficit."}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            cortical (benson)
          </span>
          {/* ONE view toggle for BOTH maps — two separate toggles for what is
              the same choice was needless duplication. */}
          <button
            onClick={() => setBensonViewMode((v) => v === "2d" ? "classic" : "2d")}
            className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground border border-border px-2 py-0.5"
            data-testid="retinotopy-viewmode-toggle"
          >
            {bensonViewMode === "2d" ? "classic →" : "← 2D map"}
          </button>
        </div>
        {bensonViewMode === "2d" ? (
          <VisualFieldMap2D
            ref={bensonVfMap2dRef}
            gridResult={benson2DGrid}
            /* Gate on the lesion selection — the ONLY thing the deficit grid
               actually needs (benson2DGrid is null without it). It used to be
               gated on Benson LAYER VISIBILITY, so the map sat greyed out until
               you toggled an unrelated overlay on (SMALL-FIXES 53). */
            active={selectedLesionIds.size > 0}
            selectedCount={selectedLesionIds.size}
            label="Cortical Retinotopy (Benson)"
            summaryText={polarOverlap.summary}
            thresholdMode={polarThresh.mode}
            thresholdMin={polarThresh.min}
            onThresholdModeChange={(mode) => setPolarThresh((p) => ({ ...p, mode }))}
            onThresholdMinChange={(min) => setPolarThresh((p) => ({ ...p, min }))}
            baseLabel={baseLabel}
          />
        ) : (
          <>
            <PolarAngleDisc
              active={polarActive}
              colormap={retState.benson_polar_angle.colormap}
              arcSegments={polarOverlap.arcSegments}
              summaryText={polarOverlap.summary}
              thresholdMode={polarThresh.mode}
              thresholdMin={polarThresh.min}
              onThresholdModeChange={(mode) => setPolarThresh((p) => ({ ...p, mode }))}
              onThresholdMinChange={(min) => setPolarThresh((p) => ({ ...p, min }))}
              baseLabel={baseLabel}
              eccenColormap={retState.benson_eccentricity.colormap}
              eccenArcSegments={eccenOverlap.arcSegments}
              eccenSummaryText={eccenOverlap.summary}
              eccenInverted={eccenInverted}
            />
            <div className="my-3 h-px bg-border" />
            <EccentricityBar
              active={eccenActive}
              colormap={retState.benson_eccentricity.colormap}
              arcSegments={eccenOverlap.arcSegments}
              summaryText={eccenOverlap.summary}
              thresholdMode={eccenThresh.mode}
              thresholdMin={eccenThresh.min}
              onThresholdModeChange={(mode) => setEccenThresh((p) => ({ ...p, mode }))}
              onThresholdMinChange={(min) => setEccenThresh((p) => ({ ...p, min }))}
              inverted={eccenInverted}
              onInvertToggle={handleEccenInvert}
            />
          </>
        )}
        {/* White-matter (template) overlap — illustrative only. Uses the same
            polar/eccen thresholds and the same view mode as the cortical map
            above. Rendered ONLY when the optional maps are actually present:
            they are not bundled by default, so the old "maps are loading…"
            message could never resolve and just looked broken (SMALL-FIXES 53). */}
        {wmAvailable && (
          <>
        <div className="my-3 h-px bg-border" />
        <div className="space-y-3" data-testid="wm-retinotopy-legend">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            white matter (population template)
          </div>
          <>
            <>
              {bensonViewMode === "2d" ? (
                <VisualFieldMap2D
                  ref={wmVfMap2dRef}
                  gridResult={wm2DGrid}
                  active={selectedLesionIds.size > 0}
                  selectedCount={selectedLesionIds.size}
                  label="WM Retinotopy (population template)"
                  summaryText={wmPolarOverlap.summary}
                  /* Same min-voxels control as the cortical map. These were
                     never passed, so this map silently had no threshold UI
                     even though the code claimed it shared one (53). */
                  thresholdMode={polarThresh.mode}
                  thresholdMin={polarThresh.min}
                  onThresholdModeChange={(mode) => setPolarThresh((p) => ({ ...p, mode }))}
                  onThresholdMinChange={(min) => setPolarThresh((p) => ({ ...p, min }))}
                  baseLabel="WM Retinotopy (population template)"
                />
              ) : (
                <>
                  <PolarAngleDisc
                    active={selectedLesionIds.size > 0}
                    colormap="polar_angle_360"
                    arcSegments={wmPolarOverlap.arcSegments}
                    summaryText={wmPolarOverlap.summary}
                    baseLabel="WM Retinotopy (population template)"
                    eccenColormap="warm"
                    eccenArcSegments={wmEccenOverlap.arcSegments}
                    eccenSummaryText={wmEccenOverlap.summary}
                  />
                  <EccentricityBar
                    active={selectedLesionIds.size > 0}
                    colormap="warm"
                    arcSegments={wmEccenOverlap.arcSegments}
                    summaryText={wmEccenOverlap.summary}
                  />
                </>
              )}
              <div className="font-mono text-[8px] text-subtle leading-relaxed pt-1">
                Anatomical/illustrative · population template, not a validated clinical
                prediction · Amorosino et al. 2026 · brainlife.pub.67 (CC-BY)
              </div>
            </>
          </>
        </div>
          </>
        )}
      </div>
      </ModuleGate>
    </SidebarSection>
  );
}

export default RetinotopySection;
