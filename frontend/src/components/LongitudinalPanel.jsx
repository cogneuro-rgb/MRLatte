import React, { useEffect, useState } from "react";
import { GitCompareArrows, FileUp, AlertCircle, RefreshCw, Package } from "lucide-react";
import { longitudinalStatus, registerLongitudinal, LONGITUDINAL_MODULE_ID } from "@/lib/longitudinal";
import { useModules } from "@/hooks/use-modules";
import { toast } from "sonner";

/**
 * LongitudinalPanel — pick a baseline + follow-up scan, register them on the
 * backend (SimpleITK), and hand the difference map back to the parent via
 * onDiffLoaded. The parent is responsible for adding the overlay to state so
 * it appears in the layer list and is cleared correctly on "Clear All".
 */
export const LongitudinalPanel = ({ onDiffLoaded }) => {
  const [baseline, setBaseline] = useState(null);
  const [followup, setFollowup] = useState(null);
  const [busy, setBusy] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const [backendAvailable, setBackendAvailable] = useState(null); // null = checking
  const [moduleMissing, setModuleMissing] = useState(false);       // backend up, SimpleITK not installed
  const { openStore } = useModules();

  const checkBackend = async () => {
    setBackendAvailable(null);
    const status = await longitudinalStatus();
    setModuleMissing(status === "module-missing");
    setBackendAvailable(status === "ok");
  };

  useEffect(() => { checkBackend(); }, []);

  const run = async () => {
    if (!baseline || !followup) return toast.error("Pick both scans");
    setBusy(true);
    const t = toast.loading("Registering & differencing… (may take a minute)");
    try {
      const { file, metrics: m } = await registerLongitudinal(baseline, followup);
      setMetrics(m);
      onDiffLoaded?.(file, { colormap: "warm", opacity: 0.7 });
      toast.success("Difference map loaded", { id: t });
    } catch (e) {
      toast.error("Comparison failed", { id: t, description: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const pick =
    "flex items-center gap-2 cursor-pointer border border-dashed border-border bg-panel px-3 py-2 text-[12px] text-foreground hover:border-muted-foreground transition-colors";

  return (
    <div className="space-y-3" data-testid="longitudinal-panel">
      <div className="flex items-center gap-2 cap text-subtle">
        <GitCompareArrows size={11} /> baseline vs follow-up
      </div>

      {/* Backend status */}
      {backendAvailable === null && (
        <div className="font-mono text-[11px] text-muted-foreground animate-pulse">Checking backend…</div>
      )}
      {backendAvailable === false && moduleMissing && (
        <div className="border border-border p-3 space-y-2 rounded-lg" data-testid="long-module-missing">
          <div className="font-mono text-[11px] text-foreground">Longitudinal comparison needs the SimpleITK module.</div>
          <div className="text-[11.5px] text-muted-foreground leading-relaxed">
            Install it from the module store: a one-time download of about 19 MB from PyPI, checked against a pinned hash.
          </div>
          <div className="flex gap-3">
            {/* Opens the store at this module; installing happens there, like
                every other module. */}
            <button
              onClick={() => openStore(LONGITUDINAL_MODULE_ID)}
              className="flex items-center gap-1.5 text-[11px] font-mono text-foreground hover:text-warn transition-colors"
              data-testid="long-install-module"
            >
              <Package size={11} />Open module store
            </button>
            <button
              onClick={checkBackend}
              className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors"
              data-testid="long-recheck"
            >
              <RefreshCw size={11} />Check again
            </button>
          </div>
        </div>
      )}
      {backendAvailable === false && !moduleMissing && (
        <div className="border border-warn/60 bg-warn/30 p-3 space-y-2 rounded-lg" data-testid="long-backend-unavailable">
          <div className="flex items-center gap-2 text-warn">
            <AlertCircle size={13} />
            <span className="font-mono text-[11px] font-medium">Backend not running</span>
          </div>
          <div className="text-[11.5px] text-muted-foreground leading-relaxed">
            Start the server to use longitudinal comparison:<br />
            <code className="text-foreground">cd backend &amp;&amp; uvicorn server:app --reload --port 8001</code>
          </div>
          <button
            onClick={checkBackend}
            className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors"
            data-testid="long-retry"
          >
            <RefreshCw size={11} />Retry
          </button>
        </div>
      )}

      {backendAvailable && (
        <>
          <label className={pick} data-testid="long-baseline-label">
            <FileUp size={13} />
            <span className="truncate flex-1">{baseline ? baseline.name : "Select baseline scan"}</span>
            <input type="file" accept=".nii,.nii.gz,.mgz" className="hidden"
              data-testid="long-baseline"
              onChange={(e) => setBaseline(e.target.files?.[0] || null)} />
          </label>

          <label className={pick} data-testid="long-followup-label">
            <FileUp size={13} />
            <span className="truncate flex-1">{followup ? followup.name : "Select follow-up scan"}</span>
            <input type="file" accept=".nii,.nii.gz,.mgz" className="hidden"
              data-testid="long-followup"
              onChange={(e) => setFollowup(e.target.files?.[0] || null)} />
          </label>

          <button
            onClick={run}
            disabled={busy || !baseline || !followup}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[12.5px] font-medium btn-primary disabled:opacity-50"
            data-testid="long-run"
          >
            <GitCompareArrows size={12} />{busy ? "Comparing…" : "Compare"}
          </button>

          {metrics && (
            <div className="border border-border bg-panel p-3 font-mono text-[11px] text-muted-foreground space-y-1 rounded-lg" data-testid="long-metrics">
              <div>changed voxels: <span className="text-foreground">{metrics.changedVoxelPct}%</span></div>
              <div>same grid: <span className="text-foreground">{metrics.sameGrid}</span></div>
              <div>reg. metric: <span className="text-foreground">{metrics.registrationMetric}</span></div>
              <div className="text-subtle">positive = follow-up &gt; baseline (warm overlay)</div>
            </div>
          )}
          <div className="text-[11.5px] text-subtle leading-relaxed">
            follow-up is affine-registered to baseline (SimpleITK). diff map loads into Activation Maps.
          </div>
        </>
      )}
    </div>
  );
};

export default LongitudinalPanel;
