import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Sidebar collapsible section.
 */
export const SidebarSection = ({
  title,
  icon: Icon,
  testId,
  defaultOpen = true,
  badge,
  children,
}) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="border-b border-[#27272A]" data-testid={testId}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-[#111111] transition-colors"
        data-testid={`${testId}-toggle`}
      >
        <div className="flex items-center gap-2.5">
          {Icon && <Icon size={13} className="text-zinc-400" />}
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-300">
            {title}
          </span>
          {badge !== undefined && badge !== null && badge !== 0 && (
            <span className="ml-1 font-mono text-[9px] text-emerald-500 tabular-nums">
              {badge}
            </span>
          )}
        </div>
        {open ? (
          <ChevronDown size={12} className="text-zinc-500" />
        ) : (
          <ChevronRight size={12} className="text-zinc-500" />
        )}
      </button>
      {open && <div className="px-5 pb-4 space-y-3">{children}</div>}
    </div>
  );
};

export default SidebarSection;
