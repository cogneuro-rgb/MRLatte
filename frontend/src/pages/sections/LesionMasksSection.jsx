import React from "react";
import { Plus } from "lucide-react";
import { SidebarSection } from "@/components/SidebarSection";
import FileUploader from "@/components/FileUploader";
import { UserLayerList } from "@/components/UserLayerList";
import { MaskQcCheck } from "@/components/MaskQcCheck";
import { Disclosure } from "@/components/ui/disclosure";
import { visualFieldMap2DDataURL } from "@/components/VisualFieldMap2D";
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
  ensureRetinotopyLoaded,
  retinoVolume,
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
  handleUserTransform,
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
  selectedLesionIds,
  layerNotes,
  onNotesChange,
  // Whether lqtpy's brain-mask checks apply (the base is the MNI template):
  // the same answer the drawing's quality check uses.
  qcMni,
}) {
  // The 2D visual-field map for ONE lesion, from the retinotopy maps
  // (off-screen, via retinoVolume) -- not a capture of the Retinotopy panel,
  // whose state (which lesions are selected, which layers are on) has nothing
  // to do with the report being made. Null when a map isn't loaded.
  const vfMapFor = async (lesionId, paId, ecId, thresh = {}) => {
    const lv = viewerRef.current?.getVolume?.(lesionId);
    const pa = retinoVolume(paId);
    const ec = retinoVolume(ecId);
    if (!(pa?.img && ec?.img && lv?.img)) return null;
    return await visualFieldMap2DDataURL({
      gridResult: computeVoxelCounts2D(lv, pa, ec), active: true, selectedCount: 1, ...thresh,
    });
  };
  const bensonThresh = { thresholdMode: polarThresh.mode, thresholdMin: polarThresh.min };

  return (
    <SidebarSection title="Lesion masks" icon={Plus} testId="section-lesion"
      open={lesionSectionOpen} onOpenChange={setLesionSectionOpen} keepMounted
      badge={lesionLayers.filter((l) => l.visible).length}>
      <FileUploader label="Load lesion masks" description=".nii .nii.gz .mgz · overlaid in red · several at once"
        testId="upload-lesion-button" multiple
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
        {...{ handleUserToggle, handleUserOpacity, handleUserColormap, handleUserColormapInvert, handleUserClipChange, handleUserTransform, handleUserRemove, handleCalRangeChange, handleColorRangeChange, handleAutoColorRange, handleAutoThreshold, handleIgnoreZeroChange, handleInvertThresholdChange, histograms, requestHistogram, thresholdVolumes, scheduleThresholdVolume }}
        renderLayerExtra={(lesion) => (
          <div className="space-y-2">
            {/* Sidebar declutter: the two one-click tools are rows; overlap
                and the report fold away under their names. */}
            <div className="cap text-subtle">Analyse this lesion</div>
            <MaskQcCheck lesion={lesion} userFileCache={userFileCache} mni={qcMni} viewerRef={viewerRef}
              onAddFixedCopy={(file) => addUserFile(file, "lesion")} />
            <OneClickSummaryPanel
              viewerRef={viewerRef}
              lesionLayers={[lesion]}
              standardAtlases={standardAtlases}
              ensureAtlasRegions={ensureAtlasRegions}
              ensureAtlasLoaded={ensureAtlasLoaded}
              userFileCache={userFileCache}
              getVfMap2dDataUrl={async (lesionId) => {
                // The summary's OWN lesion, with the Benson maps loaded first.
                await ensureRetinotopyLoaded("benson_polar_angle", { silent: true });
                await ensureRetinotopyLoaded("benson_eccentricity", { silent: true });
                return await vfMapFor(lesionId, "benson_polar_angle", "benson_eccentricity", bensonThresh);
              }}
            />
            <Disclosure title="Lesion ∩ atlas overlap" className="border-t border-border" testId={`overlap-fold-${lesion.id}`}>
              <OverlapPanel
                bare
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
            </Disclosure>
            <Disclosure title="One-click lesion report" className="border-t border-border" testId={`report-fold-${lesion.id}`}>
              <LesionReportPanel
                bare
                viewerRef={viewerRef}
                lesionLayers={[lesion]}
                standardAtlases={standardAtlases}
                visibleAtlasIds={standardAtlases.filter((a) => atlasState[a.id]?.visible).map((a) => a.id)}
                ensureAtlasRegions={ensureAtlasRegions}
                ensureAtlasLoaded={ensureAtlasLoaded}
                // lqtpy migration: same lesion-File resolution as OverlapPanel.
                userFileCache={userFileCache}
                retinoVolume={retinoVolume}
                retinotopyLayers={allRetinotopyLayers
                  .filter((l) => l.legendType === "polar" || l.legendType === "eccen")
                  .map((l) => ({
                    id: l.id,
                    name: l.name,
                    kind: l.legendType,
                    illustrative: l.id.startsWith("wm_") || l.id.startsWith("lgn_") || l.id.startsWith("or_"),
                    attribution: l.attribution || null,
                  }))}
                getVfMap2dDataUrl={(lesionId) => vfMapFor(lesionId, "benson_polar_angle", "benson_eccentricity", bensonThresh)}
                getWmVfMap2dDataUrl={(lesionId) => vfMapFor(lesionId, "wm_polar_angle", "wm_eccentricity")}
              />
            </Disclosure>
          </div>
        )}
      />
    </SidebarSection>
  );
}

export default LesionMasksSection;
