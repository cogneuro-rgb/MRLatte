import React from "react";

/**
 * On/off switch for the settings rows of a layer card (show outside the
 * window, invert colour map, mask zero voxels, colour bar). Purely
 * presentational: the caller owns the state. `label` is its accessible name,
 * normally the row's own text.
 */
export function Switch({ checked, onCheckedChange, label, title, testId, disabled = false, className = "" }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onCheckedChange?.(!checked)}
      className={`switch ${className}`}
    />
  );
}

export default Switch;
