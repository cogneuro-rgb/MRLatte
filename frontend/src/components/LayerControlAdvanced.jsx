import React, { useContext, useEffect, useRef, useState, useCallback } from "react";
import { Eye, EyeOff, Trash2, ChevronDown, ChevronRight, Pencil, Download, Scissors, Copy, FileText, Lock, LockOpen, StickyNote } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { EditableNumber } from "@/components/ui/editable-number";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { RangeSlider } from "@/components/ui/range-slider";
import { Switch } from "@/components/ui/switch";
import { ColormapPicker } from "@/components/ui/colormap-picker";
import { colormapGradient, colormapRampGradient, colormapSample } from "@/lib/colormaps";
import { NiftiHeaderContext } from "@/components/NiftiHeaderDialog";
import { OverlayTransformControls } from "@/components/OverlayTransformControls";

// "Lock the colour range to the visibility values", per layer. Provided by the
// Dashboard (it owns overlayMeta, where the flag lives): { isLocked(id),
// setLocked(id, on) }. Without a provider there is no lock toggle.
export const ColorLockContext = React.createContext(null);

const COLORMAPS = [
  "gray", "hsv", "polar_angle", "warm", "cool", "actc", "random", "red", "green",
  "blue", "winter", "plasma", "viridis", "inferno", "magma", "turbo", "jet",
  "visfAtlas",
];

/**
 * Editable threshold value — click to edit as a textbox.
 */
const ThresholdValue = ({ value, onCommit, testId, align = "left" }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef(null);

  // Seed the textbox ONLY when entering edit mode. Re-running on every
  // `value` change would clobber the user's typed digits whenever the
  // parent re-renders mid-edit (e.g. after a debounced overlayMeta refresh).
  useEffect(() => {
    if (!editing) return;
    setText(value != null ? String(Number(value).toFixed(3).replace(/\.?0+$/, "")) : "");
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    const n = parseFloat(text);
    if (!isNaN(n)) onCommit(n);
    setEditing(false);
  };

  const box = "h-[22px] w-[52px] rounded-[5px] bg-background border font-mono text-[11.5px] tabular-nums px-1.5";
  if (editing) {
    return (
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        className={`${box} border-crema text-foreground focus:outline-none ${align === "right" ? "text-right" : "text-left"}`}
        data-testid={`${testId}-input`}
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className={`${box} border-edge text-foreground text-center hover:border-muted-foreground transition-colors`}
      title="Click to type a value"
      data-testid={testId}
    >
      {value != null ? Number(value).toFixed(2) : "—"}
    </button>
  );
};

// Small square action button in the card's identity row.
const RowAction = ({ onClick, title, testId, danger = false, children, ...rest }) => (
  <button
    onClick={onClick}
    title={title}
    aria-label={title}
    className={`inline-grid h-6 w-6 place-items-center rounded-[5px] text-muted-foreground transition-colors hover:bg-panel-hover ${
      danger ? "hover:text-destructive" : "hover:text-foreground"
    }`}
    data-testid={testId}
    {...rest}
  >
    {children}
  </button>
);

// A labelled on/off row: "Mask zero voxels ........ [switch]".
const SwitchRow = ({ label, checked, onChange, testId }) => (
  <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
    <span className="flex-1">{label}</span>
    <Switch checked={checked} onCheckedChange={onChange} label={label} testId={testId} />
  </div>
);

/**
 * The Levels-style threshold slider: the voxel-value histogram (64 bins of
 * non-zero voxels, log-scaled heights so a small tail stays visible beside the
 * noise peak) above the colour strip, with the handles on the strip. Bars
 * inside the visible window take the colour map's own colour for their value;
 * bars that are hidden on the canvas grey out, and the strip dims the same
 * bands. The whole area is draggable (the nearest handle follows).
 */
const LevelsSlider = ({
  histogram, colormap, invert, globalMin, globalMax, lo, hi, colourLo, colourHi,
  invertThreshold, rampGrad, sliderValue, sliderMax, onSliderChange, label, testId,
}) => {
  const range = globalMax - globalMin;
  const loFrac = (lo - globalMin) / range;
  const hiFrac = (hi - globalMin) / range;
  const counts = histogram?.counts;
  const hasBars = !!counts && counts.some((c) => c > 0);
  const maxLog = hasBars ? Math.log1p(Math.max(...counts)) : 0;
  const n = counts?.length || 0;
  const W = n * 10;
  const colourSpan = colourHi - colourLo;
  // The dim veil over hidden bands: themed, so it reads on both surfaces.
  const veil = "bg-background/70";

  return (
    <div className="relative">
      <div className="relative h-10 overflow-hidden rounded-t-md border border-b-0 border-border bg-background">
        {hasBars && (
          <svg
            viewBox={`0 0 ${W} 100`}
            preserveAspectRatio="none"
            className="keep-colours absolute inset-x-1 bottom-0 top-1.5 h-[calc(100%-6px)] w-[calc(100%-8px)] text-subtle"
            aria-hidden="true"
          >
            {counts.map((c, i) => {
              const h = maxLog > 0 ? (Math.log1p(c) / maxLog) * 96 : 0;
              if (h <= 0) return null;
              const v = globalMin + ((i + 0.5) / n) * range;
              const inside = v >= lo && v <= hi;
              const shown = inside !== !!invertThreshold;
              let fill = "currentColor";
              if (shown) {
                const t = colourSpan > 0 ? Math.max(0, Math.min(1, (v - colourLo) / colourSpan)) : 1;
                fill = colormapSample(colormap, invert ? 1 - t : t);
              }
              return (
                <rect
                  key={i}
                  x={i * 10 + 1}
                  y={100 - h}
                  width="8"
                  height={h}
                  rx="1.5"
                  fill={fill}
                  fillOpacity={shown ? 1 : 0.22}
                />
              );
            })}
            <g className="text-foreground">
              {[loFrac, hiFrac].map((f, i) => (
                <line
                  key={i}
                  x1={f * W}
                  x2={f * W}
                  y1="0"
                  y2="100"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          </svg>
        )}
      </div>
      <div className="keep-colours relative h-2 rounded-b" style={{ background: rampGrad }}>
        {/* Dim whichever bands are HIDDEN on the canvas. Normally voxels
            outside [lo, hi] are hidden; with "show outside the window"
            (invertThreshold) it is the middle that is hidden. */}
        {invertThreshold ? (
          <div className={`absolute inset-y-0 ${veil}`}
            style={{ left: `${Math.max(0, loFrac) * 100}%`, width: `${Math.max(0, hiFrac - loFrac) * 100}%` }} />
        ) : (
          <>
            <div className={`absolute inset-y-0 left-0 rounded-bl ${veil}`} style={{ width: `${Math.max(0, loFrac) * 100}%` }} />
            <div className={`absolute inset-y-0 right-0 rounded-br ${veil}`} style={{ width: `${Math.max(0, 1 - hiFrac) * 100}%` }} />
          </>
        )}
      </div>
      <RangeSlider
        value={sliderValue}
        min={0}
        max={sliderMax}
        step={1}
        onValueChange={onSliderChange}
        minStepsBetweenThumbs={0}
        label={label}
        className="!absolute inset-0 items-end cursor-pointer"
        thumbClassName="translate-y-[5px]"
        data-testid={testId}
      />
    </div>
  );
};

export const LayerControlAdvanced = ({
  layer,
  visible,
  opacity,
  colormap,
  // Threshold props (optional — when omitted, this layer behaves as
  // categorical / binary and skips the dual-threshold UI):
  globalMin,
  globalMax,
  calMin,             // VISIBILITY window lower bound
  calMax,             // VISIBILITY window upper bound
  colorMin,           // COLOUR-scaling range min (mrview-style; optional)
  colorMax,           // COLOUR-scaling range max
  hasZeroVoxels,      // shows mask-zero toggle when true (the volume actually
                      // contains a zero-valued voxel — not a data-range check)
  ignoreZeroVoxels,
  invertThreshold,    // when true, voxels OUTSIDE [calMin, calMax] are visible
  clipOn,
  onClipChange,
  removable = false,
  showColormap = true,
  // Opens the advanced (threshold/colormap/atlas) section on first mount.
  // Used for freshly-uploaded activation maps so the controls a clinician
  // needs immediately (threshold, colormap) aren't hidden behind a click.
  defaultExpanded = false,
  // Per-layer label-atlas selector (used by activation maps so the crosshair
  // info shows the region name from whichever atlas the user picks).
  labelAtlasOptions,    // [{id, name}]
  labelAtlasId,         // current selection
  onLabelAtlasChange,   // (layerId, atlasId)
  // callbacks
  onToggle,
  onOpacityChange,
  onColormapChange,
  onCalRangeChange,
  onColorRangeChange,     // (layerId, min, max) — colour-scaling range
  onAutoColorRange,       // (layerId) — snap colour range to robust window
  onAutoThreshold,        // (layerId) — snap visibility threshold to robust window
  onIgnoreZeroChange,
  onInvertThresholdChange,
  // Colormap-direction invert (item 55). Only wired by the caller for
  // continuous/activation layers and the base volume — omitted (undefined) for
  // categorical atlases, so the toggle simply doesn't render there.
  colormapInverted,
  onColormapInvertChange,
  onRemove,
  onEdit,       // (layerId) — re-open this mask in the editable drawing (item 39)
  onDuplicate,  // (layerId) — clone this mask as a new "Copy of ..." layer
  onDownload,   // (layerId) — explicit download of this mask (item 39)
  // Bin counts for the threshold-slider histogram (see getOverlayHistogram
  // on the viewer). Computed lazily by the parent — undefined until requested.
  histogram,
  onRequestHistogram,
  // Live { voxelCount, volumeCM3 } of what's currently visible under the
  // threshold window (see getOverlayThresholdVolume on the viewer). The
  // parent debounces the underlying full-volume scan.
  thresholdVolume,
  onRequestThresholdVolume,
  // Item 105: arbitrary layer-scoped content rendered at the very bottom of the
  // expanded entry (see the render slot near the end of this component).
  extra,
  // Item 13: free-text note for this layer, and its setter — `notes` is
  // this layer's current value (looked up by the caller, e.g. a
  // `layerNotes[layer.id]` map), `onNotesChange` is (layerId, text) => void.
  // Omitted entirely (no textarea rendered) only if the caller doesn't wire
  // onNotesChange; every current call site does.
  notes,
  onNotesChange,
  // Manual move / rotate / scale (lib/overlayTransform.js). `transform` is this
  // layer's current adjustment (undefined = untouched); `onTransformChange` is
  // (layerId, transform) => void. The block only renders when the caller wires
  // the callback — lesion masks and activation maps do, atlases don't.
  transform,
  onTransformChange,
  // The visibility window's heading: "Threshold" / "Visibility" by default,
  // the base volume calls it "Window".
  thresholdLabel,
}) => {
  // Controls whether the advanced section (threshold, colormap, atlas) is shown.
  // Collapses by default to keep the sidebar compact when many layers are loaded.
  const [expanded, setExpanded] = useState(defaultExpanded);
  const cardMenu = useContextMenu();
  // Sidebar declutter: the notes field shows once there is a note, or after
  // the note button is pressed; an empty one folds away again on leaving it.
  const [noteOpen, setNoteOpen] = useState(false);
  const showHeader = useContext(NiftiHeaderContext);

  // Item 114 (retroactive case): `defaultExpanded` only seeds state at mount,
  // so a layer that becomes the sole survivor of a deletion (already mounted,
  // was previously false) never got the auto-open. Watch for the false→true
  // transition post-mount and open it then. Never force-closes on the reverse
  // transition, and never re-fires while it stays true, so a user's manual
  // collapse of an already-single layer is left alone.
  const prevDefaultExpandedRef = useRef(defaultExpanded);
  useEffect(() => {
    if (defaultExpanded && !prevDefaultExpandedRef.current) {
      setExpanded(true);
    }
    prevDefaultExpandedRef.current = defaultExpanded;
  }, [defaultExpanded]);

  const hasThresholds =
    typeof globalMin === "number" &&
    typeof globalMax === "number" &&
    globalMax > globalMin;

  // Lazily fetch the histogram (a full-volume scan) the first time the panel
  // is expanded, instead of on every render.
  useEffect(() => {
    if (expanded && hasThresholds && !histogram) onRequestHistogram?.(layer.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, hasThresholds, histogram]);

  // Normalise cal_min/max within [globalMin, globalMax]
  const lo = hasThresholds ? Math.max(globalMin, Math.min(globalMax, calMin ?? globalMin)) : 0;
  const hi = hasThresholds ? Math.max(globalMin, Math.min(globalMax, calMax ?? globalMax)) : 1;
  const sortedLo = Math.min(lo, hi);
  const sortedHi = Math.max(lo, hi);

  // Keep the visible-voxel readout live as the threshold window changes
  // (the parent's scheduleThresholdVolume debounces the actual scan).
  useEffect(() => {
    if (expanded && hasThresholds && onRequestThresholdVolume) {
      onRequestThresholdVolume(layer.id, sortedLo, sortedHi, !!invertThreshold);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, hasThresholds, sortedLo, sortedHi, invertThreshold]);

  const SLIDER_STEPS = 200;
  const range = hasThresholds ? globalMax - globalMin : 1;
  const toSlider = (v) => ((v - globalMin) / range) * SLIDER_STEPS;
  const fromSlider = (s) => globalMin + (s / SLIDER_STEPS) * range;

  const handleSliderChange = useCallback(
    (vals) => {
      const a = fromSlider(vals[0]);
      const b = fromSlider(vals[1]);
      onCalRangeChange?.(layer.id, Math.min(a, b), Math.max(a, b));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [globalMin, globalMax, onCalRangeChange, layer.id]
  );

  const handleLoText = (v) => onCalRangeChange?.(layer.id, Math.min(v, sortedHi), Math.max(v, sortedHi));
  const handleHiText = (v) => onCalRangeChange?.(layer.id, Math.min(sortedLo, v), Math.max(sortedLo, v));

  // Colour-scaling range (mrview-style): only shown when the parent wires
  // onColorRangeChange AND provides thresholds. Defaults to the full range so
  // the slider is meaningful even before the user touches it.
  const hasColorRange = hasThresholds && !!onColorRangeChange;
  const visibilityLabel = thresholdLabel || (hasColorRange ? "Visibility" : "Threshold");
  const cLo = hasColorRange
    ? Math.max(globalMin, Math.min(globalMax, colorMin ?? globalMin)) : globalMin;
  const cHi = hasColorRange
    ? Math.max(globalMin, Math.min(globalMax, colorMax ?? globalMax)) : globalMax;
  const cSortedLo = Math.min(cLo, cHi);
  const cSortedHi = Math.max(cLo, cHi);
  const handleColorSlider = useCallback(
    (vals) => {
      const a = fromSlider(vals[0]);
      const b = fromSlider(vals[1]);
      onColorRangeChange?.(layer.id, Math.min(a, b), Math.max(a, b));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [globalMin, globalMax, onColorRangeChange, layer.id]
  );
  const colorLock = useContext(ColorLockContext);
  const colorLocked = !!colorLock?.isLocked(layer.id);
  const handleColorLoText = (v) => onColorRangeChange?.(layer.id, Math.min(v, cSortedHi), Math.max(v, cSortedHi));
  const handleColorHiText = (v) => onColorRangeChange?.(layer.id, Math.min(cSortedLo, v), Math.max(cSortedLo, v));

  // Item 55 follow-up: the colorbar swatch and the dual-threshold ramp below
  // must reflect "Invert colormap" too, not just the rendered volume — both
  // previously always sampled the raw (never-inverted) LUT.
  const invert = !!colormapInverted;
  const activeGrad = colormapGradient(colormap, { frac0: 0, frac1: 1, direction: "to right", invert });
  // The true value→colour ramp given the current colour-scaling window. Drawn
  // under BOTH sliders so colours stay consistent; the visibility slider dims
  // its hidden regions on top of it. Without a separate colour range the
  // visibility window is the colour window.
  const rampLo = hasColorRange ? cSortedLo : sortedLo;
  const rampHi = hasColorRange ? cSortedHi : sortedHi;
  const rampGrad = hasThresholds
    ? colormapRampGradient(colormap, (rampLo - globalMin) / range, (rampHi - globalMin) / range, { direction: "to right", invert })
    : activeGrad;

  // Right-click on the card (inbox 28 Oct): the card's own buttons as a menu.
  // Not in a text field, which keeps the system's cut / copy / paste menu.
  const openCardMenu = (e) => {
    if (e.target.closest("input, textarea, [contenteditable]")) return;
    const items = [
      onToggle && { label: visible ? "Hide" : "Show", onSelect: () => onToggle(layer.id) },
      onClipChange && { label: "Clip to the clip plane", checked: !!clipOn, onSelect: () => onClipChange(!clipOn) },
      hasThresholds && onAutoThreshold && { label: `Auto ${visibilityLabel.toLowerCase()}`, onSelect: () => onAutoThreshold(layer.id) },
      hasColorRange && onAutoColorRange && { label: "Auto colour range", disabled: colorLocked, onSelect: () => onAutoColorRange(layer.id) },
      "-",
      showHeader && { label: "View NIfTI header", onSelect: () => showHeader(layer) },
      onEdit && { label: "Edit in Draw Mask", onSelect: () => onEdit(layer.id) },
      onDuplicate && { label: "Duplicate", onSelect: () => onDuplicate(layer.id) },
      onDownload && { label: "Download (.nii.gz)", onSelect: () => onDownload(layer.id) },
      { label: expanded ? "Collapse controls" : "Expand controls", onSelect: () => setExpanded((v) => !v) },
      "-",
      removable && { label: "Remove layer", danger: true, onSelect: () => onRemove?.(layer.id) },
    ].filter(Boolean).filter((it, i, all) => it !== "-" || (i > 0 && i < all.length - 1 && all[i - 1] !== "-"));
    cardMenu.open(e, items);
  };

  // Sidebar declutter: a hidden layer whose controls are folded is one line:
  // show, swatch, name. The name opens the full card (description, row
  // actions, notes, Clip, and a lesion's analysis tools).
  if (!visible && !expanded) {
    return (
      <div
        className="group relative flex items-center gap-1.5 rounded-lg border border-border bg-card py-1 pl-1 pr-2"
        data-testid={`layer-${layer.id}`}
        data-compact="true"
        onContextMenu={openCardMenu}
      >
        <ContextMenu menu={cardMenu.menu} onClose={cardMenu.close} label={`${layer.name} actions`} />
        <button
          type="button"
          onClick={() => onToggle?.(layer.id)}
          aria-pressed={false}
          title="Show layer"
          aria-label="Show layer"
          className="icon-btn h-6 w-6 flex-shrink-0"
          data-testid={`toggle-${layer.id}`}
        >
          <EyeOff size={14} />
        </button>
        <span
          className="keep-colours h-3 w-3 flex-shrink-0 rounded-[3px]"
          style={{ background: activeGrad }}
          title={`Colormap: ${colormap}`}
          data-testid={`colormap-swatch-${layer.id}`}
        />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          title={layer.fullPath || layer.name}
          className="flex min-h-[24px] min-w-0 flex-1 items-center gap-2 text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          data-testid={`expand-${layer.id}`}
        >
          <span className="min-w-0 flex-1 truncate">{layer.name}</span>
          {notes && <StickyNote size={12} className="flex-shrink-0 text-subtle" role="img" aria-label="Has a note" />}
          <ChevronRight size={14} className="flex-shrink-0" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`group relative rounded-lg border bg-card p-2.5 space-y-2 transition-colors ${
        expanded ? "border-edge" : "border-border"
      }`}
      data-testid={`layer-${layer.id}`}
      onContextMenu={openCardMenu}
    >
      <ContextMenu menu={cardMenu.menu} onClose={cardMenu.close} label={`${layer.name} actions`} />
      {/* Identity: swatch and full name, then the file's size/description
          with the row actions (header, edit, duplicate, download, remove,
          expand). */}
      <div>
        <div className="flex items-start gap-2">
          <span
            className="keep-colours mt-[3px] h-3 w-3 flex-shrink-0 rounded-[3px]"
            style={{ background: activeGrad }}
            title={`Colormap: ${colormap}`}
            data-testid={`colormap-swatch-${layer.id}`}
          />
          <div
            className={`min-w-0 flex-1 break-words text-[13px] font-medium leading-[18px] ${visible ? "text-foreground" : "text-muted-foreground"}`}
            title={layer.fullPath || layer.name}
          >
            {layer.name}
          </div>
        </div>
        <div className="mt-0.5 flex items-center gap-0.5 pl-5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle" title={layer.description}>
            {layer.description}
          </span>
          {onNotesChange && !notes && !noteOpen && (
            <RowAction onClick={() => setNoteOpen(true)} title="Add a note" testId={`add-note-${layer.id}`}>
              <StickyNote size={13} />
            </RowAction>
          )}
          {showHeader && (
            <RowAction onClick={() => showHeader(layer)} title="View NIfTI header" testId={`header-${layer.id}`}>
              <FileText size={13} />
            </RowAction>
          )}
          {onEdit && (
            <RowAction onClick={() => onEdit(layer.id)} title="Edit in Draw Mask (erase / continue drawing)" testId={`edit-${layer.id}`}>
              <Pencil size={13} />
            </RowAction>
          )}
          {onDuplicate && (
            <RowAction onClick={() => onDuplicate(layer.id)} title="Duplicate this mask as a new layer" testId={`duplicate-${layer.id}`}>
              <Copy size={13} />
            </RowAction>
          )}
          {onDownload && (
            <RowAction onClick={() => onDownload(layer.id)} title="Download this mask (.nii.gz)" testId={`download-${layer.id}`}>
              <Download size={13} />
            </RowAction>
          )}
          {removable && (
            <RowAction onClick={() => onRemove?.(layer.id)} title="Remove layer" testId={`remove-${layer.id}`} danger>
              <Trash2 size={13} />
            </RowAction>
          )}
          <RowAction
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse controls" : "Expand controls"}
            testId={`expand-${layer.id}`}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </RowAction>
        </div>
      </div>

      {onNotesChange && (notes || noteOpen) && (
        <textarea
          autoFocus={!notes}
          value={notes || ""}
          onChange={(e) => onNotesChange(layer.id, e.target.value)}
          onBlur={(e) => { if (!e.currentTarget.value) setNoteOpen(false); }}
          onInput={(e) => {
            // Item 15: auto-expand up to 10 lines, shrink when text is deleted.
            const el = e.currentTarget;
            el.style.height = "auto";
            const lineH = parseFloat(getComputedStyle(el).lineHeight) || 16;
            el.style.height = Math.min(el.scrollHeight, lineH * 10) + "px";
          }}
          placeholder="Add notes…"
          rows={1}
          title={layer.fullPath ? `File: ${layer.fullPath}` : undefined}
          className="field block w-full resize-none overflow-y-auto py-[5px] leading-4"
          data-testid={`notes-${layer.id}`}
        />
      )}

      {/* Primary controls: visibility, opacity, clip — same row, same order,
          on every card type (item 119). */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onToggle?.(layer.id)}
          aria-pressed={!!visible}
          title={visible ? "Hide layer" : "Show layer"}
          aria-label={visible ? "Hide layer" : "Show layer"}
          className="icon-btn h-6 w-6 flex-shrink-0"
          data-testid={`toggle-${layer.id}`}
        >
          {visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        {visible && onOpacityChange && (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex-shrink-0 text-[13px] text-muted-foreground">Opacity</span>
            <Slider
              value={[opacity * 100]}
              max={100}
              step={1}
              onValueChange={(v) => onOpacityChange(layer.id, v[0] / 100)}
              className="flex-1 cursor-pointer"
              aria-label="Opacity"
              data-testid={`opacity-${layer.id}`}
            />
            <EditableNumber value={opacity * 100} min={0} max={100} integer onCommit={(v) => onOpacityChange(layer.id, v / 100)} label="Opacity, %"
              className="w-9 text-right font-mono text-[11.5px] text-muted-foreground">{Math.round(opacity * 100)}%</EditableNumber>
          </div>
        )}
        {(!visible || !onOpacityChange) && <span className="flex-1" />}
        {onClipChange && (
          <button
            type="button"
            onClick={() => onClipChange(!clipOn)}
            aria-pressed={!!clipOn}
            title={clipOn ? "Unclip this layer from 3D clip plane" : "Clip this layer to 3D clip plane"}
            className="btn-mini flex-shrink-0"
            data-testid={`clip-${layer.id}`}
          >
            <Scissors size={12} />
            Clip
          </button>
        )}
      </div>

      {/* Expanded advanced controls */}
      {expanded && visible && (
        <div className="space-y-3 pt-1">

          {/* Colour-scaling range (mrview-style contrast). Sets which data
              values map to the colormap's endpoints — independent of the
              visibility window below. The track shows the resulting value→colour
              ramp (clamped flat outside the handles). */}
          {hasColorRange && (
            <div className="space-y-2" data-testid={`color-range-block-${layer.id}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="cap flex-1 whitespace-nowrap text-subtle">Colour range</span>
                {/* One unit, so a narrow panel moves it below the label whole. */}
                <div className="ml-auto flex items-center gap-1.5">
                {colorLocked ? (
                  <span className="px-1 font-mono text-[11.5px] text-muted-foreground" data-testid={`color-locked-values-${layer.id}`}>
                    {Number(cSortedLo).toFixed(2)} – {Number(cSortedHi).toFixed(2)}
                  </span>
                ) : (
                  <>
                    <ThresholdValue value={cSortedLo} onCommit={handleColorLoText} testId={`color-lo-${layer.id}`} align="left" />
                    <span className="text-[11px] text-subtle">–</span>
                    <ThresholdValue value={cSortedHi} onCommit={handleColorHiText} testId={`color-hi-${layer.id}`} align="right" />
                  </>
                )}
                {onAutoColorRange && (
                  <button
                    onClick={() => onAutoColorRange(layer.id)}
                    className="btn-mini"
                    title="Auto-contrast (robust 2–98% window)"
                    data-testid={`auto-color-${layer.id}`}
                    disabled={colorLocked}
                  >
                    Auto
                  </button>
                )}
                {colorLock && (
                  <button
                    onClick={() => colorLock.setLocked(layer.id, !colorLocked)}
                    aria-pressed={colorLocked}
                    aria-label={colorLocked ? "Locked to the visibility values" : "Lock the colour range to the visibility values"}
                    className="btn-mini w-[26px] px-0"
                    title={colorLocked
                      ? "Locked to the visibility values: the colour range follows them. Click to unlock."
                      : "Lock the colour range to the visibility values"}
                    data-testid={`color-lock-${layer.id}`}
                  >
                    {colorLocked ? <Lock size={12} /> : <LockOpen size={12} />}
                  </button>
                )}
                </div>
              </div>
              <div
                className={`keep-colours relative h-2.5 rounded shadow-[inset_0_0_0_1px_rgb(0_0_0/0.25)] ${colorLocked ? "opacity-55" : ""}`}
                style={{ background: rampGrad }}
              >
                <RangeSlider
                  value={[toSlider(cSortedLo), toSlider(cSortedHi)]}
                  min={0}
                  max={SLIDER_STEPS}
                  step={1}
                  onValueChange={handleColorSlider}
                  minStepsBetweenThumbs={0}
                  disabled={colorLocked}
                  label="Colour range"
                  className={`!absolute inset-x-0 -inset-y-[5px] ${colorLocked ? "" : "cursor-pointer"}`}
                  thumbClassName="h-4"
                  data-testid={`color-range-${layer.id}`}
                />
              </div>
            </div>
          )}

          {/* Visibility threshold: the Levels-style histogram slider. Voxels
              outside the window are hidden (or inside, when inverted). */}
          {hasThresholds && onCalRangeChange && (
            <div className="space-y-2" data-testid={`threshold-block-${layer.id}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="cap flex-1 whitespace-nowrap text-subtle">{visibilityLabel}</span>
                <div className="ml-auto flex items-center gap-1.5">
                {onAutoThreshold && (
                  <button
                    onClick={() => onAutoThreshold(layer.id)}
                    className="btn-mini"
                    title="Auto-threshold (robust 2–98% window)"
                    data-testid={`auto-threshold-${layer.id}`}
                  >
                    Auto
                  </button>
                )}
                <ThresholdValue value={sortedLo} onCommit={handleLoText} testId={`threshold-lo-${layer.id}`} align="left" />
                <span className="text-[11px] text-subtle">–</span>
                <ThresholdValue value={sortedHi} onCommit={handleHiText} testId={`threshold-hi-${layer.id}`} align="right" />
                </div>
              </div>
              <LevelsSlider
                histogram={histogram}
                colormap={colormap}
                invert={invert}
                globalMin={globalMin}
                globalMax={globalMax}
                lo={sortedLo}
                hi={sortedHi}
                colourLo={rampLo}
                colourHi={rampHi}
                invertThreshold={invertThreshold}
                rampGrad={rampGrad}
                sliderValue={[toSlider(sortedLo), toSlider(sortedHi)]}
                sliderMax={SLIDER_STEPS}
                onSliderChange={handleSliderChange}
                label={visibilityLabel}
                testId={`threshold-${layer.id}`}
              />
              {/* Data min | what's visible now | data max. In a narrow panel the
                  count wraps inside its own column, so min and max stay put. */}
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 font-mono text-[11px] text-subtle">
                <span>{Number(globalMin).toFixed(2)}</span>
                <span className="text-center text-muted-foreground" data-testid={thresholdVolume ? `threshold-volume-${layer.id}` : undefined}>
                  {thresholdVolume && `${thresholdVolume.voxelCount.toLocaleString()} vox · ${thresholdVolume.volumeCM3.toFixed(2)} mL visible`}
                </span>
                <span>{Number(globalMax).toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* On/off settings: threshold direction (inside ↔ outside), colormap
              direction (item 55; continuous/activation overlays only — the
              caller omits it for categorical atlases), and mask-zero (shown
              whenever the volume actually contains a zero-valued voxel). */}
          {((hasThresholds && onInvertThresholdChange) || onColormapInvertChange || (hasZeroVoxels && onIgnoreZeroChange)) && (
            <div className="space-y-2">
              {hasThresholds && onInvertThresholdChange && (
                <SwitchRow
                  label="Show outside the window"
                  checked={!!invertThreshold}
                  onChange={(v) => onInvertThresholdChange(layer.id, v)}
                  testId={`invert-threshold-${layer.id}`}
                />
              )}
              {onColormapInvertChange && (
                <SwitchRow
                  label="Invert colour map"
                  checked={!!colormapInverted}
                  onChange={(v) => onColormapInvertChange(layer.id, v)}
                  testId={`invert-colormap-${layer.id}`}
                />
              )}
              {hasZeroVoxels && onIgnoreZeroChange && (
                <SwitchRow
                  label="Mask zero voxels"
                  checked={!!ignoreZeroVoxels}
                  onChange={(v) => onIgnoreZeroChange(layer.id, v)}
                  testId={`mask-zero-${layer.id}`}
                />
              )}
            </div>
          )}

          {/* Colormap: a field that opens the grid of colour-map tiles. */}
          {showColormap && onColormapChange && (
            <div className="flex items-start gap-2">
              <span className="w-[84px] flex-shrink-0 pt-[5px] text-[13px] text-muted-foreground">Colour map</span>
              <ColormapPicker
                value={colormap}
                options={COLORMAPS}
                invert={invert}
                onChange={(c) => onColormapChange(layer.id, c)}
                testId={`colormap-${layer.id}`}
              />
            </div>
          )}

          {/* Label-atlas selector */}
          {labelAtlasOptions && labelAtlasOptions.length > 0 && onLabelAtlasChange && (
            <div className="flex items-center gap-2">
              <span className="w-[84px] flex-shrink-0 text-[13px] text-muted-foreground" title="Names the region under the crosshair">
                Label atlas
              </span>
              <select
                value={labelAtlasId || ""}
                onChange={(e) => onLabelAtlasChange(layer.id, e.target.value || null)}
                className="field min-w-0 flex-1 cursor-pointer"
                title={labelAtlasOptions.find((a) => a.id === labelAtlasId)?.name || "None"}
                data-testid={`label-atlas-${layer.id}`}
              >
                <option value="">— none —</option>
                {labelAtlasOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          {onTransformChange && (
            <OverlayTransformControls layerId={layer.id} transform={transform} onChange={onTransformChange} />
          )}
        </div>
      )}

      {/* Item 105: per-layer extension slot — rendered LAST, past every colour/
          threshold control, so a section can nest layer-scoped tools inside the
          layer itself (Lesion Masks puts One-Click Summary, Atlas Overlap and
          Report here). Gated on `expanded` only, NOT on `visible`: hiding a
          lesion from the canvas should not take its analysis tools away. */}
      {expanded && extra && (
        <div
          className="space-y-2 border-t border-border pt-2.5"
          data-testid={`layer-extra-${layer.id}`}
        >
          {extra}
        </div>
      )}
    </div>
  );
};

export default LayerControlAdvanced;
