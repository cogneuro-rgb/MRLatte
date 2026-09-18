/**
 * Shared className strings for the three recurring button/input styles.
 * Import these instead of copy-pasting the strings into every component.
 */

/** Borderless action button (most sidebar panel buttons). */
export const ghostBtnCls =
  "flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors border bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground";

/** Panel <select> and text <input> elements. */
export const panelSelectCls =
  "w-full bg-panel border border-border text-[11px] text-foreground px-2 py-1.5";

/** Full-width primary action button (Run / Generate / Save). */
export const primaryBtnCls =
  "w-full flex items-center justify-center gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-primary text-primary-foreground border-primary hover:bg-primary/90 disabled:opacity-50";

/**
 * Returns className string for a binary active/inactive toggle button.
 * @param {boolean} active
 */
export const activeToggleCls = (active) =>
  active
    ? "bg-primary text-primary-foreground border-primary"
    : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground";
