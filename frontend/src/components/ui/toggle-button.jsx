import React from "react";

/**
 * Shared visual language for every binary on/off control in the layer/tract
 * cards (visibility, clip, invert-threshold, invert-colormap, mask-zero,
 * colorbar, tract lighting, ...).
 *
 * Item 119: previously these controls were split between two competing
 * looks — borderless icon buttons that only changed text color (visibility,
 * clip in LayerControlAdvanced) and an animated pill/switch (invert
 * threshold, invert colormap, mask-zero, base colorbar) — plus a THIRD,
 * bordered icon/text-button look used only for tract visibility/clip/
 * lighting. This component generalizes that third look (already proven in
 * three places) into the ONE shared on/off control used everywhere: a
 * bordered button whose fill/border communicate pressed state, optionally
 * with an icon and/or a short text label.
 *
 * Purely presentational — callers keep their own state and pass
 * pressed/onPressedChange, so no behaviour changes when a caller switches
 * from its old bespoke markup to this component.
 */
export function ToggleButton({
  pressed,
  onPressedChange,
  icon: Icon,
  label,
  iconSize = 11,
  title,
  testId,
  disabled = false,
  className = "",
}) {
  return (
    <button
      type="button"
      onClick={() => onPressedChange?.(!pressed)}
      disabled={disabled}
      title={title}
      aria-pressed={!!pressed}
      data-testid={testId}
      className={`flex items-center gap-1 px-1.5 py-1 text-[9px] uppercase tracking-[0.15em] transition-colors border flex-shrink-0 ${
        pressed
          ? "bg-panel-hover text-foreground border-muted-foreground"
          : "bg-transparent text-muted-foreground border-border hover:text-foreground"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""} ${className}`}
    >
      {Icon && <Icon size={iconSize} />}
      {label && <span>{label}</span>}
    </button>
  );
}

export default ToggleButton;
