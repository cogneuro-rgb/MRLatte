import React from "react";
import { Plus } from "lucide-react";
import { SidebarSection } from "@/components/SidebarSection";
import FileUploader from "@/components/FileUploader";
import { UserLayerList } from "@/components/UserLayerList";
import { polarAngleDiscToDataURL } from "@/components/PolarAngleDisc";
import { visualFieldMap2DToDataURL, visualFieldMap2DDataURL } from "@/components/VisualFieldMap2D";
import { serialUpload } from "@/lib/uploadUtils";
import { computeVoxelCounts2D } from "@/lib/retinotopyAnalysis";
import { lazyWithRetry } from "@/lib/lazyWithRetry";

// Code-split, same reasoning as Dashboard.jsx's other lazy panels: only
// rendered inside a collapsed SidebarSection, so lazyWithRetry defers the
// chunk until the user opens Lesion Masks, and retries once on network failure.
const OneClickSummaryPanel = lazyWithRetry(() => import("@/components/OneClickSummaryPanel"));
const OverlapPanel         = lazyWithRetry(() => import("@/components/OverlapPanel"));
const LesionReportPanel    = lazyWithRetry(() => import("@/components/LesionReportPanel"));

/**
 * Lesion Masks sidebar section: upload lesion masks, One-Click Summary,
 * per-layer controls (via UserLayerList), atlas overlap, and the full lesion
 * report — including the retinotopy data-URL generators both panels need for
 * their exported figures.
 *
 * Extracted from Dashboard.jsx; behaviour and markup are unchanged — this is
 * a relocation, not a redesign.
 */
export function LesionMasksSection({
  lesionSectionOpen,
  setLesionSectionOpen,
  lesionLayers,
  addUserFile,
  viewerRef,
  standardAtlases,
  ensureAtlasRegions,
  ensureAtlasLoaded,
  userFileCache,
  retState,
  polarOverlap,
  baseLabel,
  eccenOverlap,
  eccenInverted,
  ensureRetinotopyLoaded,
  polarThresh,
  overlayMeta,
  handleUserEdit,
  handleUserDuplicate,
  handleUserDownload,
  handleUserToggle,
  handleUserOpacity,
  handleUserColormap,
  handleUserColormapInvert,
  handleUserClipChange,
  handleUserRemove,
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
  atlasState,
  allRetinotopyLayers,
  bensonVfMap2dRef,
  wmVfMap2dRef,
  benson2DGrid,
  wm2DGrid,
  polarActive,
  eccenActive,
  selectedLesionIds,
  wmPolarOverlap,
  wmEccenOverlap,
  layerNotes,
  onNotesChange,
}) {
  const sharedPolarDiscDataUrl = () => polarAngleDiscToDataURL({
    colormap: retState.benson_polar_angle.colormap,
    arcSegments: polarOverlap.arcSegments,
    summaryText: polarOverlap.summary,
    baseLabel,
    eccenColormap: retState.benson_eccentricity.colormap,
    eccenArcSegments: eccenOverlap.arcSegments,
    eccenSummaryText: eccenOverlap.summary,
    eccenInverted,
  });

  return (
    <SidebarSection title="Lesion Mask" icon={Plus} testId="section-lesion"
      open={lesionSectionOpen} onOpenChange={setLesionSectionOpen} keepMounted
      badge={lesionLayers.filter((l) => l.visible).length}>
      <FileUploader label="Lesion Mask(s)" description=".nii / .nii.gz / .mgz — overlaid in red; multi-select supported"
        variant="danger" testId="upload-lesion-button" multiple
        onFiles={serialUpload((f) => addUserFile(f, "lesion"))}
        onFile={(f) => addUserFile(f, "lesion")} />
      {/* Item 105: One-Click Summary, Atlas Overlap and the lesion Report are no
          longer section-level panels with their own lesion dropdowns. Each one
          is now mounted INSIDE the lesion it acts on, via
          LayerControlAdvanced's `extra` slot (below every colour/threshold
          control), scoped by passing just that layer. The pickers vanish on
          their own: all three already default to lesionLayers[0] and hide the
          selector when there is only one. */}
      <UserLayerList layers={lesionLayers} overlayMeta={overlayMeta} onEdit={handleUserEdit} onDuplicate={handleUserDuplicate} onDownload={handleUserDownload}
        layerNotes={layerNotes} onNotesChange={onNotesChange}
        {...{ handleUserToggle, handleUserOpacity, handleUserColormap, handleUserColormapInvert, handleUserClipChange, handleUserRemove, handleCalRangeChange, handleColorRangeChange, handleAutoColorRange, handleAutoThreshold, handleIgnoreZeroChange, handleInvertThresholdChange, histograms, requestHistogram, thresholdVolumes, scheduleThresholdVolume }}
        renderLayerExtra={(lesion) => (
          <div className="space-y-3">
            <OneClickSummaryPanel
              viewerRef={viewerRef}
              lesionLayers={[lesion]}
              standardAtlases={standardAtlases}
              ensureAtlasRegions={ensureAtlasRegions}
              ensureAtlasLoaded={ensureAtlasLoaded}
              userFileCache={userFileCache}
              getPolarDiscDataUrl={sharedPolarDiscDataUrl}
              getVfMap2dDataUrl={async (lesionId) => {
                // Build the 2D VF map for the summary's OWN lesion --
                // independent of the Retinotopy panel's transient state
                // (selectedLesionIds / layer visibility). Ensure the Benson
                // atlases are loaded, sample the deficit grid for that lesion,
                // and force the deficit render gates on.
                const viewer = viewerRef.current;
                await ensureRetinotopyLoaded("benson_polar_angle", { silent: true });
                await ensureRetinotopyLoaded("benson_eccentricity", { silent: true });
                const pa = viewer?.getVolume?.("benson_polar_angle");
                const ec = viewer?.getVolume?.("benson_eccentricity");
                const lv = viewer?.getVolume?.(lesionId);
                const grid = (pa?.img && ec?.img && lv?.img)
                  ? computeVoxelCounts2D(lv, pa, ec)
                  : null;
                return await visualFieldMap2DDataURL({
                  gridResult: grid,
                  active: true,
                  selectedCount: 1,
                  thresholdMode: polarThresh.mode,
                  thresholdMin: polarThresh.min,
                });
              }}
            />
            <div className="pt-3 border-t border-border">
              <OverlapPanel
                viewerRef={viewerRef}
                lesionLayers={[lesion]}
                // All installed atlases, not just the ones currently toggled
                // visible — OverlapPanel loads whichever is picked on demand
                // via ensureAtlasLoaded. Filtering by `visible` here made the
                // dropdown look empty until the user first switched an atlas
                // on in the Atlases section.
                atlasOptions={standardAtlases}
                ensureAtlasRegions={ensureAtlasRegions}
                ensureAtlasLoaded={ensureAtlasLoaded}
                // lqtpy migration: resolves an uploaded lesion's cached File
                // for the backend upload, same cache OneClickSummaryPanel
                // already reads (falls back to the in-memory drawing).
                userFileCache={userFileCache}
              />
            </div>
            <div className="pt-3 border-t border-border">
              <LesionReportPanel
                viewerRef={viewerRef}
                lesionLayers={[lesion]}
                standardAtlases={standardAtlases}
                visibleAtlasIds={standardAtlases.filter((a) => atlasState[a.id]?.visible).map((a) => a.id)}
                ensureAtlasRegions={ensureAtlasRegions}
                ensureAtlasLoaded={ensureAtlasLoaded}
                // lqtpy migration: same lesion-File resolution as OverlapPanel.
                userFileCache={userFileCache}
                retinotopyLayers={allRetinotopyLayers
                  .filter((l) => l.legendType === "polar" || l.legendType === "eccen")
                  .map((l) => ({
                    id: l.id,
                    name: l.name,
                    kind: l.legendType,
                    illustrative: l.id.startsWith("wm_") || l.id.startsWith("lgn_") || l.id.startsWith("or_"),
                    attribution: l.attribution || null,
                  }))}
                getPolarDiscDataUrl={sharedPolarDiscDataUrl}
                getVfMap2dDataUrl={async () => {
                  const el = bensonVfMap2dRef.current?.getSvgEl?.();
                  if (el) return await visualFieldMap2DToDataURL(el);
                  return await visualFieldMap2DDataURL({
                    gridResult: benson2DGrid,
                    active: polarActive || eccenActive,
                    selectedCount: selectedLesionIds.size,
                    thresholdMode: polarThresh.mode,
                    thresholdMin: polarThresh.min,
                  });
                }}
                getWmPolarDiscDataUrl={() => polarAngleDiscToDataURL({
                  colormap: "polar_angle_360",
                  arcSegments: wmPolarOverlap.arcSegments,
                  summaryText: wmPolarOverlap.summary,
                  baseLabel: "WM Retinotopy (population template)",
                  eccenColormap: "warm",
                  eccenArcSegments: wmEccenOverlap.arcSegments,
                  eccenSummaryText: wmEccenOverlap.summary,
                })}
                getWmVfMap2dDataUrl={async () => {
                  const el = wmVfMap2dRef.current?.getSvgEl?.();
                  if (el) return await visualFieldMap2DToDataURL(el);
                  return await visualFieldMap2DDataURL({
                    gridResult: wm2DGrid,
                    active: selectedLesionIds.size > 0,
                    selectedCount: selectedLesionIds.size,
                  });
                }}
              />
            </div>
          </div>
        )}
      />
    </SidebarSection>
  );
}

export default LesionMasksSection;
