import React, { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, Layers, Scissors, Trash2, Upload, X } from "lucide-react";
import {
  deriveLeftRight, formatBytes, installFromCatalog, patchAtlas, pollAtlasJob, removeAtlas,
} from "@/lib/atlasApi";
import { useAtlases } from "@/hooks/use-atlases";
import AtlasImportWizard from "@/components/AtlasImportWizard";

/**
 * Atlas Manager overlay — install, import, rename, split and remove.
 *
 * Deliberately separate from the Module Store: a module is a fixed set of
 * pre-hashed files declared in manifest.json, and every atlas operation here
 * breaks one of those assumptions (a catalog atlas has no pre-pinned digest,
 * an imported one has no manifest entry at all, and a shipped one must still
 * be removable). The vocabulary is borrowed from ModuleStore, the machinery is
 * not.
 */
export function AtlasManager({ onChanged }) {
  const { managerOpen, managerTab, closeManager, atlases, catalog, refresh } = useAtlases();
  const [tab, setTab] = useState("installed");
  const [jobs, setJobs] = useState({});        // catalogId -> {stage, progress, error}
  const [pending, setPending] = useState(null); // atlasId awaiting delete confirm
  const [renaming, setRenaming] = useState(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (managerOpen) setTab(managerTab || "installed");
  }, [managerOpen, managerTab]);

  // Escape closes, matching every other overlay in the app.
  useEffect(() => {
    if (!managerOpen) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closeManager(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [managerOpen, closeManager]);

  const sync = async () => { await refresh(); onChanged?.(); };

  const notInstalled = useMemo(
    () => (catalog || []).filter((c) => !c.installed),
    [catalog],
  );

  if (!managerOpen) return null;

  const install = async (entry) => {
    setJobs((p) => ({ ...p, [entry.catalogId]: { stage: "queued", progress: 0 } }));
    try {
      const { job_id: jobId } = await installFromCatalog(entry.catalogId);
      const final = await pollAtlasJob(jobId, (j) =>
        setJobs((p) => ({ ...p, [entry.catalogId]: j })));
      if (final.error) throw new Error(final.error);
      toast.success(`${entry.name} installed`);
      await sync();
    } catch (e) {
      toast.error(`Could not install ${entry.name}`, { description: e.message });
    } finally {
      setJobs((p) => {
        const next = { ...p };
        delete next[entry.catalogId];
        return next;
      });
    }
  };

  const remove = async (a) => {
    try {
      const res = await removeAtlas(a.id);
      toast.success(`${a.name} ${res.removed === "trashed" ? "moved to the recycle bin" : "deleted"}`,
        { description: formatBytes(res.bytesFreed) + " freed" });
      setPending(null);
      await sync();
    } catch (e) {
      toast.error(`Could not remove ${a.name}`, { description: e.message });
      setPending(null);
    }
  };

  const split = async (a) => {
    const t = toast.loading(`Splitting ${a.short} left/right…`);
    try {
      const res = await deriveLeftRight(a.id, {});
      toast.success(`${res.atlas.name} created`, { id: t });
      await sync();
    } catch (e) {
      toast.error("Split failed", { id: t, description: e.message });
    }
  };

  const rename = async (a) => {
    const name = draft.trim();
    setRenaming(null);
    if (!name || name === a.name) return;
    try {
      await patchAtlas(a.id, { name });
      await sync();
    } catch (e) {
      toast.error("Rename failed", { description: e.message });
    }
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4"
      onClick={closeManager} data-testid="atlas-manager">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col border border-border bg-panel"
        onClick={(e) => e.stopPropagation()}>

        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 text-[13px] text-foreground">
            <Layers size={14} /> Atlases
          </div>
          <button onClick={closeManager} className="text-muted-foreground hover:text-foreground"
            data-testid="atlas-manager-close" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="flex gap-1 border-b border-border px-3">
          {[["installed", `Installed (${atlases.length})`],
            ["catalog", `Catalog (${notInstalled.length})`],
            ["import", "Import your own"]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`border-b-2 px-2 py-1.5 text-[12px] transition-colors ${
                tab === key ? "border-b-accent text-foreground"
                            : "border-b-transparent text-muted-foreground hover:text-foreground"}`}
              data-testid={`atlas-tab-${key}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === "installed" && (
            <div className="space-y-1">
              {!atlases.length && (
                <p className="text-[12px] text-muted-foreground">
                  Nothing installed yet. Try the Catalog tab.
                </p>
              )}
              {atlases.map((a) => (
                <div key={a.id} className="border border-border p-2" data-testid={`atlas-manager-row-${a.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      {renaming === a.id ? (
                        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => rename(a)}
                          onKeyDown={(e) => { if (e.key === "Enter") rename(a); if (e.key === "Escape") setRenaming(null); }}
                          className="w-full border border-border bg-transparent px-1 py-0.5 text-[12px] text-foreground focus:outline-none"
                          data-testid={`atlas-rename-input-${a.id}`} />
                      ) : (
                        <button onClick={() => { setRenaming(a.id); setDraft(a.name); }}
                          className="truncate text-left text-[12px] text-foreground hover:underline"
                          title="Click to rename" data-testid={`atlas-rename-${a.id}`}>
                          {a.name}
                        </button>
                      )}
                      <div className="text-[11px] text-muted-foreground">
                        {a.kind} · {formatBytes(a.bytes)} · {a.origin?.kind}
                        {a.derivedFrom ? ` from ${a.derivedFrom}` : ""}
                        {a.lateralized === false ? " · bilateral labels" : ""}
                      </div>
                      {a.description && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{a.description}</div>
                      )}
                      {a.license?.attribution && (
                        <div className="mt-0.5 text-[10px] text-muted-foreground">{a.license.attribution}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {a.lateralized === false && (
                        <button onClick={() => split(a)} title="Create a left/right-split copy"
                          className="flex items-center gap-1 border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                          data-testid={`atlas-split-${a.id}`}>
                          <Scissors size={11} /> Split L/R
                        </button>
                      )}
                      <button onClick={() => setPending(pending === a.id ? null : a.id)}
                        title="Remove this atlas"
                        className="flex items-center gap-1 border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-destructive"
                        data-testid={`atlas-remove-${a.id}`}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                  {pending === a.id && (
                    <div className="mt-2 border border-border p-2 text-[11px]">
                      <p className="text-muted-foreground">
                        Remove <span className="text-foreground">{a.name}</span>? The folder goes to
                        the recycle bin where the system supports it, so this is recoverable.
                      </p>
                      <div className="mt-1 flex gap-2">
                        <button onClick={() => remove(a)}
                          className="border border-border px-2 py-0.5 text-destructive hover:bg-panel-hover"
                          data-testid={`atlas-remove-confirm-${a.id}`}>
                          Remove
                        </button>
                        <button onClick={() => setPending(null)} className="px-2 py-0.5 text-muted-foreground hover:text-foreground">
                          Keep
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === "catalog" && (
            <div className="space-y-1">
              <p className="mb-2 text-[11px] text-muted-foreground">
                Downloaded on demand from a pinned upstream commit, converted to
                MRLatte&rsquo;s format and named from the publisher&rsquo;s own label list.
              </p>
              {!notInstalled.length && (
                <p className="text-[12px] text-muted-foreground">Every catalog atlas is installed.</p>
              )}
              {notInstalled.map((c) => {
                const job = jobs[c.catalogId];
                return (
                  <div key={c.catalogId} className="border border-border p-2"
                    data-testid={`atlas-catalog-row-${c.catalogId}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[12px] text-foreground">{c.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {c.description} · {formatBytes(c.bytes)} · {c.space}
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {c.license?.attribution}
                        </div>
                      </div>
                      <button onClick={() => install(c)} disabled={!!job}
                        className="flex shrink-0 items-center gap-1 border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                        data-testid={`atlas-install-${c.catalogId}`}>
                        <Download size={11} /> {job ? job.stage : "Install"}
                      </button>
                    </div>
                    {job && (
                      <div className="mt-1 h-0.5 w-full bg-border">
                        <div className="h-full bg-accent transition-all"
                          style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === "import" && (
            <AtlasImportWizard onInstalled={sync} onClose={() => setTab("installed")} />
          )}
        </div>

        <div className="flex items-center gap-1 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          <Upload size={10} /> Atlases live under the module root and can be removed one at a time.
        </div>
      </div>
    </div>
  );
}

export default AtlasManager;
