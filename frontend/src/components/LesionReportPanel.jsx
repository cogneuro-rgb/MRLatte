import React, { useState } from "react";
import { FileText, Download, FileType, FileCode } from "lucide-react";
import { jsPDF } from "jspdf";
import { buildLesionReportModel, renderReportParagraph, renderReportText, RETINOTOPY_ILLUSTRATIVE_NOTE } from "@/lib/lesionReport";
import { generateLesionReportHtml } from "@/lib/htmlReport";
import { downloadText } from "@/lib/volumeAnalysis";
import { toast } from "sonner";

/**
 * LesionReportPanel — one-click structured clinical report for a lesion:
 * volume, MNI centroid, per-atlas % involvement. Exports TXT or PDF.
 * Reuses computeAtlasOverlap.
 *
 * Props:
 *   viewerRef            - NiivueViewer imperative ref
 *   lesionLayers         - [{ id, name }]
 *   standardAtlases      - STANDARD_ATLASES config list
 *   visibleAtlasIds      - atlas ids currently visible (default selection)
 *   atlasLabelsRef       - ref: { atlasId: { labelInt: name } }
 *   ensureAtlasLoaded    - async (atlasId, {silent}) => NVImage
 *   retinotopyLayers     - [{ id, name, kind: "polar"|"eccen", illustrative, attribution }]
 *                          polar/eccen maps to include in the report. Only those
 *                          ALREADY loaded in the viewer are used (a missing
 *                          white-matter template map is silently skipped — never
 *                          force-loaded, so it can't 404 during report generation).
 *   getPolarDiscDataUrl    - () => string | null  — Benson polar disc data URL
 *   getVfMap2dDataUrl      - () => Promise<string | null>  — Benson 2D VF map data URL
 *   getWmPolarDiscDataUrl  - () => string | null  — WM polar disc data URL
 *   getWmVfMap2dDataUrl    - () => Promise<string | null>  — WM 2D VF map data URL
 */
export const LesionReportPanel = ({
  viewerRef, lesionLayers = [], standardAtlases = [],
  visibleAtlasIds = [], atlasLabelsRef, ensureAtlasLoaded,
  retinotopyLayers = [],
  getPolarDiscDataUrl,
  getVfMap2dDataUrl,
  getWmPolarDiscDataUrl,
  getWmVfMap2dDataUrl,
}) => {
  const [selLesion, setSelLesion] = useState("");
  const [selAtlases, setSelAtlases] = useState(() => new Set(visibleAtlasIds));
  const [model, setModel] = useState(null);
  const [busy, setBusy] = useState(false);

  const toggleAtlas = (id) => {
    setSelAtlases((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const generate = async () => {
    const lesionId = selLesion || lesionLayers[0]?.id;
    if (!lesionId) return toast.error("No lesion layer");
    const lesionVol = viewerRef.current?.getVolume?.(lesionId);
    if (!lesionVol?.img) return toast.error("Lesion volume unavailable");
    setBusy(true);
    try {
      const atlases = [];
      for (const a of standardAtlases) {
        if (!selAtlases.has(a.id)) continue;
        await ensureAtlasLoaded?.(a.id, { silent: true });
        const vol = viewerRef.current?.getVolume?.(a.id);
        const labels = atlasLabelsRef?.current?.[a.id];
        if (vol?.img && labels) atlases.push({ id: a.id, name: a.name, vol, labels });
      }
      // Retinotopy maps already loaded in the viewer (cortical Benson is
      // auto-loaded once a lesion exists; white-matter template only if the
      // user toggled it). Never force-load here — a missing WM map is skipped.
      const retinotopy = [];
      for (const r of retinotopyLayers) {
        const vol = viewerRef.current?.getVolume?.(r.id);
        if (vol?.img) retinotopy.push({ ...r, vol });
      }
      const lesionName = lesionLayers.find((l) => l.id === lesionId)?.name || lesionId;
      const m = buildLesionReportModel({
        lesionName,
        lesionVol,
        atlases,
        retinotopy,
      });
      setModel(m);
      toast.success("Report generated");
    } catch (e) {
      toast.error("Report failed", { description: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const exportTxt = () => {
    if (!model) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`lesion_report_${ts}.txt`, renderReportText(model), "text/plain");
  };

  const exportPdf = () => {
    if (!model) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const margin = 40;
    let y = margin;
    const W = doc.internal.pageSize.getWidth() - margin * 2;
    const line = (txt, size = 10, bold = false) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(size);
      for (const seg of doc.splitTextToSize(txt, W)) {
        if (y > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
        doc.text(seg, margin, y);
        y += size + 4;
      }
    };
    line("NeuroVue Lesion Report", 16, true);
    line(`Generated: ${model.generatedAt}`, 8);
    line(`Lesion: ${model.lesionName || "(unnamed)"}`, 10);
    y += 6;
    line(renderReportParagraph(model), 10);
    y += 6;
    for (const b of model.atlasBreakdowns) {
      line(b.atlasName, 11, true);
      for (const r of b.rows) {
        line(`  ${r.regionName} — ${r.percentOfLesion.toFixed(1)}% of lesion, ${r.percentOfRegion.toFixed(1)}% of region (${r.voxelCount} vox)`, 9);
      }
      y += 4;
    }
    const ret = model.retinotopyFindings || [];
    if (ret.length) {
      line("Retinotopy", 11, true);
      for (const f of ret) line(`  ${f.name} (${f.kind}) — ${f.summary}`, 9);
      if (ret.some((f) => f.illustrative)) line(`  ${RETINOTOPY_ILLUSTRATIVE_NOTE}`, 8);
      for (const a of [...new Set(ret.filter((f) => f.attribution).map((f) => f.attribution))]) {
        line(`  Source: ${a}`, 8);
      }
      y += 4;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    doc.save(`lesion_report_${ts}.pdf`);
  };

  const exportHtml = async () => {
    if (!model) return;
    const polarDiscDataUrl   = getPolarDiscDataUrl?.()           ?? null;
    const vfMap2dDataUrl     = (await getVfMap2dDataUrl?.())     ?? null;
    const wmPolarDiscDataUrl = getWmPolarDiscDataUrl?.()         ?? null;
    const wmVfMap2dDataUrl   = (await getWmVfMap2dDataUrl?.())   ?? null;
    const html = generateLesionReportHtml(model, {
      polarDiscDataUrl, vfMap2dDataUrl,
      wmPolarDiscDataUrl, wmVfMap2dDataUrl,
    });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`lesion_report_${ts}.html`, html, "text/html");
  };

  return (
    <div className="space-y-3" data-testid="lesion-report-panel">
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
        <FileText size={11} /> one-click lesion report
      </div>

      {lesionLayers.length > 1 && (
        <select
          value={selLesion}
          onChange={(e) => setSelLesion(e.target.value)}
          className="w-full bg-[#0a0a0a] border border-[#27272A] text-[11px] text-zinc-200 px-2 py-1.5"
          data-testid="report-lesion-select"
        >
          <option value="">{lesionLayers[0]?.name || "First lesion"}</option>
          {lesionLayers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      )}

      <div className="space-y-1">
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-600">atlases</div>
        <div className="grid grid-cols-2 gap-1">
          {standardAtlases.map((a) => (
            <button
              key={a.id}
              onClick={() => toggleAtlas(a.id)}
              className={`py-1 text-[10px] uppercase tracking-[0.1em] border transition-colors ${
                selAtlases.has(a.id)
                  ? "bg-white text-black border-white"
                  : "bg-transparent text-zinc-400 border-[#27272A] hover:text-white hover:border-zinc-500"
              }`}
              data-testid={`report-atlas-${a.id}`}
            >
              {a.short || a.id}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={generate}
        disabled={busy || lesionLayers.length === 0}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.15em] transition-colors border bg-white text-black border-white hover:bg-zinc-200 disabled:opacity-50"
        data-testid="report-generate"
      >
        <FileText size={12} />{busy ? "Generating…" : "Generate Report"}
      </button>

      {model && (
        <>
          <div className="border border-[#27272A] bg-[#0a0a0a] p-3 text-[11px] text-zinc-300 leading-relaxed max-h-48 overflow-y-auto thin-scroll" data-testid="report-preview">
            {renderReportParagraph(model)}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <button onClick={exportTxt}
              className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500"
              data-testid="report-export-txt">
              <Download size={11} />TXT
            </button>
            <button onClick={exportPdf}
              className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500"
              data-testid="report-export-pdf">
              <FileType size={11} />PDF
            </button>
            <button onClick={exportHtml}
              className="flex items-center justify-center gap-1.5 py-1.5 text-[10px] uppercase tracking-[0.15em] border bg-transparent text-zinc-300 border-[#27272A] hover:text-white hover:border-zinc-500"
              data-testid="report-export-html">
              <FileCode size={11} />HTML
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default LesionReportPanel;
