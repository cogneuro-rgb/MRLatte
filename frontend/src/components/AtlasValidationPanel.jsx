import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CheckCircle2, XCircle, AlertCircle, FileText, Image as ImageIcon, RefreshCw } from "lucide-react";

const PAIRS = [
  {
    label: "Benson 2014 — Polar Angle",
    description: "Bowtie / rainbow pattern wrapping the calcarine sulcus.",
    surface: "01_polar_angle_surface.png",
    volume: "02_polar_angle_volume.png",
  },
  {
    label: "Benson 2014 — Eccentricity",
    description: "Rings radiating from the foveal centre (occipital pole) outward.",
    surface: "03_eccen_surface.png",
    volume: "04_eccen_volume.png",
  },
  {
    label: "Benson 2014 — Visual Areas (V1–V12)",
    description: "Striped bands V1 → V2 → V3 in occipital cortex (12 areas total).",
    surface: "05_varea_surface.png",
    volume: "06_varea_volume.png",
  },
  {
    label: "Wang 2015 — Max-probability ROIs",
    description: "25 retinotopic ROIs from V1v to FEF.",
    surface: "07_wang_surface.png",
    volume: "08_wang_volume.png",
  },
];

const CHECK_LABELS = {
  value_range: "Value range",
  spatial_overlap: "Spatial overlap",
  label_completeness: "Label completeness",
  hemisphere_balance: "Hemisphere balance",
};

function CheckIcon({ pass }) {
  if (pass) return <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />;
  return <XCircle size={12} className="text-red-500 shrink-0" />;
}

function PassFailSummary({ checks, checkError }) {
  if (checkError) {
    return (
      <div className="flex items-center gap-2 p-3 border border-[#27272A] bg-[#050505] text-zinc-400 text-[12px]">
        <AlertCircle size={13} className="text-amber-500 shrink-0" />
        Could not load verification results. Ensure the backend is running.
      </div>
    );
  }

  if (checks === null) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 bg-[#111] border border-[#27272A] animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="atlas-check-results">
      {checks.map((atlas) => (
        <div
          key={atlas.file}
          className="border border-[#27272A] bg-[#050505] p-3"
          data-testid={`atlas-check-row-${atlas.file}`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-[13px] font-medium text-zinc-100">{atlas.name}</div>
            <span
              className={`flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.15em] ${
                atlas.overall_pass ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {atlas.overall_pass ? (
                <CheckCircle2 size={11} />
              ) : (
                <XCircle size={11} />
              )}
              {atlas.overall_pass ? "Pass" : "Fail"}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
            {Object.entries(atlas.checks).map(([key, check]) => (
              <div key={key} className="flex items-start gap-1.5">
                <CheckIcon pass={check.pass} />
                <span className="text-[11px] text-zinc-400">
                  <span className="text-zinc-300">{CHECK_LABELS[key] ?? key}:</span>{" "}
                  {check.detail}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export const AtlasValidationPanel = ({ open, onOpenChange }) => {
  const [report, setReport] = useState("");
  const [checks, setChecks] = useState(null);
  const [checkError, setCheckError] = useState(false);
  const [rtResult, setRtResult] = useState(null);
  const [rtLoading, setRtLoading] = useState(false);
  const [rtError, setRtError] = useState(null);
  const apiBase = process.env.REACT_APP_BACKEND_URL || "";

  useEffect(() => {
    if (!open) return;

    fetch(`${apiBase}/api/validation/report`)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then(setReport)
      .catch(() => setReport("(Unable to load validation report.)"));

    setChecks(null);
    setCheckError(false);
    fetch(`${apiBase}/api/validation/check`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => setChecks(data.atlases))
      .catch(() => setCheckError(true));
  }, [open, apiBase]);

  const runRoundTrip = () => {
    setRtLoading(true);
    setRtError(null);
    setRtResult(null);
    fetch(`${apiBase}/api/validation/round-trip`)
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e.detail || "Request failed"))))
      .then((data) => { setRtResult(data); setRtLoading(false); })
      .catch((err) => { setRtError(String(err)); setRtLoading(false); });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[1400px] w-[95vw] max-h-[90vh] overflow-y-auto bg-[#0a0a0a] border border-[#27272A] text-zinc-100"
        data-testid="atlas-validation-panel"
      >
        <DialogTitle className="flex items-center gap-2 text-zinc-100">
          <CheckCircle2 size={16} className="text-zinc-400" />
          Atlas Verification — Benson 2014 & Wang 2015
        </DialogTitle>
        <p className="text-[12px] text-zinc-400 leading-relaxed -mt-2">
          Source <code>.mgz</code> files from{" "}
          <a href="https://github.com/noahbenson/neuropythy" target="_blank" rel="noreferrer"
             className="underline hover:text-white">noahbenson/neuropythy</a>{" "}
          and{" "}
          <a href="https://napl.scholar.princeton.edu/resources" target="_blank" rel="noreferrer"
             className="underline hover:text-white">Kastner Lab</a>, projected onto fsaverage
          surfaces and rasterised into MNI152 via dense KD-tree gray-matter fill (~1.35M
          points/hemi, 3 mm radius). Each row pairs the fsaverage surface render with the
          resulting MNI152 volume slice for direct visual comparison.
        </p>

        {/* Pass/Fail verification results */}
        <div className="mt-2">
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-100 mb-2">
            <CheckCircle2 size={12} className="text-zinc-400" />
            Quantitative Verification
          </div>
          <PassFailSummary checks={checks} checkError={checkError} />
        </div>

        {/* Round-trip fidelity */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-100">
              <RefreshCw size={12} className="text-zinc-400" />
              Round-Trip Fidelity Test
            </div>
            <button
              onClick={runRoundTrip}
              disabled={rtLoading}
              className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-mono uppercase tracking-[0.1em] border border-[#27272A] bg-[#111] text-zinc-300 hover:text-white hover:border-zinc-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {rtLoading ? (
                <>
                  <RefreshCw size={10} className="animate-spin" />
                  Running…
                </>
              ) : (
                "Run test"
              )}
            </button>
          </div>

          {rtError && (
            <div className="flex items-center gap-2 p-3 border border-[#27272A] bg-[#050505] text-zinc-400 text-[12px]">
              <AlertCircle size={13} className="text-red-500 shrink-0" />
              {rtError}
            </div>
          )}

          {!rtResult && !rtError && !rtLoading && (
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Samples the generated MNI152 volumes back onto the fsaverage surface and compares
              reconstructed values against the original source .mgz files. Measures projection
              fidelity, spatial drift, label bleeding, and boundary degradation.
              Runs in ~10–30 s.
            </p>
          )}

          {rtLoading && (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-10 bg-[#111] border border-[#27272A] animate-pulse" />
              ))}
            </div>
          )}

          {rtResult && (
            <div className="space-y-2">
              {Object.values(rtResult.atlases || {}).map((atlas) => {
                const rt = atlas.round_trip || {};
                const atype = rt.mean_circular_mae_deg !== undefined
                  ? "polar_angle"
                  : rt.mean_mae_deg !== undefined
                  ? "eccentricity"
                  : "categorical";

                const passed = rt.pass;
                const mainMetric =
                  atype === "polar_angle"
                    ? `MAE ${rt.mean_circular_mae_deg}° (circular)`
                    : atype === "eccentricity"
                    ? `MAE ${rt.mean_mae_deg}°`
                    : `Accuracy ${rt.mean_overall_accuracy !== null ? (rt.mean_overall_accuracy * 100).toFixed(1) + "%" : "—"}`;

                const npyKey = atlas.name?.includes("Polar")
                  ? "benson14_polar_angle"
                  : atlas.name?.includes("Eccen")
                  ? "benson14_eccentricity"
                  : atlas.name?.includes("Visual")
                  ? "benson14_visual_areas"
                  : "wang2015_maxprob";
                const npyAtlas = rtResult.neuropythy_reference?.[npyKey];
                const npyMetric = npyAtlas
                  ? Object.entries(npyAtlas)
                      .filter(([k]) => k.includes("mae") || k.includes("accuracy"))
                      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "number" ? (k.includes("acc") ? (v * 100).toFixed(1) + "%" : v + "°") : v}`)
                      .join(" · ")
                  : null;

                return (
                  <div
                    key={atlas.name}
                    className="border border-[#27272A] bg-[#050505] p-3"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="text-[13px] font-medium text-zinc-100">{atlas.name}</div>
                      <span
                        className={`flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.15em] ${
                          passed ? "text-emerald-400" : "text-red-400"
                        }`}
                      >
                        {passed ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                        {passed ? "Pass" : "Fail"}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                      <div className="text-[11px] text-zinc-400">
                        <span className="text-zinc-300">Round-trip: </span>
                        {mainMetric}
                      </div>
                      {["lh", "rh"].map((h) => {
                        const hd = rt[h];
                        if (!hd || hd.error) return null;
                        const cov = hd.coverage_pct;
                        const bnd = hd.boundary_accuracy != null
                          ? ` · boundary ${(hd.boundary_accuracy * 100).toFixed(1)}%`
                          : "";
                        return (
                          <div key={h} className="text-[11px] text-zinc-400">
                            <span className="text-zinc-300 uppercase">{h}: </span>
                            {atype === "polar_angle"
                              ? `${hd.circular_mae_deg}° MAE · r=${hd.pearson_r}`
                              : atype === "eccentricity"
                              ? `${hd.mae_deg}° MAE · r=${hd.pearson_r}`
                              : `${(hd.overall_accuracy * 100).toFixed(1)}% acc${bnd}`}
                            {cov != null && (
                              <span className="text-zinc-600"> · {cov}% cov</span>
                            )}
                          </div>
                        );
                      })}
                      {npyMetric && (
                        <div className="text-[11px] text-zinc-500 col-span-2 mt-0.5">
                          <span className="text-zinc-400">vs neuropythy: </span>
                          {npyMetric}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* neuropythy availability badge */}
              <div className="text-[10px] font-mono text-zinc-600 mt-1">
                {rtResult.neuropythy_reference?.available === true
                  ? "neuropythy reference: available"
                  : rtResult.neuropythy_reference?.available === false
                  ? `neuropythy reference: unavailable — ${rtResult.neuropythy_reference?.reason}`
                  : null}
              </div>
            </div>
          )}
        </div>

        {/* Image pairs */}
        <div className="space-y-4 mt-4" data-testid="atlas-validation-pairs">
          {PAIRS.map((p, idx) => (
            <div
              key={p.surface}
              className="border border-[#27272A] bg-[#050505] p-3"
              data-testid={`atlas-validation-row-${idx}`}
            >
              <div className="flex items-baseline justify-between mb-2">
                <div className="text-[13px] font-medium text-zinc-100">{p.label}</div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  {idx + 1} / {PAIRS.length}
                </div>
              </div>
              <div className="text-[11px] text-zinc-400 mb-3">{p.description}</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <figure className="space-y-1.5">
                  <figcaption className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500 flex items-center gap-1.5">
                    <ImageIcon size={10} />
                    fsaverage source (.mgz)
                  </figcaption>
                  <img
                    src={`${apiBase}/api/validation/plots/${p.surface}`}
                    alt={`${p.label} — surface`}
                    className="w-full border border-[#27272A] bg-black"
                    loading="lazy"
                  />
                </figure>
                <figure className="space-y-1.5">
                  <figcaption className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500 flex items-center gap-1.5">
                    <ImageIcon size={10} />
                    MNI152 volume (projected)
                  </figcaption>
                  <img
                    src={`${apiBase}/api/validation/plots/${p.volume}`}
                    alt={`${p.label} — volume`}
                    className="w-full border border-[#27272A] bg-black"
                    loading="lazy"
                  />
                </figure>
              </div>
            </div>
          ))}
        </div>

        {/* Numerical report */}
        <div className="mt-4 border border-[#27272A] bg-[#050505] p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-100">
            <FileText size={12} />
            Numerical Validation Report
          </div>
          <pre
            className="font-mono text-[10px] text-zinc-300 leading-relaxed whitespace-pre-wrap overflow-x-auto"
            data-testid="atlas-validation-report"
          >
            {report || "Loading…"}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AtlasValidationPanel;
