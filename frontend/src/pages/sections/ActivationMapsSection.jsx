import React from "react";
import { FlaskConical } from "lucide-react";
import { SidebarSection } from "@/components/SidebarSection";
import FileUploader from "@/components/FileUploader";
import { UserLayerList } from "@/components/UserLayerList";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { serialUpload } from "@/lib/uploadUtils";

const ClusterPanel = lazyWithRetry(() => import("@/components/ClusterPanel"));

/**
 * Activation Maps sidebar section: multi-file upload of activation/statistic
 * maps, per-layer controls (via UserLayerList), and cluster analysis.
 *
 * Extracted from Dashboard.jsx; behaviour and markup are unchanged — this is
 * a relocation, not a redesign.
 */
export function ActivationMapsSection({
  open,
  onOpenChange,
  autoExpandId,
  onUploaded,
  activationLayers,
  addUserFile,
  overlayMeta,
  layerLabelAtlas,
  handleLayerLabelAtlasChange,
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
  viewerRef,
  standardAtlases = [],
  atlasRegions,
  ensureAtlasLoaded,
  layerNotes,
  onNotesChange,
}) {
  return (
    <SidebarSection title="Activation Maps" icon={FlaskConical} testId="section-activation"
      open={open} onOpenChange={onOpenChange} keepMounted
      badge={activationLayers.filter((l) => l.visible).length}>
      {/* Item 20: auto-open the just-uploaded map's controls even when it is
          the 2nd+ layer. UserLayerList only auto-expands `layers.length === 1`
          or `autoExpandId`; a direct upload set neither (only LNM's Save did),
          so a second activation map came in collapsed. Push the new id up as
          the autoExpandId — for a multi-file batch the last one wins. */}
      <FileUploader label="Load Activation Map(s)" description=".nii / .nii.gz — t-stat or z-score maps; multi-select supported"
        testId="upload-activation-button" multiple
        onFiles={serialUpload(async (f) => {
          const id = await addUserFile(f, "activation");
          if (id) onUploaded?.(id);
        })}
        onFile={async (f) => {
          const id = await addUserFile(f, "activation");
          if (id) onUploaded?.(id);
        }} />
      <UserLayerList
        layers={activationLayers}
        overlayMeta={overlayMeta}
        autoExpandId={autoExpandId}
        labelAtlasOptions={standardAtlases.map((a) => ({ id: a.id, name: a.name, short: a.short || a.id }))}
        layerLabelAtlas={layerLabelAtlas}
        onLabelAtlasChange={handleLayerLabelAtlasChange}
        layerNotes={layerNotes} onNotesChange={onNotesChange}
        {...{ handleUserToggle, handleUserOpacity, handleUserColormap, handleUserColormapInvert, handleUserClipChange, handleUserRemove, handleCalRangeChange, handleColorRangeChange, handleAutoColorRange, handleAutoThreshold, handleIgnoreZeroChange, handleInvertThresholdChange, histograms, requestHistogram, thresholdVolumes, scheduleThresholdVolume }}
      />
      {activationLayers.length > 0 && (
        <ClusterPanel
          viewerRef={viewerRef}
          activationLayers={activationLayers.filter((l) => l.visible)}
          atlasOptions={standardAtlases}
          onSelectAtlas={(id) => handleLayerLabelAtlasChange(activationLayers[0]?.id, id)}
          atlasRegions={atlasRegions}
          ensureAtlasLoaded={ensureAtlasLoaded}
        />
      )}
    </SidebarSection>
  );
}

export default ActivationMapsSection;
