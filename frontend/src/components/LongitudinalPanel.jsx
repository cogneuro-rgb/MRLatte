import React, { useEffect, useState } from "react";
import { GitCompareArrows, FileUp, AlertCircle, RefreshCw } from "lucide-react";
import { longitudinalAvailable, registerLongitudinal } from "@/lib/longitudinal";
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

  const checkBackend = async () => {
    setBackendAvailable(null);
    const ok = await longitudinalAvailable();
    setBackendAvailable(ok);
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
    "flex items-center gap-2 cursor-pointer border border-dashed border-[#27272A] bg-[#0a0a0a] px-3 py-2 text-[11px] text-zinc-300 hover:border-zinc-500 transition-colors";

  return (
    <div className="space-y-3" data-testid="longitudinal-panel">
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
        <GitCompareArrows size={11} /> baseline vs follow-up
      </div>

      {/* Backend status */}
      {backendAvailable === null && (
        <div className="font-mono text-[10px] text-zinc-500 animate-pulse">Checking backend…</div>
      )}
      {backendAvailable === false && (
        <div className="border border-amber-700/60 bg-amber-950/30 p-3 space-y-2" data-testid="long-backend-unavailable">
          <div className="flex items-center gap-2 text-amber-400">
            <AlertCircle size={13} />
            <span className="font-mono text-[10px] font-medium">Backend not running</span>
          </div>
          <div className="font-mono text-[9px] text-zinc-400 leading-relaxed">
            Start the server to use longitudinal comparison:<br />
            <code className="text-zinc-300">cd backend &amp;&amp; uvicorn server:app --reload --port 8001</code>
          </div>
          <button
            onClick={checkBackend}
            className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-400 hover:text-white transition-colors"
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
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-white text-black border-white hover:bg-zinc-200 disabled:opacity-50"
            data-testid="long-run"
          >
            <GitCompareArrows size={12} />{busy ? "Comparing…" : "Compare"}
          </button>

          {metrics && (
            <div className="border border-[#27272A] bg-[#0a0a0a] p-3 font-mono text-[10px] text-zinc-400 space-y-1" data-testid="long-metrics">
              <div>changed voxels: <span className="text-white">{metrics.changedVoxelPct}%</span></div>
              <div>same grid: <span className="text-zinc-200">{metrics.sameGrid}</span></div>
              <div>reg. metric: <span className="text-zinc-200">{metrics.registrationMetric}</span></div>
              <div className="text-zinc-600">positive = follow-up &gt; baseline (warm overlay)</div>
            </div>
          )}
          <div className="font-mono text-[9px] text-zinc-600 leading-relaxed">
            follow-up is affine-registered to baseline (SimpleITK). diff map loads into Activation Maps.
          </div>
        </>
      )}
    </div>
  );
};

export default LongitudinalPanel;
