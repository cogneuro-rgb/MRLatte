import React from "react";
import { Download, Package } from "lucide-react";
import { useCapability, useModulesFor, useModuleStore } from "@/hooks/use-modules";
import { moduleSize, isRedistributable } from "@/lib/modules";

/**
 * Install prompt shown in place of a feature whose backing module is absent.
 *
 * Replaces the old dead-end "… unavailable" notices (the pattern at
 * DaLnMapperPanel.jsx:425 / TractDissectionPanel.jsx:428) with something
 * actionable: the module's name, its download size, and a button into the
 * Module Store (components/ModuleStore.jsx), scrolled to that module — which is
 * where install / sideload / repair actually happen.
 */
export function ModuleInstallPrompt({ capability, label }) {
  const candidates = useModulesFor(capability);
  const { openStore } = useModuleStore();
  const missing = candidates.filter((m) => !m.installed);
  const shown = missing.length ? missing : candidates;

  return (
    <div
      className="border border-border px-2.5 py-2.5 space-y-2.5"
      data-testid={`module-gate-${capability}`}
    >
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
        <Package size={11} /> module required
      </div>

      {label && (
        <div className="font-mono text-[10px] text-muted-foreground leading-relaxed">
          {label} needs an optional module that is not installed.
        </div>
      )}

      {shown.length === 0 && (
        <div className="font-mono text-[10px] text-muted-foreground leading-relaxed">
          No module in the manifest provides this feature.
        </div>
      )}

      {shown.map((m) => (
        <div key={m.id} className="space-y-1.5">
          <div className="font-mono text-[10px] text-foreground leading-snug">{m.name}</div>
          {m.description && (
            <div className="font-mono text-[9px] text-subtle leading-relaxed">{m.description}</div>
          )}
          <button
            type="button"
            onClick={() => openStore(m.id)}
            title={isRedistributable(m)
              ? "Open the module store to install this module."
              : "Not redistributable — the store explains how to obtain and sideload it."}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] border border-border bg-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors"
            data-testid={`module-install-${m.id}`}
          >
            <Download size={11} />
            {isRedistributable(m) ? `Install (${moduleSize(m)})` : `Sideload (${moduleSize(m)})`}
          </button>
        </div>
      ))}

      <div className="font-mono text-[9px] text-subtle leading-relaxed">
        Opens the module store, where a module can be downloaded (when its
        licence allows) or sideloaded from a file you already have.
      </div>
    </div>
  );
}

/**
 * Renders `children` when `capability` is available, the install prompt when
 * the manifest says it is not, and `children` while the answer is unknown
 * (still loading, or backend unreachable — see useCapability).
 */
export function ModuleGate({ capability, label, children }) {
  const has = useCapability(capability);
  if (has === false) return <ModuleInstallPrompt capability={capability} label={label} />;
  return <>{children}</>;
}

export default ModuleGate;
