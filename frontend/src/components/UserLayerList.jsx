import React from "react";
import LayerControlAdvanced from "@/components/LayerControlAdvanced";

/**
 * Renders a list of user-managed overlay layers (lesion masks, ROIs,
 * activation maps, or custom atlases) as LayerControlAdvanced rows.
 *
 * Extracted from Dashboard.jsx (was a private module-level const there) so
 * it can be shared by the Lesion Masks, Activation Maps, and Atlases
 * sidebar sections without duplication. Behaviour and markup are unchanged.
 */
export const UserLayerList = ({
  layers, overlayMeta,
  handleUserToggle, handleUserOpacity, handleUserColormap, handleUserColormapInvert, handleUserClipChange, handleUserRemove,
  handleCalRangeChange, handleColorRangeChange, handleAutoColorRange, handleAutoThreshold, handleIgnoreZeroChange, handleInvertThresholdChange,
  labelAtlasOptions, layerLabelAtlas, onLabelAtlasChange,
  histograms, requestHistogram,
  thresholdVolumes, scheduleThresholdVolume,
  onEdit, onDuplicate, onDownload,
  // Item 13: flat { id: text } note map + its setter, shared with every other
  // section (see Dashboard.jsx's layerNotes/handleNotesChange).
  layerNotes, onNotesChange,
  // Item 105: (layer) => ReactNode, rendered at the bottom of each expanded
  // entry (past the colormap/threshold controls). Lesion Masks uses it to nest
  // One-Click Summary / Atlas Overlap / Report inside the lesion they act on.
  renderLayerExtra,
  // Item 111/114: id of a layer that was JUST saved into this section (from
  // Draw Mask / Tract Dissection / Lesion Network Mapping) and should force-
  // open on this mount, even when other layers already exist. Mirrors
  // TractographySection's autoExpandId. LayerControlAdvanced's `expanded`
  // state is uncontrolled (seeded once from `defaultExpanded`), so this only
  // has an effect the moment that layer's row first mounts.
  autoExpandId,
}) =>
  layers.length === 0 ? null : (
    <div className="space-y-1.5 mt-2">
      {layers.map((l) => {
        const m = overlayMeta?.[l.id] || {};
        // Invert colormap (item 55): activation/continuous overlays only —
        // never base volume or categorical atlases (the viewer method is a
        // no-op there and inverting a discrete label LUT is meaningless).
        const isActivation = l.type === "activation";
        return (
          <div key={l.id}>
            <LayerControlAdvanced
              layer={l}
              visible={l.visible}
              opacity={l.opacity}
              colormap={l.colormap}
              globalMin={m.global_min}
              globalMax={m.global_max}
              calMin={m.cal_min}
              calMax={m.cal_max}
              colorMin={m.color_min}
              colorMax={m.color_max}
              hasZeroVoxels={m.hasZeroVoxels}
              ignoreZeroVoxels={m.ignoreZeroVoxels}
              invertThreshold={m.invertThreshold}
              colormapInverted={isActivation ? m.colormapInverted : undefined}
              onColormapInvertChange={isActivation ? handleUserColormapInvert : undefined}
              labelAtlasOptions={labelAtlasOptions}
              labelAtlasId={layerLabelAtlas?.[l.id]}
              onLabelAtlasChange={onLabelAtlasChange}
              // Item 114: auto-open only when this is the single layer in the
              // section, or it's the one just saved here (autoExpandId) — not
              // a blanket "all activation maps start open" (that forced every
              // unrelated activation layer open once 2+ existed). Any other
              // layer's expand/collapse state is whatever the user last left it
              // (LayerControlAdvanced's own uncontrolled `expanded` state,
              // preserved across section collapse via keepMounted).
              defaultExpanded={layers.length === 1 || l.id === autoExpandId}
              onToggle={handleUserToggle}
              onOpacityChange={handleUserOpacity}
              onColormapChange={handleUserColormap}
              onCalRangeChange={handleCalRangeChange}
              onColorRangeChange={handleColorRangeChange}
              onAutoColorRange={handleAutoColorRange}
              onAutoThreshold={handleAutoThreshold}
              onIgnoreZeroChange={handleIgnoreZeroChange}
              onInvertThresholdChange={handleInvertThresholdChange}
              // overlayMeta[l.id].clip only exists once the user has clicked
              // the clip toggle at least once (handleUserClipChange writes it
              // as a side effect in Dashboard.jsx) — before that it's always
              // undefined, regardless of the layer's own default. Before the
              // first click, fall back to l.clip (the type-based default set
              // at load time, e.g. addUserFile in Dashboard.jsx); after the
              // first click, m.clip (the live override) takes precedence.
              // Without this fallback, EVERY freshly-loaded layer showed
              // clipOn=true (undefined !== false) regardless of its actual
              // load-time default or the real GL-side __optOutClip state.
              clipOn={(m.clip ?? l.clip) !== false}
              onClipChange={handleUserClipChange ? (clip) => handleUserClipChange(l.id, clip) : undefined}
              onRemove={handleUserRemove}
              removable
              onEdit={onEdit}
              onDuplicate={onDuplicate}
              onDownload={onDownload}
              histogram={histograms?.[l.id]}
              onRequestHistogram={requestHistogram}
              thresholdVolume={thresholdVolumes?.[l.id]}
              onRequestThresholdVolume={scheduleThresholdVolume}
              notes={layerNotes?.[l.id]}
              onNotesChange={onNotesChange}
              extra={renderLayerExtra?.(l)}
            />
          </div>
        );
      })}
    </div>
  );

export default UserLayerList;
