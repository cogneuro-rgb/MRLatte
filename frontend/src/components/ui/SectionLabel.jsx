import React from "react";

/**
 * Mono uppercase label used as a sub-section heading throughout all panels.
 * Replaces the repeated `font-mono text-[9px] uppercase tracking-[0.25em]
 * text-muted-foreground` className string (~50 occurrences).
 *
 * @param {React.ReactNode} children
 * @param {React.ElementType} [icon]   optional lucide icon component
 * @param {string}            [className] extra classes appended to the wrapper
 */
export function SectionLabel({ children, icon: Icon, className = "" }) {
  return (
    <div
      className={`flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground ${className}`}
    >
      {Icon && <Icon size={11} />}
      {children}
    </div>
  );
}

export default SectionLabel;
