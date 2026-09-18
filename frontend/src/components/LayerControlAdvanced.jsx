import React, { useEffect, useRef, useState, useCallback } from "react";
import { Eye, EyeOff, Trash2, ChevronDown, ChevronRight, Pencil, Download, Scissors, Copy } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { RangeSlider } from "@/components/ui/range-slider";
import { ToggleButton } from "@/components/ui/toggle-button";
import { colormapGradient, colormapRampGradient } from "@/lib/colormaps";

const COLORMAPS = [
  "gray", "hsv", "polar_angle", "warm", "cool", "actc", "random", "red", "green",
  "blue", "winter", "plasma", "viridis", "inferno", "magma", "turbo", "jet",
  "visfAtlas",
];

/**
 * Editable threshold label — click to edit as a textbox.
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
        className={`w-16 bg-background border border-muted-foreground text-foreground font-mono text-[10px] px-1 py-0.5 focus:outline-none focus:border-foreground tabular-nums ${
          align === "right" ? "text-right" : "text-left"
        }`}
        data-testid={`${testId}-input`}
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className={`font-mono text-[10px] text-muted-foreground hover:text-foreground hover:underline tabular-nums px-1 ${
        align === "right" ? "text-right" : "text-left"
      }`}
      data-testid={testId}
    >
      {value != null ? Number(value).toFixed(2) : "—"}
    </button>
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
  // continuous/activation layers — omitted (undefined) for base volume and
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
}) => {
  // Controls whether the advanced section (threshold, colormap, atlas) is shown.
  // Collapses by default to keep the sidebar compact when many layers are loaded.
  const [expanded, setExpanded] = useState(defaultExpanded);

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
  const handleColorLoText = (v) => onColorRangeChange?.(layer.id, Math.min(v, cSortedHi), Math.max(v, cSortedHi));
  const handleColorHiText = (v) => onColorRangeChange?.(layer.id, Math.min(cSortedLo, v), Math.max(cSortedLo, v));

  // Item 55 follow-up: the colorbar swatch and the dual-threshold ramp below
  // must reflect "Invert colormap" too, not just the rendered volume — both
  // previously always sampled the raw (never-inverted) LUT.
  const invert = !!colormapInverted;
  const activeGrad = colormapGradient(colormap, { frac0: 0, frac1: 1, direction: "to right", invert });
  // The true value→colour ramp given the current colour-scaling window. Drawn
  // under BOTH sliders so colours stay consistent; the visibility slider dims
  // its hidden regions on top of it.
  const rampGrad = hasThresholds
    ? colormapRampGradient(colormap, (cSortedLo - globalMin) / range, (cSortedHi - globalMin) / range, { direction: "to right", invert })
    : activeGrad;
  // Fractional positions (0..1) of the visibility handles, for the dimming
  // overlay drawn on the visibility slider.
  const visLoFrac = hasThresholds ? (sortedLo - globalMin) / range : 0;
  const visHiFrac = hasThresholds ? (sortedHi - globalMin) / range : 1;

  return (
    <div
      className={`group border border-border bg-panel hover:bg-panel-hover transition-colors ${
        visible ? "border-l-2 border-l-foreground" : ""
      }`}
      data-testid={`layer-${layer.id}`}
    >
      {/* Identity row: swatch | name/description | actions (edit, download, remove, expand) */}
      <div className="flex items-start gap-2 px-3 py-2">
        <span
          className="mt-1 h-3 w-3 flex-shrink-0 border border-border"
          style={{ background: activeGrad }}
          title={`Colormap: ${colormap}`}
          data-testid={`colormap-swatch-${layer.id}`}
        />
        <div className="flex-1 min-w-0">
          <div
            className={`truncate text-[12px] font-medium ${visible ? "text-foreground" : "text-muted-foreground"}`}
            title={layer.fullPath || layer.name}
          >
            {layer.name}
          </div>
          {layer.description && (
            <div className="truncate font-mono text-[10px] text-muted-foreground mt-0.5">{layer.description}</div>
          )}
          {onNotesChange && (
            <textarea
              value={notes || ""}
              onChange={(e) => onNotesChange(layer.id, e.target.value)}
              onInput={(e) => {
                // Item 15: auto-expand up to 10 lines, shrink when text is deleted.
                const el = e.currentTarget;
                el.style.height = "auto";
                const lineH = parseFloat(getComputedStyle(el).lineHeight) || 14;
                el.style.height = Math.min(el.scrollHeight, lineH * 10) + "px";
              }}
              placeholder="Add notes…"
              rows={1}
              title={layer.fullPath ? `File: ${layer.fullPath}` : undefined}
              className="mt-1 w-full resize-none overflow-y-auto bg-background border border-border text-foreground font-mono text-[10px] px-1.5 py-1 leading-snug placeholder:text-subtle focus:outline-none focus:border-muted-foreground"
              data-testid={`notes-${layer.id}`}
            />
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {onEdit && (
            <button
              onClick={() => onEdit(layer.id)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`edit-${layer.id}`}
              title="Edit in Draw Mask (erase / continue drawing)"
            >
              <Pencil size={11} />
            </button>
          )}
          {onDuplicate && (
            <button
              onClick={() => onDuplicate(layer.id)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`duplicate-${layer.id}`}
              title="Duplicate this mask as a new layer"
            >
              <Copy size={11} />
            </button>
          )}
          {onDownload && (
            <button
              onClick={() => onDownload(layer.id)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`download-${layer.id}`}
              title="Download this mask (.nii.gz)"
            >
              <Download size={11} />
            </button>
          )}
          {removable && (
            <button
              onClick={() => onRemove?.(layer.id)}
              className="flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive transition-colors"
              data-testid={`remove-${layer.id}`}
              title="Remove layer"
            >
              <Trash2 size={10} />
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            data-testid={`expand-${layer.id}`}
            aria-label={expanded ? "Collapse controls" : "Expand controls"}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        </div>
      </div>

      {/* Primary controls: visibility, opacity, clip — same row, same order,
          on every card type (item 119). */}
      <div className="flex items-center gap-2 px-3 pb-2 pt-0">
        <ToggleButton
          pressed={visible}
          onPressedChange={() => onToggle?.(layer.id)}
          icon={visible ? Eye : EyeOff}
          testId={`toggle-${layer.id}`}
          title={visible ? "Hide layer" : "Show layer"}
        />
        {visible && onOpacityChange && (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-subtle w-12 flex-shrink-0">opacity</span>
            <Slider
              value={[opacity * 100]}
              max={100}
              step={1}
              onValueChange={(v) => onOpacityChange(layer.id, v[0] / 100)}
              className="cursor-pointer flex-1"
              data-testid={`opacity-${layer.id}`}
            />
            <span className="font-mono text-[10px] text-muted-foreground tabular-nums w-8 text-right">{Math.round(opacity * 100)}%</span>
          </div>
        )}
        {onClipChange && (
          <ToggleButton
            pressed={clipOn}
            onPressedChange={(v) => onClipChange(v)}
            icon={Scissors}
            label="Clip"
            testId={`clip-${layer.id}`}
            title={clipOn ? "Unclip this layer from 3D clip plane" : "Clip this layer to 3D clip plane"}
          />
        )}
      </div>

      {/* Expanded advanced controls */}
      {expanded && visible && (
        <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-border">

          {/* Colour-scaling range (mrview-style contrast). Sets which data
              values map to the colormap's endpoints — independent of the
              visibility window below. The track shows the resulting value→colour
              ramp (clamped flat outside the handles). */}
          {hasColorRange && (
            <div className="space-y-1.5" data-testid={`color-range-block-${layer.id}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">colour range</span>
                  {onAutoColorRange && (
                    <button
                      onClick={() => onAutoColorRange(layer.id)}
                      className="font-mono text-[8px] uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground border border-border px-1 py-0.5 transition-colors"
                      title="Auto-contrast (robust 2–98% window)"
                      data-testid={`auto-color-${layer.id}`}
                    >
                      auto
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <ThresholdValue
                    value={cSortedLo}
                    onCommit={handleColorLoText}
                    testId={`color-lo-${layer.id}`}
                    align="left"
                  />
                  <span className="font-mono text-[10px] text-subtle">–</span>
                  <ThresholdValue
                    value={cSortedHi}
                    onCommit={handleColorHiText}
                    testId={`color-hi-${layer.id}`}
                    align="right"
                  />
                </div>
              </div>
              <div className="relative h-4 rounded-none" style={{ background: rampGrad }}>
                <RangeSlider
                  value={[toSlider(cSortedLo), toSlider(cSortedHi)]}
                  min={0}
                  max={SLIDER_STEPS}
                  step={1}
                  onValueChange={handleColorSlider}
                  minStepsBetweenThumbs={0}
                  className="absolute inset-0 cursor-pointer"
                  data-testid={`color-range-${layer.id}`}
                />
              </div>
            </div>
          )}

          {/* Visibility threshold dual-handle slider. Voxels outside the
              window are hidden (or inside, when inverted). Drawn over the same
              colour ramp, with the hidden regions dimmed. */}
          {hasThresholds && onCalRangeChange && (
            <div className="space-y-1.5" data-testid={`threshold-block-${layer.id}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
                    {hasColorRange ? "visibility" : "threshold"}
                  </span>
                  {onAutoThreshold && (
                    <button
                      onClick={() => onAutoThreshold(layer.id)}
                      className="font-mono text-[8px] uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground border border-border px-1 py-0.5 transition-colors"
                      title="Auto-threshold (robust 2–98% window)"
                      data-testid={`auto-threshold-${layer.id}`}
                    >
                      auto
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <ThresholdValue
                    value={sortedLo}
                    onCommit={handleLoText}
                    testId={`threshold-lo-${layer.id}`}
                    align="left"
                  />
                  <span className="font-mono text-[10px] text-subtle">–</span>
                  <ThresholdValue
                    value={sortedHi}
                    onCommit={handleHiText}
                    testId={`threshold-hi-${layer.id}`}
                    align="right"
                  />
                </div>
              </div>
              <div
                className="relative h-10 rounded-none overflow-hidden"
                style={{ background: hasColorRange ? rampGrad : activeGrad }}
              >
                {/* Voxel-value histogram (log-scaled bar heights so a dominant
                    bin doesn't flatten the rest — matches mricrogl/FSLeyes'
                    threshold widgets, makes it visual instead of just numeric). */}
                {histogram && histogram.counts.some((c) => c > 0) && (
                  <div className="absolute inset-0 flex items-end pointer-events-none">
                    {histogram.counts.map((c, i) => {
                      const maxLog = Math.log1p(Math.max(...histogram.counts));
                      const h = maxLog > 0 ? (Math.log1p(c) / maxLog) * 100 : 0;
                      return (
                        <div
                          key={i}
                          style={{ height: `${h}%` }}
                          className="flex-1 bg-foreground/40"
                        />
                      );
                    })}
                  </div>
                )}
                {/* Dim whichever bands are actually HIDDEN on the canvas. Normally
                    voxels OUTSIDE [lo, hi] are hidden, so the outer bands darken and
                    the middle stays bright. When "show outside thresholds" is on
                    (invertThreshold), it's the opposite: voxels INSIDE the window are
                    hidden, so the middle darkens and the outer bands stay bright. */}
                {invertThreshold ? (
                  <div className="absolute inset-y-0 bg-black/65 pointer-events-none"
                    style={{
                      left: `${Math.max(0, visLoFrac) * 100}%`,
                      width: `${Math.max(0, visHiFrac - visLoFrac) * 100}%`,
                    }} />
                ) : (
                  <>
                    <div className="absolute inset-y-0 left-0 bg-black/65 pointer-events-none"
                      style={{ width: `${Math.max(0, visLoFrac) * 100}%` }} />
                    <div className="absolute inset-y-0 right-0 bg-black/65 pointer-events-none"
                      style={{ width: `${Math.max(0, 1 - visHiFrac) * 100}%` }} />
                  </>
                )}
                <RangeSlider
                  value={[toSlider(sortedLo), toSlider(sortedHi)]}
                  min={0}
                  max={SLIDER_STEPS}
                  step={1}
                  onValueChange={handleSliderChange}
                  minStepsBetweenThumbs={0}
                  className="absolute inset-0 cursor-pointer"
                  data-testid={`threshold-${layer.id}`}
                />
              </div>
              <div className="flex items-center justify-between text-[9px] text-subtle font-mono tabular-nums">
                <span>{Number(globalMin).toFixed(2)}</span>
                {thresholdVolume && (
                  <span data-testid={`threshold-volume-${layer.id}`}>
                    {thresholdVolume.voxelCount.toLocaleString()} vox · {thresholdVolume.volumeCM3.toFixed(2)} mL visible
                  </span>
                )}
                <span>{Number(globalMax).toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* Threshold direction toggle (inside ↔ outside) */}
          {hasThresholds && onInvertThresholdChange && (
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
                show {invertThreshold ? "outside" : "inside"} thresholds
              </span>
              <ToggleButton
                pressed={invertThreshold}
                onPressedChange={(v) => onInvertThresholdChange(layer.id, v)}
                label={invertThreshold ? "on" : "off"}
                testId={`invert-threshold-${layer.id}`}
              />
            </div>
          )}

          {/* Colormap-direction invert (item 55) — continuous/activation
              overlays only; the caller omits the props for base volume and
              categorical atlases, so this never renders for those. */}
          {onColormapInvertChange && (
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
                invert colormap
              </span>
              <ToggleButton
                pressed={colormapInverted}
                onPressedChange={(v) => onColormapInvertChange(layer.id, v)}
                label={colormapInverted ? "on" : "off"}
                testId={`invert-colormap-${layer.id}`}
              />
            </div>
          )}

          {/* Mask-zero toggle — shown whenever the volume actually contains a
              zero-valued voxel, regardless of whether its data range
              straddles zero (an all-non-negative map can still have real
              zeros worth masking). */}
          {hasZeroVoxels && onIgnoreZeroChange && (
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
                mask zero voxels
              </span>
              <ToggleButton
                pressed={ignoreZeroVoxels}
                onPressedChange={(v) => onIgnoreZeroChange(layer.id, v)}
                label={ignoreZeroVoxels ? "on" : "off"}
                testId={`mask-zero-${layer.id}`}
              />
            </div>
          )}

          {/* Colormap selector */}
          {showColormap && onColormapChange && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">colormap</span>
                <span className="font-mono text-[10px] text-foreground">{colormap}</span>
              </div>
              <select
                value={colormap}
                onChange={(e) => onColormapChange(layer.id, e.target.value)}
                className="w-full bg-background border border-border text-foreground font-mono text-[11px] px-2 py-1 focus:outline-none focus:border-muted-foreground cursor-pointer"
                data-testid={`colormap-${layer.id}`}
              >
                {COLORMAPS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          )}

          {/* Label-atlas selector */}
          {labelAtlasOptions && labelAtlasOptions.length > 0 && onLabelAtlasChange && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">label atlas</span>
                <span className="font-mono text-[10px] text-foreground">
                  {labelAtlasOptions.find((a) => a.id === labelAtlasId)?.short || "—"}
                </span>
              </div>
              <select
                value={labelAtlasId || ""}
                onChange={(e) => onLabelAtlasChange(layer.id, e.target.value || null)}
                className="w-full bg-background border border-border text-foreground font-mono text-[11px] px-2 py-1 focus:outline-none focus:border-muted-foreground cursor-pointer"
                data-testid={`label-atlas-${layer.id}`}
              >
                <option value="">— none —</option>
                {labelAtlasOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
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
          className="px-3 pb-3 pt-2 space-y-2 border-t border-border"
          data-testid={`layer-extra-${layer.id}`}
        >
          {extra}
        </div>
      )}
    </div>
  );
};

export default LayerControlAdvanced;
