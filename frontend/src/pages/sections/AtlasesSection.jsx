import React, { useEffect } from "react";
import { Database, GripVertical, Settings2 } from "lucide-react";
import { SidebarSection } from "@/components/SidebarSection";
import LayerControlAdvanced from "@/components/LayerControlAdvanced";
import AtlasLabelList from "@/components/AtlasLabelList";
import AtlasRegionSearch from "@/components/AtlasRegionSearch";
import FileUploader from "@/components/FileUploader";
import { UserLayerList } from "@/components/UserLayerList";
import { serialUpload } from "@/lib/uploadUtils";
import { useDragReorder } from "@/hooks/useDragReorder";

/**
 * Atlases sidebar section — the *use* surface for atlases. Installing,
 * importing, renaming and removing them lives in the Atlas Manager
 * (openAtlasManager), so this stays a list you can arrange and read.
 *
 * The list is the registry's, in the user's saved order. It used to be a
 * `.map()` over the hardcoded STANDARD_ATLASES array, which meant it could not
 * show an atlas installed after startup and listed only 6 of the 11 on disk.
 */
export function AtlasesSection({
  stdAtlasActive,
  customAtlases,
  standardAtlases,
  atlasState,
  atlasRegions,
  ensureAtlasRegions,
  reorderAtlases,
  openAtlasManager,
  atlasIsolate,
  handleAtlasToggle,
  handleAtlasOpacity,
  handleAtlasColormap,
  handleAtlasClipChange,
  onAtlasNavigate,
  onAtlasRegionMask,
  onAtlasRegionColors,
  onAtlasIsolate,
  addUserFile,
  overlayMeta,
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
  layerNotes,
  onNotesChange,
}) {
  const ids = (standardAtlases || []).map((a) => a.id);
  const dnd = useDragReorder(ids, reorderAtlases);

  // Region search spans every installed atlas, so it needs their label tables
  // whether or not the atlas has been toggled on. Labels are small JSON and
  // fetched once each; the volumes are not touched.
  useEffect(() => {
    for (const a of standardAtlases || []) ensureAtlasRegions?.(a);
  }, [standardAtlases, ensureAtlasRegions]);

  return (
    <SidebarSection title="Atlases" icon={Database} testId="section-atlases" defaultOpen={false}
      badge={stdAtlasActive + customAtlases.filter((l) => l.visible).length}>

      <div className="mb-2 flex items-center gap-1">
        <AtlasRegionSearch
          atlases={standardAtlases}
          atlasRegions={atlasRegions}
          onNavigate={onAtlasNavigate}
        />
        <button
          onClick={() => openAtlasManager?.()}
          title="Install, import, rename or remove atlases"
          className="flex shrink-0 items-center gap-1 border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          data-testid="open-atlas-manager"
        >
          <Settings2 size={12} /> Manage
        </button>
      </div>

      {!standardAtlases?.length && (
        <div className="mb-2 border border-border px-2 py-3 text-[11px] text-muted-foreground">
          No atlases installed.{" "}
          <button
            onClick={() => openAtlasManager?.("catalog")}
            className="underline transition-colors hover:text-foreground"
            data-testid="atlas-empty-install"
          >
            Install one
          </button>{" "}
          from the catalog, or import your own.
        </div>
      )}

      <div className="space-y-1.5">
        {(standardAtlases || []).map((a) => {
          // Guarded: the list is dynamic, so an atlas can render one frame
          // before Dashboard's effect has seeded its view state.
          const s = atlasState[a.id] || { visible: false, opacity: a.opacity, colormap: a.colormap };
          return (
            <div
              key={a.id}
              {...dnd.itemProps(a.id)}
              tabIndex={0}
              className={`group relative ${dnd.draggingId === a.id ? "opacity-50" : ""} ${
                dnd.overId === a.id && dnd.draggingId !== a.id ? "border-t-2 border-t-accent" : ""
              }`}
              data-testid={`atlas-row-${a.id}`}
            >
              <span
                className="pointer-events-none absolute -left-3 top-2 opacity-0 transition-opacity group-hover:opacity-60 group-focus:opacity-60"
                title="Drag to reorder (or Alt+↑/↓)"
              >
                <GripVertical size={12} />
              </span>
              <LayerControlAdvanced
                layer={a}
                visible={s.visible}
                opacity={s.opacity}
                colormap={s.colormap}
                clipOn={overlayMeta[a.id]?.clip}
                onToggle={handleAtlasToggle}
                onOpacityChange={handleAtlasOpacity}
                onColormapChange={handleAtlasColormap}
                onClipChange={handleAtlasClipChange}
                notes={layerNotes?.[a.id]}
                onNotesChange={onNotesChange}
              />
              {s.visible && (
                <AtlasLabelList
                  atlasId={a.id}
                  regions={atlasRegions?.[a.id]}
                  isolated={atlasIsolate?.[a.id]}
                  onNavigate={onAtlasNavigate}
                  onIsolate={onAtlasIsolate}
                  onColors={onAtlasRegionColors}
                  onRegionMask={onAtlasRegionMask}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="pt-2">
        <FileUploader label="Quick-load Atlas(es)" description=".nii / .nii.gz / .mgz — view only; use Manage → Import to install one with labels"
          testId="upload-atlas-button" multiple
          onFiles={serialUpload((f) => addUserFile(f, "atlas"))}
          onFile={(f) => addUserFile(f, "atlas")} />
      </div>
      <UserLayerList layers={customAtlases} overlayMeta={overlayMeta} layerNotes={layerNotes} onNotesChange={onNotesChange} {...{ handleUserToggle, handleUserOpacity, handleUserColormap, handleUserColormapInvert, handleUserClipChange, handleUserRemove, handleCalRangeChange, handleColorRangeChange, handleAutoColorRange, handleAutoThreshold, handleIgnoreZeroChange, handleInvertThresholdChange, histograms, requestHistogram, thresholdVolumes, scheduleThresholdVolume }} />
    </SidebarSection>
  );
}

export default AtlasesSection;
