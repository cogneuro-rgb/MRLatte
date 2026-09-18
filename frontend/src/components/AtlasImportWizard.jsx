import React, { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Upload, X } from "lucide-react";
import { commitImport, discardImport, stageImport } from "@/lib/atlasApi";

/**
 * Import an atlas the user supplies.
 *
 * Three steps, because the middle one is the point: an atlas arrives in
 * whatever shape its author left it, and the user has to SEE what we found
 * before it becomes a permanent part of their install.
 *
 *   1. files    the volume, plus a label list if the volume has no names
 *   2. review   validation report, editable id/name, editable region names,
 *               and the left/right split offer when labels straddle the midline
 *   3. commit   writes the atlas folder
 *
 * Nothing touches the atlas directory until commit; step 1 stages the upload in
 * a temp dir the backend cleans up on commit, discard or error.
 */
export default function AtlasImportWizard({ onInstalled, onClose }) {
  const [stage, setStage] = useState(null);   // server response from /import/stage
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ id: "", name: "", short: "", description: "", attribution: "" });
  const [splitLR, setSplitLR] = useState(false);
  const [regions, setRegions] = useState([]);
  const [filter, setFilter] = useState("");
  const volumeRef = useRef(null);
  const labelsRef = useRef(null);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? regions.filter((r) => r.name.toLowerCase().includes(q)) : regions;
    // The table is editable, so it is rendered in full rather than virtualised;
    // cap it instead — a 1000-parcel atlas is not renamed by hand.
    return list.slice(0, 300);
  }, [regions, filter]);

  const upload = async () => {
    const volume = volumeRef.current?.files?.[0];
    if (!volume) return toast.error("Choose an atlas volume (.nii or .nii.gz)");
    setBusy(true);
    try {
      const res = await stageImport({
        volume,
        labels: labelsRef.current?.files?.[0] || null,
        name: volume.name,
      });
      setStage(res);
      setRegions(res.regions || []);
      setSplitLR(false);
      setForm({
        id: res.suggestedId || "",
        name: res.suggestedName || res.suggestedId || "",
        short: res.suggestedName || res.suggestedId || "",
        description: "",
        attribution: "",
      });
    } catch (e) {
      toast.error("Could not read that atlas", { description: e.message });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (stage?.stageId) {
      try { await discardImport(stage.stageId); } catch (_e) { /* already gone */ }
    }
    setStage(null);
    setRegions([]);
    onClose?.();
  };

  const commit = async () => {
    if (!form.id.trim()) return toast.error("Give the atlas an id");
    setBusy(true);
    try {
      const res = await commitImport(stage.stageId, {
        id: form.id.trim(),
        name: form.name.trim() || form.id.trim(),
        short: form.short.trim() || form.name.trim() || form.id.trim(),
        description: form.description.trim(),
        attribution: form.attribution.trim() || null,
        splitLR,
        regions,
      });
      toast.success(`${res.atlas.name} installed`);
      setStage(null);
      setRegions([]);
      onInstalled?.(res.atlas);
    } catch (e) {
      toast.error("Import failed", { description: e.message });
    } finally {
      setBusy(false);
    }
  };

  const renameRegion = (value, name) =>
    setRegions((prev) => prev.map((r) => (r.value === value ? { ...r, name } : r)));

  // ---- step 1 --------------------------------------------------------------
  if (!stage) {
    return (
      <div className="space-y-3 text-[12px]">
        <p className="text-muted-foreground">
          Add your own parcellation. The volume must be a 3-D NIfTI whose voxel
          values are whole numbers, one per region — the same thing FSL, FreeSurfer
          and AFNI call a label or parcellation volume.
        </p>

        <label className="block">
          <span className="mb-1 block text-foreground">Atlas volume <span className="text-muted-foreground">(required)</span></span>
          <input ref={volumeRef} type="file" accept=".nii,.nii.gz,.gz"
            className="w-full border border-border bg-transparent px-2 py-1 text-[11px]"
            data-testid="atlas-import-volume" />
        </label>

        <label className="block">
          <span className="mb-1 block text-foreground">Region names <span className="text-muted-foreground">(optional)</span></span>
          <input ref={labelsRef} type="file" accept=".json,.csv,.tsv,.txt,.xml,.lut"
            className="w-full border border-border bg-transparent px-2 py-1 text-[11px]"
            data-testid="atlas-import-labels" />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            Most atlases ship their names in a separate file. Accepted:
            JSON (<code>[{"{index, name}"}]</code> or <code>{'{"1": "name"}'}</code>),
            CSV (<code>value,name</code>), a FreeSurfer/FSL colour LUT
            (<code>index name R G B</code> — its colours are imported too),
            FSL XML, or one name per line.
            <strong className="text-foreground"> If you leave this empty</strong> the
            regions are named “Region 1…N” and you can rename them on the next step.
          </span>
        </label>

        <div className="flex items-center gap-2 pt-1">
          <button onClick={upload} disabled={busy}
            className="flex items-center gap-1 border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-panel-hover disabled:opacity-50"
            data-testid="atlas-import-upload">
            <Upload size={12} /> {busy ? "Inspecting…" : "Inspect atlas"}
          </button>
          <button onClick={cancel} className="px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ---- step 2 --------------------------------------------------------------
  const rep = stage.report || {};
  return (
    <div className="space-y-3 text-[12px]">
      <div className="border border-border p-2">
        <div className="mb-1 flex items-center gap-1 text-foreground">
          <Check size={12} className="opacity-70" /> What we found
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <dt>Type</dt><dd className="text-foreground">{rep.kind}</dd>
          <dt>Regions</dt><dd className="text-foreground">{rep.labelCount}</dd>
          <dt>Grid</dt><dd className="text-foreground">{(rep.shape || []).join(" × ")}</dd>
          <dt>Voxel size</dt><dd className="text-foreground">{(rep.voxelSizeMM || []).join(" × ")} mm</dd>
          <dt>Left/right</dt>
          <dd className="text-foreground">
            {rep.lateralized === true ? "already split"
              : rep.canSplitLR ? `${rep.bilateralValues.length} region(s) span both sides`
              : "unknown"}
          </dd>
        </dl>
        {(rep.warnings || []).map((w, i) => (
          <div key={i} className="mt-1 flex items-start gap-1 text-[11px] text-warning">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{w}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Id" hint="folder name; letters, digits, underscores"
          value={form.id} onChange={(v) => setForm((f) => ({ ...f, id: v }))} testId="atlas-import-id" />
        <Field label="Name" value={form.name}
          onChange={(v) => setForm((f) => ({ ...f, name: v }))} testId="atlas-import-name" />
        <Field label="Short name" hint="shown in dropdowns and the crosshair bar"
          value={form.short} onChange={(v) => setForm((f) => ({ ...f, short: v }))} testId="atlas-import-short" />
        <Field label="Attribution" hint="citation, shown in reports"
          value={form.attribution} onChange={(v) => setForm((f) => ({ ...f, attribution: v }))} testId="atlas-import-attrib" />
      </div>
      <Field label="Description" value={form.description}
        onChange={(v) => setForm((f) => ({ ...f, description: v }))} testId="atlas-import-desc" />

      {rep.canSplitLR && (
        <label className="flex items-start gap-2 border border-border p-2">
          <input type="checkbox" checked={splitLR} onChange={(e) => setSplitLR(e.target.checked)}
            className="mt-0.5" data-testid="atlas-import-split" />
          <span className="text-[11px]">
            <span className="text-foreground">Split left and right</span>
            <span className="block text-muted-foreground">
              {rep.bilateralValues.length} of {rep.labelCount} regions have voxels in
              both hemispheres. Splitting rewrites the volume and the region list
              together, giving{" "}
              <strong className="text-foreground">
                {rep.labelCount + rep.bilateralValues.length}
              </strong>{" "}
              regions named “… (L)” and “… (R)”. Regions already on one side keep
              their name.
            </span>
          </span>
        </label>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-foreground">Region names</span>
          <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${regions.length}…`}
            className="border border-border bg-transparent px-2 py-0.5 text-[11px] focus:outline-none"
            data-testid="atlas-import-region-filter" />
        </div>
        <div className="max-h-56 overflow-y-auto border border-border">
          {shown.map((r) => (
            <div key={r.value} className="flex items-center gap-2 border-b border-border px-2 py-0.5 last:border-b-0">
              <span className="w-10 shrink-0 text-right text-[10px] text-muted-foreground">{r.value}</span>
              <input value={r.name} onChange={(e) => renameRegion(r.value, e.target.value)}
                className="min-w-0 flex-1 bg-transparent py-0.5 text-[11px] text-foreground focus:outline-none"
                data-testid={`atlas-import-region-${r.value}`} />
            </div>
          ))}
          {regions.length > shown.length && (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              …and {regions.length - shown.length} more (filter to reach them)
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={commit} disabled={busy}
          className="flex items-center gap-1 border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-panel-hover disabled:opacity-50"
          data-testid="atlas-import-commit">
          <Check size={12} /> {busy ? "Installing…" : "Install atlas"}
        </button>
        <button onClick={cancel} disabled={busy}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          data-testid="atlas-import-cancel">
          <X size={12} /> Discard
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, value, onChange, testId }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-foreground">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full border border-border bg-transparent px-2 py-1 text-[11px] text-foreground focus:outline-none"
        data-testid={testId} />
      {hint && <span className="mt-0.5 block text-[10px] text-muted-foreground">{hint}</span>}
    </label>
  );
}
