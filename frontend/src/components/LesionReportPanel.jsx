import React, { useRef, useState } from "react";
import { FileText, Download, FileType, FileCode, FlaskConical } from "lucide-react";
import { describeTransform } from "@/lib/overlayTransform";
import { loadAtlasesForReading } from "@/lib/atlasLoad";
import {
  buildLesionReportModel, renderReportParagraph, renderReportText,
  engineProvenanceLabel, RETINOTOPY_ILLUSTRATIVE_NOTE, resolveReportFragments,
} from "@/lib/lesionReport";
import { currentDrawingAsFile } from "@/lib/lesions";
import { isDevBuild, useLesionEngineDevOverride } from "@/lib/lesionMetrics";
import { useReportDialog } from "@/hooks/useReportDialog";
import { activeToggleCls, ghostBtnCls } from "@/lib/buttonVariants";
import { buildReport, glanceText } from "@/lib/report";
import { lesionFigure } from "@/lib/report/figures";
import { ReportDialog } from "@/components/ReportDialog";
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
 *   ensureAtlasRegions   - loads an atlas's canonical regions on demand
 *   ensureAtlasLoaded    - async (atlasId, {silent}) => NVImage
 *   retinotopyLayers     - [{ id, name, kind: "polar"|"eccen", illustrative, attribution }]
 *                          polar/eccen maps to include in the report. Only those
 *                          ALREADY loaded are used (a missing white-matter
 *                          template map is silently skipped — never force-loaded,
 *                          so it can't 404 during report generation).
 *   retinoVolume           - (id) => NVImage | null — a retinotopy map, on or off screen
 *   getVfMap2dDataUrl      - (lesionId) => Promise<string | null>  — Benson 2D VF map for that lesion
 *   getWmVfMap2dDataUrl    - (lesionId) => Promise<string | null>  — WM 2D VF map for that lesion
 */
export const LesionReportPanel = ({
  // `bare`: no heading of its own, for a caller that folds it under one.
  bare = false,
  viewerRef, lesionLayers = [], standardAtlases = [],
  visibleAtlasIds = [], ensureAtlasRegions, ensureAtlasLoaded,
  retinotopyLayers = [],
  userFileCache,
  retinoVolume,
  getVfMap2dDataUrl,
  getWmVfMap2dDataUrl,
}) => {
  const [selLesion, setSelLesion] = useState("");
  const [selAtlases, setSelAtlases] = useState(() => new Set(visibleAtlasIds));
  const [model, setModel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [genError, setGenError] = useState(null);
  const [devEngine, setDevEngine] = useLesionEngineDevOverride();
  // §6 stale-response guard: a lesion/atlas change (or a second Generate
  // click) while a report is building must not let an OLD response
  // overwrite the model a newer request already set.
  const requestIdRef = useRef(0);
  // The resolved lesion File for the CURRENT model — kept around so
  // handleOpenReport can fetch lqtpy report fragments (morphometry detail /
  // network rollup / disconnection) without re-resolving it. Content-hash
  // deduped by uploadLesion, so re-uploading it there is cheap.
  const lesionFileRef = useRef(null);
  // The lesion layer the CURRENT model was built from, for its figure.
  const lesionIdRef = useRef(null);
  // Item 103: uniform Open/Save report dialog. reportHtml is built once (it
  // needs the async retinotopy-disc data URLs) and reused by the dialog's
  // own Open-in-new-window/Save actions.
  const { reportOpen, setReportOpen, openReport } = useReportDialog();
  const [reportHtml, setReportHtml] = useState(null);
  const [reportBusy, setReportBusy] = useState(false);

  const resolveLesionFile = async (lesionId) => {
    const cached = userFileCache?.current?.[lesionId]?.file;
    if (cached) return cached;
    return currentDrawingAsFile(viewerRef, `${lesionId}.nii.gz`);
  };

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
    const myRequestId = ++requestIdRef.current;
    setBusy(true);
    setGenError(null);
    try {
      const atlases = await loadAtlasesForReading(
        standardAtlases.filter((a) => selAtlases.has(a.id)),
        { viewerRef, ensureAtlasLoaded, ensureRegions: ensureAtlasRegions },
      );
      // Retinotopy maps already loaded (cortical Benson is
      // auto-loaded once a lesion exists; white-matter template only if the
      // user toggled it). Never force-load here — a missing WM map is skipped.
      const retinotopy = [];
      for (const r of retinotopyLayers) {
        // Off-screen (not in the viewer) unless shown: retinoVolume finds both.
        const vol = retinoVolume ? retinoVolume(r.id) : viewerRef.current?.getVolume?.(r.id);
        if (vol?.img) retinotopy.push({ ...r, vol });
      }
      const lesionLayer = lesionLayers.find((l) => l.id === lesionId);
      // A lesion moved by hand is analysed where it was moved to, so the report
      // has to say so next to its name (lib/overlayTransform.js).
      const adjusted = describeTransform(lesionLayer?.transform);
      const lesionName = (lesionLayer?.name || lesionId) + (adjusted ? ` (position adjusted by hand: ${adjusted})` : "");
      const lesionFile = await resolveLesionFile(lesionId);
      lesionFileRef.current = lesionFile;
      lesionIdRef.current = lesionId;
      const m = await buildLesionReportModel({
        lesionName,
        lesionVol,
        lesionFile,
        atlases,
        retinotopy,
      });
      if (requestIdRef.current !== myRequestId) return; // a newer request already landed
      setModel(m);
      if (m.excludedAtlases?.length) {
        toast.warning("Some atlases skipped", {
          description: `${m.excludedAtlases.map((a) => a.name).join(", ")} — not supported by the lqtpy engine.`,
        });
      }
      if (m.provenance?.fallback) {
        toast.warning("Report used the JS engine (fallback)", { description: m.provenance.fallbackReason || "lqtpy unavailable" });
      } else {
        toast.success("Report generated");
      }
    } catch (e) {
      if (requestIdRef.current !== myRequestId) return;
      // A 4xx (e.g. an empty lesion) or a real 5xx surfaces as an error here —
      // resolveLesionAtlasMetrics only falls back to JS on a 503, never on a
      // caller error, so this catch is a genuine failure, not a fallback.
      setGenError(e?.message || "Report failed");
      toast.error("Report failed", { description: e?.message });
    } finally {
      if (requestIdRef.current === myRequestId) setBusy(false);
    }
  };

  // The lesion drawn over the base scan (lib/report/figures.js), from the
  // volumes as loaded — the report's main figure. Null when unavailable.
  const makeLesionFigure = () => {
    try {
      const viewer = viewerRef.current;
      return lesionFigure(viewer?.getBaseVolume?.(), viewer?.getVolume?.(lesionIdRef.current));
    } catch {
      return null;
    }
  };

  const exportTxt = () => {
    if (!model) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadText(`lesion_report_${ts}.txt`, renderReportText(model), "text/plain");
  };

  const exportPdf = async () => {
    if (!model) return;
    // Lazy-load jspdf so its ~weighty bundle stays out of the main chunk and is
    // only fetched when a user actually exports a PDF.
    const { jsPDF } = await import("jspdf");
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
    line("MRLatte Lesion Report", 16, true);
    line(`Generated: ${model.generatedAt}`, 8);
    line(`Lesion: ${model.lesionName || "(unnamed)"}`, 10);
    const engineLine = engineProvenanceLabel(model.provenance);
    if (engineLine) line(engineLine, 8);
    y += 6;
    // The same short lead as the HTML report; the full lists are in the
    // text export.
    line(glanceText(model, { retinotopyFindings: model.retinotopyFindings }) || renderReportParagraph(model), 10);
    y += 6;
    const fig = makeLesionFigure();
    if (fig) {
      const { width, height } = doc.getImageProperties(fig.src);
      const h = (W * height) / width;
      if (y + h > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
      doc.addImage(fig.src, "PNG", margin, y, W, h);
      y += h + 12;            // text is drawn on its baseline: clear the image first
      line(fig.caption, 8);
      y += 6;
    }
    // Top five regions per atlas (1% of the lesion or more), like the HTML
    // report's tables; the full lists are in the HTML and text exports.
    for (const b of model.atlasBreakdowns) {
      line(b.atlasName, 11, true);
      const shown = b.rows.filter((r) => r.percentOfLesion >= 1).slice(0, 5);
      for (const r of shown) {
        line(`  ${r.regionName} — ${r.percentOfLesion.toFixed(1)}% of lesion, ${r.percentOfRegion.toFixed(1)}% of region (${r.voxelCount} vox)`, 9);
      }
      const more = b.rows.length - shown.length;
      const s = more === 1 ? "" : "s";
      if (more) line(shown.length
        ? `  + ${more} more region${s} in the HTML and text exports.`
        : `  ${more} region${s}, each under 1% of the lesion: listed in the HTML and text exports.`, 8);
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

  // Item 103: builds the same report via lib/report/ (shared with Tract/LNM/
  // One-Click Summary) and opens it in the uniform Open/Save dialog.
  const handleOpenReport = async () => {
    if (!model) return;
    setReportBusy(true);
    try {
      // Visual-field maps computed for THIS report's lesion.
      const vfMap2dDataUrl   = (await getVfMap2dDataUrl?.(lesionIdRef.current))   ?? null;
      const wmVfMap2dDataUrl = (await getWmVfMap2dDataUrl?.(lesionIdRef.current)) ?? null;
      // lqtpy's embeddable sections (morphometry detail / network rollup /
      // disconnection) for the atlases already used above. Fails soft —
      // resolveReportFragments never throws, so a slow/failed fetch here
      // degrades to one quiet note in the report, not a broken "Report" button.
      const atlasIds = (model.atlasBreakdowns || []).map((b) => b.atlasId);
      const reportFragments = await resolveReportFragments({
        lesionFile: lesionFileRef.current, atlasIds, threshold: model.provenance?.threshold,
      });
      const html = buildReport("lesion", {
        ...model, vfMap2dDataUrl, wmVfMap2dDataUrl,
        reportFragments, lesionFigure: makeLesionFigure(),
      });
      setReportHtml(html);
      openReport();
    } finally {
      setReportBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="lesion-report-panel">
      {(!bare || isDevBuild()) && (
      <div className="flex items-center gap-2">
        {!bare && <span className="cap flex-1 text-subtle">One-click lesion report</span>}
        {isDevBuild() && (
          <button
            onClick={() => setDevEngine(devEngine === "js" ? null : "js")}
            title="Dev only: force the JS engine instead of lqtpy, for side-by-side comparison"
            aria-pressed={devEngine === "js"}
            className={`btn-mini ${devEngine === "js" ? "!border-warn !bg-warn/15 !text-warn" : ""}`}
            data-testid="report-dev-engine-toggle"
          >
            <FlaskConical size={11} /> JS
          </button>
        )}
      </div>
      )}

      {lesionLayers.length > 1 && (
        <select
          value={selLesion}
          onChange={(e) => setSelLesion(e.target.value)}
          className="field w-full"
          data-testid="report-lesion-select"
        >
          <option value="">{lesionLayers[0]?.name || "First lesion"}</option>
          {lesionLayers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      )}

      <div className="space-y-1.5">
        <div className="text-[13px] text-muted-foreground">Atlases</div>
        <div className="flex flex-wrap gap-1.5">
          {standardAtlases.map((a) => (
            <button
              key={a.id}
              onClick={() => toggleAtlas(a.id)}
              aria-pressed={selAtlases.has(a.id)}
              className={`h-[26px] rounded-[5px] border px-2.5 text-[12px] transition-colors ${activeToggleCls(selAtlases.has(a.id))}`}
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
        className={ghostBtnCls}
        data-testid="report-generate"
      >
        <FileText size={12} />{busy ? "Generating…" : "Generate report"}
      </button>

      {genError && (
        <div className="text-[12px] text-destructive leading-relaxed border border-destructive/30 bg-destructive/10 px-2 py-1.5 rounded-lg" data-testid="report-error">
          {genError}
        </div>
      )}

      {model && (
        <>
          {model.excludedAtlases?.length > 0 && (
            <div className="text-[12px] text-warn leading-relaxed border border-warn/30 bg-warn/10 px-2 py-1.5 rounded-lg" data-testid="report-excluded-atlases">
              {model.excludedAtlases.map((a) => a.name).join(", ")} — not supported by the lqtpy engine ({model.excludedAtlases[0].reason}).
            </div>
          )}
          {model.provenance && (
            <div className="px-0.5 font-mono text-[11px] text-subtle" data-testid="report-provenance">
              {engineProvenanceLabel(model.provenance)}
            </div>
          )}
          <div className="max-h-48 overflow-y-auto thin-scroll rounded-lg border border-border bg-background p-3 text-[12px] leading-relaxed text-foreground" data-testid="report-preview">
            {renderReportParagraph(model)}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <button onClick={exportTxt}
              className="btn gap-1.5 px-2"
              data-testid="report-export-txt">
              <Download size={11} />TXT
            </button>
            <button onClick={exportPdf}
              className="btn gap-1.5 px-2"
              data-testid="report-export-pdf">
              <FileType size={11} />PDF
            </button>
            <button onClick={handleOpenReport} disabled={reportBusy}
              className="btn gap-1.5 px-2"
              data-testid="report-export-html">
              <FileCode size={11} />{reportBusy ? "…" : "Report"}
            </button>
          </div>
        </>
      )}
      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        title="Lesion report"
        subject={model?.lesionName}
        html={reportHtml}
        filename={`lesion_report_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`}
      />
    </div>
  );
};

export default LesionReportPanel;
