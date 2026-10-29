/**
 * Shared className strings for the three recurring button/input styles.
 * Import these instead of copy-pasting the strings into every component.
 */

/** Secondary action button (most sidebar panel buttons). `.btn` in index.css. */
export const ghostBtnCls = "btn flex gap-1.5";

/** Panel <select> and text <input> elements. `.field` in index.css. */
export const panelSelectCls = "field w-full";

/** Full-width primary action button (Run / Generate / Save). */
export const primaryBtnCls = "btn-primary flex w-full gap-2 px-3 py-2";

/**
 * Returns className string for a binary active/inactive toggle button.
 * @param {boolean} active
 */
export const activeToggleCls = (active) =>
  active
    ? "bg-panel-active text-foreground border-edge"
    : "bg-transparent text-muted-foreground border-edge hover:text-foreground hover:bg-panel-hover";
