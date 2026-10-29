import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Layers, Loader2, Plus, RefreshCw, Scissors, Trash2, X } from "lucide-react";
import {
  deriveLeftRight, formatBytes, installFromCatalog, patchAtlas, pollAtlasJob, removeAtlas,
} from "@/lib/atlasApi";
import { useAtlases } from "@/hooks/use-atlases";
import { useModules } from "@/hooks/use-modules";
import { moduleStatus } from "@/lib/modules";
import { ModuleRow, deferRemoval, useModuleActions } from "@/components/ModuleStore";
import AtlasImportWizard from "@/components/AtlasImportWizard";

/**
 * Atlas Manager — everything to do with atlases, in one window: the template,
 * the shipped and downloadable atlases, the catalog of further atlases, and
 * your own (import, rename, split left/right).
 *
 * The template and each shipped or downloadable atlas is its own manifest
 * module (its `group` puts it here rather than in the Module Store), so those
 * rows ARE the Module Store's rows: one hash-checked install path (MRLatte's own
 * copy, else the module release) and one removal path. Catalog and imported
 * atlases have no manifest entry and keep the atlas endpoints.
 */

const LABEL = "text-[12px] font-medium text-muted-foreground";
const SUBTLE = "text-[12px] text-muted-foreground leading-snug";
const BTN =
  "btn inline-flex items-center justify-center gap-1.5 px-2.5 " +
  "text-foreground transition-colors hover:bg-panel-hover " +
  "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent";

const GROUPS = [
  ["template", "Template"],
  ["parcellation", "Atlases"],
  ["tracts", "Tract atlases"],
  ["retinotopy", "Retinotopy"],
  ["validation", "Validation"],
];

// Said before a module is removed: what stops working without it.
const REMOVE_NOTES = {
  "mni152-template": "Lesion network mapping loses its brain mask at once. The viewer keeps showing the template until MRLatte restarts, then starts empty until you load a scan or reinstall it.",
  "atlas-hcp1065": "The summary's visual-pathway check then uses JHU, and is skipped without either.",
  "atlas-jhu-wm": "The summary's visual-pathway check uses HCP1065, and is skipped without either.",
  "retinotopy-benson14": "The Retinotopy section and the visual-field analysis need it.",
  "retinotopy-wang2015": "Its layer leaves the Retinotopy section.",
  "validation-surfaces": "Atlas validation needs it.",
};
const ATLAS_NOTE = "It leaves the atlas list, the crosshair readout and the reports.";

// "Its split copy X goes too." for an atlas left/right copies were made from.
const copiesNote = (copies) => (!copies.length ? ""
  : `Its split cop${copies.length === 1 ? "y" : "ies"} ${copies.map((c) => c.name).join(", ")} go${copies.length === 1 ? "es" : ""} too.`);

const isVolume = (f) => /\.nii(\.gz)?$/i.test(f.name);

/** Rename and left/right split for an installed atlas. */
function AtlasTools({ atlas: a, onChanged }) {
  const [draft, setDraft] = useState(null);

  const rename = async () => {
    const name = (draft || "").trim();
    setDraft(null);
    if (!name || name === a.name) return;
    try {
      await patchAtlas(a.id, { name });
      onChanged();
    } catch (e) {
      toast.error("Rename failed", { description: e.message });
    }
  };

  const split = async () => {
    const t = toast.loading(`Splitting ${a.short || a.name} left/right…`);
    try {
      const res = await deriveLeftRight(a.id, {});
      toast.success(`${res.atlas.name} created`, { id: t });
      onChanged();
    } catch (e) {
      toast.error("Split failed", { id: t, description: e.message });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {draft === null ? (
        <button type="button" onClick={() => setDraft(a.name)} className={BTN} data-testid={`atlas-rename-${a.id}`}>
          Rename
        </button>
      ) : (
        <input
          autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={rename}
          onKeyDown={(e) => { if (e.key === "Enter") rename(); if (e.key === "Escape") setDraft(null); }}
          className="field min-w-0 flex-1"
          data-testid={`atlas-rename-input-${a.id}`}
        />
      )}
      {a.lateralized === false && (
        <button type="button" onClick={split} title="Create a left/right-split copy" className={BTN} data-testid={`atlas-split-${a.id}`}>
          <Scissors size={11} /> Split left/right
        </button>
      )}
    </div>
  );
}

/** One of your atlases: from the catalog, imported, or split from another. */
function OwnAtlasRow({ atlas: a, copies, onChanged }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const remove = () => {
    setConfirm(false);
    setPending(true);
    deferRemoval(a.name, async () => {
      try {
        const res = await removeAtlas(a.id, { cascade: true });
        toast.success(`${a.name} ${res.removed === "trashed" ? "moved to the Recycle Bin" : "deleted"}`,
          { description: `${formatBytes(res.bytesFreed)} freed` });
      } catch (e) {
        toast.error(`Could not remove ${a.name}`, { description: e.message });
      }
      setPending(false);
      onChanged();
    }, () => setPending(false));
  };
  const from = a.origin?.kind === "catalog" ? "from the catalog"
    : a.origin?.kind === "derived" || a.derivedFrom ? `split from ${a.derivedFrom}`
    : "imported by you";
  return (
    <div className="px-3 py-2.5 space-y-2" data-testid={`atlas-manager-row-${a.id}`}>
      <div className="flex items-start gap-3">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-ok" title="Installed" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-foreground leading-snug truncate">{a.name}</div>
          <div className="text-[12px] text-muted-foreground leading-snug truncate">
            {a.kind}{a.tracts4d ? " (with per-region maps)" : ""} · {from}
            {a.license?.attribution ? ` · ${a.license.attribution}` : ""}
          </div>
        </div>
        <span className="mt-0.5 shrink-0 text-[12px] text-muted-foreground tabular-nums">{formatBytes(a.bytes)}</span>
        {pending && <span className="mt-0.5 shrink-0 text-[12px] text-muted-foreground">Removing in 5 s…</span>}
        {!confirm && !pending && (
          <button type="button" onClick={() => setConfirm(true)} title="Remove this atlas" className={BTN} data-testid={`atlas-remove-${a.id}`}>
            <Trash2 size={11} />
          </button>
        )}
      </div>
      {confirm && (
        <div className="ml-5 border border-destructive/40 px-3 py-2 space-y-2 rounded-lg">
          <div className="text-[12px] text-muted-foreground">
            Remove {a.name}? The folder goes to the Recycle Bin where possible. {ATLAS_NOTE} {copiesNote(copies)}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirm(false)} className={BTN}>Keep</button>
            <button type="button" onClick={remove} className={`${BTN} border-destructive/50 text-destructive hover:text-destructive`}
              data-testid={`atlas-remove-confirm-${a.id}`}>
              <Trash2 size={11} /> Remove
            </button>
          </div>
        </div>
      )}
      <div className="ml-5"><AtlasTools atlas={a} onChanged={onChanged} /></div>
    </div>
  );
}

/** A catalog atlas not installed yet: one click, converted on the server. */
function CatalogRow({ entry: c, job, onInstall }) {
  return (
    <div className="px-3 py-2.5" data-testid={`atlas-catalog-row-${c.catalogId}`}>
      <div className="flex items-start gap-3">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-muted-foreground" title="Not installed" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-foreground leading-snug truncate">{c.name}</div>
          <div className="text-[12px] text-muted-foreground leading-snug truncate">
            {c.description}{c.license?.attribution ? ` · ${c.license.attribution}` : ""}
          </div>
        </div>
        <span className="mt-0.5 shrink-0 text-[12px] text-muted-foreground tabular-nums">{formatBytes(c.bytes)}</span>
        <button type="button" onClick={() => onInstall(c)} disabled={!!job} className={BTN} data-testid={`atlas-install-${c.catalogId}`}>
          <Download size={11} /> {job ? job.stage : "Install"}
        </button>
      </div>
      {job && (
        <div className="ml-5 mt-1.5 h-1 w-auto border border-border bg-panel-hover overflow-hidden rounded-sm">
          <div className="h-full bg-foreground transition-[width] duration-300" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

export function AtlasManager({ onChanged }) {
  const {
    managerOpen, managerTab, closeManager, atlases, catalog, refresh: refreshAtlases,
  } = useAtlases();
  const { modules, freeBytes, loading, refresh: refreshModules } = useModules();
  const [importing, setImporting] = useState(null);   // null, or { volume, labels } to start with
  const [dragging, setDragging] = useState(false);
  const [catalogJobs, setCatalogJobs] = useState({});  // catalogId -> { stage, progress }
  const moreRef = useRef(null);

  const sync = useCallback(async () => {
    await refreshAtlases();
    onChanged?.();
  }, [refreshAtlases, onChanged]);
  const actions = useModuleActions({ onChanged: sync });
  const { setJob, finish, clearJob } = actions;

  // `managerTab` says where to open: "import", "catalog", or a module id.
  const focus = managerOpen ? managerTab : null;
  useEffect(() => {
    if (!managerOpen) return;
    refreshModules();
    refreshAtlases();
    if (managerTab === "import") setImporting({});
    if (managerTab === "catalog") setTimeout(() => moreRef.current?.scrollIntoView({ block: "start" }), 0);
  }, [managerOpen, managerTab, refreshModules, refreshAtlases]);

  useEffect(() => {
    if (!managerOpen) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closeManager(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [managerOpen, closeManager]);

  // A shipped or downloaded atlas goes through the atlas endpoint, which
  // removes it as its module (so it stays removed) and, with cascade, the
  // left/right copies split from it first. Behind the same Undo as the rest.
  const removeAtlasModule = useCallback((m) => {
    setJob(m.id, { phase: "uninstall", done: false, stage: "removing in 5 s", progress: null, jobId: null, error: null, result: null });
    deferRemoval(m.name, async () => {
      setJob(m.id, { stage: "removing" });
      let res;
      try {
        res = { ok: true, data: await removeAtlas(m.atlasId, { cascade: true }) };
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      finish(m.id, res, "uninstall");
    }, () => clearJob(m.id));
  }, [setJob, finish, clearJob]);

  const installCatalog = async (entry) => {
    setCatalogJobs((p) => ({ ...p, [entry.catalogId]: { stage: "queued", progress: 0 } }));
    try {
      const { job_id: jobId } = await installFromCatalog(entry.catalogId);
      const final = await pollAtlasJob(jobId, (j) => setCatalogJobs((p) => ({ ...p, [entry.catalogId]: j })));
      if (final.error) throw new Error(final.error);
      toast.success(`${entry.name} installed`);
      await sync();
    } catch (e) {
      toast.error(`Could not install ${entry.name}`, { description: e.message });
    } finally {
      setCatalogJobs((p) => {
        const next = { ...p };
        delete next[entry.catalogId];
        return next;
      });
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files || []);
    const volume = files.find(isVolume);
    if (!volume) {
      toast.error("Drop an atlas volume (.nii or .nii.gz), with its label file if it has one");
      return;
    }
    setImporting({ volume, labels: files.find((f) => !isVolume(f)) || null });
  };

  const byGroup = useMemo(() => GROUPS.map(([key, title]) => ({
    key, title, items: modules.filter((m) => m.group === key),
  })).filter((g) => g.items.length), [modules]);
  const moduleAtlasIds = useMemo(() => new Set(modules.map((m) => m.atlasId).filter(Boolean)), [modules]);
  const own = useMemo(() => atlases.filter((a) => !moduleAtlasIds.has(a.id)), [atlases, moduleAtlasIds]);
  // A catalog entry that is another copy of a shipped atlas (`sameAs`) is not
  // offered: the shipped one is installed, or one click away above.
  const more = useMemo(() => (catalog || []).filter((c) => !c.installed
    && !(c.sameAs && moduleAtlasIds.has(c.sameAs))), [catalog, moduleAtlasIds]);
  const copiesOf = (id) => atlases.filter((a) => a.derivedFrom === id);
  const grouped = byGroup.flatMap((g) => g.items);
  const installedCount = grouped.filter((m) => moduleStatus(m) === "installed").length + own.length;

  if (!managerOpen) return null;

  return (
    <div
      className="modal-scrim fixed inset-0 z-[95] flex items-start justify-center bg-black/60 py-10 overflow-y-auto"
      onClick={closeManager}
      data-testid="atlas-manager"
    >
      <div
        className={`modal-panel w-[680px] max-w-[94vw] rounded-xl border bg-panel shadow-elev-2 ${dragging ? "border-crema" : "border-edge"}`}
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Layers size={15} className="text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-medium text-foreground leading-none">Atlas Manager</div>
            <div className="mt-1 text-[12px] text-muted-foreground">
              {installedCount} installed · each one is added and removed on its own
              {freeBytes !== null && freeBytes !== undefined && <> · {formatBytes(freeBytes)} free</>}
            </div>
          </div>
          <button type="button" onClick={() => setImporting(importing ? null : {})} className={BTN} data-testid="atlas-add-own">
            <Plus size={11} /> Add your own atlas
          </button>
          <button type="button" onClick={() => { refreshModules(); refreshAtlases(); }}
            className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            title="Check again" data-testid="atlas-manager-refresh">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <button type="button" onClick={closeManager}
            className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close" data-testid="atlas-manager-close">
            <X size={15} />
          </button>
        </div>

        {/* `relative`: absolutely positioned bits inside (the rows' sr-only
            status words) must belong to this scroll box. Without it they hung
            off the fixed scrim at their place in the full list and gave it a
            second scroll bar at the window's edge (inbox 29 Oct). */}
        <div className="relative max-h-[74vh] overflow-y-auto thin-scroll">
          {importing && (
            <div className="m-3 border border-border p-3 rounded-lg" data-testid="atlas-import">
              <div className={`${LABEL} mb-2`}>Add your own atlas</div>
              <AtlasImportWizard
                key={importing.volume ? importing.volume.name : "empty"}
                initialVolume={importing.volume || null}
                initialLabels={importing.labels || null}
                onInstalled={() => { setImporting(null); sync(); }}
                onClose={() => setImporting(null)}
              />
            </div>
          )}
          {!importing && (
            <div className={`${SUBTLE} px-4 pt-3`}>
              Drop a <span className="font-mono">.nii</span>/<span className="font-mono">.nii.gz</span> atlas
              anywhere here (with its label file) to add it.
            </div>
          )}

          {byGroup.map((g) => (
            <div key={g.key} data-testid={`atlas-group-${g.key}`}>
              <div className={`${LABEL} px-4 pt-3 pb-1`}>
                {g.title}{" "}
                <span className="font-normal normal-case tracking-normal">
                  · {g.items.filter((m) => moduleStatus(m) === "installed").length} of {g.items.length} installed
                </span>
              </div>
              <div className="divide-y divide-border border-y border-border">
                {g.items.map((m) => {
                  const atlas = m.atlasId ? atlases.find((a) => a.id === m.atlasId) : null;
                  return (
                    <ModuleRow
                      key={m.id}
                      module={m}
                      job={actions.jobs[m.id]}
                      freeBytes={freeBytes}
                      focused={focus === m.id}
                      onInstall={actions.onInstall}
                      onSideload={actions.onSideload}
                      onSlotInstall={actions.onSlotInstall}
                      onVerify={actions.onVerify}
                      onUninstall={m.atlasId ? removeAtlasModule : actions.onUninstall}
                      onCancel={actions.onCancel}
                      onDismiss={(mod) => actions.clearJob(mod.id)}
                      removeNote={`${REMOVE_NOTES[m.id] || (m.atlasId ? ATLAS_NOTE : "")} ${m.atlasId ? copiesNote(copiesOf(m.atlasId)) : ""}`.trim()}
                    >
                      {atlas && moduleStatus(m) === "installed" && <AtlasTools atlas={atlas} onChanged={sync} />}
                    </ModuleRow>
                  );
                })}
              </div>
            </div>
          ))}

          <div data-testid="atlas-group-own">
            <div className={`${LABEL} px-4 pt-3 pb-1`}>
              Your atlases <span className="font-normal normal-case tracking-normal">· {own.length}</span>
            </div>
            <div className="divide-y divide-border border-y border-border">
              {own.map((a) => <OwnAtlasRow key={a.id} atlas={a} copies={copiesOf(a.id)} onChanged={sync} />)}
              {!own.length && (
                <div className={`${SUBTLE} px-4 py-2.5`}>
                  None yet. Add one with “Add your own atlas”, or install one from the list below.
                </div>
              )}
            </div>
          </div>

          <div ref={moreRef} data-testid="atlas-group-catalog">
            <div className={`${LABEL} px-4 pt-3 pb-1`}>
              More atlases <span className="font-normal normal-case tracking-normal">· {more.length}</span>
            </div>
            <div className={`${SUBTLE} px-4 pb-1.5`}>
              Downloaded from a pinned upstream source when you install one, converted to MRLatte’s
              format and named from the publisher’s own label list.
            </div>
            <div className="divide-y divide-border border-y border-border">
              {more.map((c) => (
                <CatalogRow key={c.catalogId} entry={c} job={catalogJobs[c.catalogId]} onInstall={installCatalog} />
              ))}
              {!more.length && <div className={`${SUBTLE} px-4 py-2.5`}>Every catalog atlas is installed.</div>}
            </div>
          </div>

          <div className={`${SUBTLE} px-4 py-3`}>
            Removed atlases go to the Recycle Bin where possible, and stay removed until you install them again.
          </div>
        </div>
      </div>
    </div>
  );
}

export default AtlasManager;
