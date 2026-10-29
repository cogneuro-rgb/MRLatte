import React from "react";

/**
 * Small-caps label used as a sub-section heading throughout all panels
 * (the `cap` class in index.css, in the subtle text tier).
 *
 * @param {React.ReactNode} children
 * @param {React.ElementType} [icon]   optional lucide icon component
 * @param {string}            [className] extra classes appended to the wrapper
 */
export function SectionLabel({ children, icon: Icon, className = "" }) {
  return (
    <div
      className={`flex items-center gap-2 cap text-subtle ${className}`}
    >
      {Icon && <Icon size={11} />}
      {children}
    </div>
  );
}

export default SectionLabel;
