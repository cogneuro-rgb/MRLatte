import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, HardDrive,
  Loader2, Package, RefreshCw, ShieldAlert, Trash2, Upload, Wrench, X, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useModules } from "@/hooks/use-modules";
import { useModuleJobs } from "@/hooks/use-module-jobs";
import {
  acceptsSideload, canPickFiles, cancelModuleJob, downloadSource, formatBytes,
  installModule, isInstallableType, isRedistributable, isSlotModule, jobIdOf,
  moduleFiles, moduleSha256, moduleSize, moduleStatus, pickSlotFile,
  provenanceReview, sideloadModule, slotExtensions, slotInstallModule,
  transferLabel, uninstallModule, upstreamSource, verifyModule,
} from "@/lib/modules";

/**
 * Module Store — the catalogue view for every entry in modules/manifest.json:
 * name, description, size, tier, installed state, and the per-module actions
 * (Sideload / Install / Uninstall / Repair / Verify) with live progress polled
 * from GET /api/modules/jobs/{job_id}.
 *
 * Three things here are load-bearing and easy to regress:
 *
 * 1. Installed state comes ONLY from GET /api/modules. Never probe an asset
 *    URL to find out whether a file is there — backend/server.py rewrites any
 *    non-/api 404 to index.html with status 200, so a missing atlas would
 *    "succeed". See lib/modules.js.
 * 2. It fails OPEN, exactly like ModuleGate. If /api/modules is unreachable we
 *    do not know what is installed, so nothing is rendered as "not installed";
 *    the store shows an explicit backend-unreachable state instead.
 * 3. Nothing here assumes an endpoint exists. The installer endpoints are
 *    additive; a 404/405 from /api/* is real (unlike a static 404) and is
 *    reported as "not available in the running backend", not as a failure of
 *    the install itself.
 */

const LABEL = "font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground";
const SUBTLE = "font-mono text-[9px] text-subtle leading-relaxed";
const BODY = "font-mono text-[10px] text-muted-foreground leading-relaxed";
const BTN =
  "flex items-center justify-center gap-1.5 px-2.5 py-1.5 font-mono text-[10px] uppercase " +
  "tracking-[0.15em] border border-border bg-transparent text-muted-foreground transition-colors " +
  "hover:text-foreground hover:border-muted-foreground " +
  "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground disabled:hover:border-border";

const STATUS_STYLE = {
  installed: "border-emerald-500/50 text-emerald-500",
  broken: "border-amber-500/60 text-amber-500",
  missing: "border-border text-muted-foreground",
};
const STATUS_LABEL = {
  installed: "installed",
  broken: "broken",
  missing: "not installed",
};

function StatusBadge({ status, verified }) {
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] ${STATUS_STYLE[status]}`}
      data-testid={`module-status-${status}`}
    >
      {status === "installed" && <CheckCircle2 size={9} />}
      {status === "broken" && <AlertTriangle size={9} />}
      {STATUS_LABEL[status]}
      {status === "installed" && !verified && <span className="text-subtle">· unverified</span>}
    </span>
  );
}

function Meta({ k, v }) {
  if (v === null || v === undefined || v === "") return null;
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={LABEL}>{k}</span>
      <span className="font-mono text-[10px] text-foreground">{v}</span>
    </span>
  );
}

function ProgressBar({ job }) {
  const pct = job.progress === null || job.progress === undefined
    ? null
    : Math.round(job.progress * 100);
  return (
    <div className="space-y-1" data-testid="module-progress">
      <div className="flex items-center justify-between">
        <span className={LABEL}>
          {job.stage || "working"}
          {job.message ? ` · ${job.message}` : ""}
        </span>
        <span className="font-mono text-[9px] text-foreground">{pct === null ? "…" : `${pct}%`}</span>
      </div>
      <div className="h-1.5 w-full border border-border bg-panel-hover overflow-hidden">
        <div
          className="h-full bg-fuchsia-500 transition-[width] duration-300 ease-out"
          style={{ width: pct === null ? "100%" : `${pct}%`, opacity: pct === null ? 0.35 : 1 }}
        />
      </div>
      {transferLabel(job.bytesDone, job.bytesTotal) && (
        <div className={SUBTLE}>{transferLabel(job.bytesDone, job.bytesTotal)}</div>
      )}
    </div>
  );
}

/**
 * Terminal-result detail: the per-file table POST /api/modules/{id}/verify
 * returns, or whatever an install/uninstall answered with. Neither shape is
 * pinned down by plans/phase-4.md, so every field is read defensively and a
 * payload we do not recognise is summarised rather than dropped.
 */
function VerifyResult({ result }) {
  const rows = Array.isArray(result?.files) ? result.files
    : Array.isArray(result?.results) ? result.results
    : Array.isArray(result) ? result : null;
  if (!rows) {
    // Uninstall answers { bytesFreed, bytesFreedHuman, removed, failed };
    // sideload answers { ok, installed: [paths] }.
    const freed = result?.bytesFreedHuman
      || (Number.isFinite(Number(result?.bytesFreed ?? result?.freed_bytes))
        ? formatBytes(result.bytesFreed ?? result.freed_bytes) : null);
    const parts = [];
    if (result?.message || result?.detail) parts.push(result.message || result.detail);
    if (freed) parts.push(`${freed} freed`);
    if (Array.isArray(result?.installed) && result.installed.length) {
      parts.push(`${result.installed.length} file${result.installed.length === 1 ? "" : "s"} installed`);
    }
    if (Array.isArray(result?.failed) && result.failed.length) {
      parts.push(`${result.failed.length} could not be removed`);
    }
    if (!parts.length && result && typeof result === "object" && Object.keys(result).length) {
      parts.push(JSON.stringify(result).slice(0, 240));
    }
    return parts.length
      ? <div className={SUBTLE} data-testid="module-verify-result">{parts.join(" · ")}</div>
      : null;
  }
  return (
    <div className="space-y-0.5" data-testid="module-verify-result">
      {rows.map((f, i) => {
        // Backend rows are { file, path, expected, actual, bytes, present, ok, note? }.
        const okFlag = f?.ok ?? f?.match ?? f?.verified ?? f?.valid;
        const name = f?.file || f?.path || f?.name || `file ${i + 1}`;
        const detail = okFlag
          ? (f?.note || "sha256 ok")
          : f?.present === false ? "missing" : (f?.error || f?.note || "sha256 mismatch");
        return (
          <div key={name} className="flex items-center gap-1.5 font-mono text-[9px]">
            {okFlag ? <CheckCircle2 size={9} className="shrink-0 text-emerald-500" />
              : <XCircle size={9} className="shrink-0 text-red-400" />}
            <span className="flex-1 min-w-0 truncate text-foreground" title={f?.path || name}>{name}</span>
            <span className={`shrink-0 ${okFlag ? "text-emerald-500" : "text-red-400"}`}>{detail}</span>
          </div>
        );
      })}
    </div>
  );
}

function LicenceBlock({ module: m }) {
  const lic = m.license || {};
  const review = provenanceReview(m);
  return (
    <div className="border border-border px-2.5 py-2 space-y-1.5" data-testid={`module-licence-${m.id}`}>
      <div className={LABEL}>licence</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Meta k="spdx" v={lic.spdx || "unstated"} />
        <Meta k="redistributable" v={isRedistributable(m) ? "yes" : "no"} />
      </div>
      {lic.attribution && <div className={BODY}>{lic.attribution}</div>}
      {review && (
        <div className="border border-amber-500/50 px-2 py-1.5 space-y-1" data-testid={`module-provenance-${m.id}`}>
          <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-amber-500">
            <ShieldAlert size={10} /> provenance review
          </div>
          <div className="font-mono text-[9px] text-amber-500/90 leading-relaxed">{review}</div>
        </div>
      )}
    </div>
  );
}

function Details({ module: m }) {
  const files = moduleFiles(m);
  const sha = moduleSha256(m);
  return (
    <div className="space-y-2 border-t border-border px-3 py-2.5">
      {(m.unlocks || []).length > 0 && (
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className={LABEL}>unlocks</span>
          {m.unlocks.map((c) => (
            <span key={c} className="border border-border px-1.5 py-0.5 font-mono text-[9px] text-foreground">{c}</span>
          ))}
        </div>
      )}
      {m.path && (
        <div className="space-y-0.5">
          <div className={LABEL}>resolves to</div>
          <div className="font-mono text-[9px] text-foreground break-all">{m.path}</div>
        </div>
      )}
      {(Array.isArray(m.missing) && m.missing.length > 0) && (
        <div className="space-y-0.5">
          <div className={LABEL}>missing</div>
          <div className="font-mono text-[9px] text-amber-500 break-all">{m.missing.join(" · ")}</div>
        </div>
      )}

      {/* Two manifest shapes: multi-file modules carry `files` and a null
          module-level sha256; single-file modules carry the sha256 itself. */}
      {files.length > 0 ? (
        <div className="space-y-0.5">
          <div className={LABEL}>{files.length} file{files.length === 1 ? "" : "s"}</div>
          <div className="border border-border divide-y divide-border">
            {files.map((f) => (
              <div key={f.path} className="flex items-baseline gap-2 px-2 py-1">
                <span className="flex-1 min-w-0 truncate font-mono text-[9px] text-foreground">{f.path}</span>
                <span className="font-mono text-[9px] text-muted-foreground whitespace-nowrap">{formatBytes(f.bytes)}</span>
                <span className="font-mono text-[9px] text-subtle whitespace-nowrap" title={f.sha256 || "no hash recorded"}>
                  {f.sha256 ? `${f.sha256.slice(0, 10)}…` : "no hash"}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : sha ? (
        <div className="space-y-0.5">
          <div className={LABEL}>sha256 (single file)</div>
          <div className="font-mono text-[9px] text-foreground break-all">{sha}</div>
        </div>
      ) : (m.type || "data") === "data" ? (
        // /api/modules does not currently echo the manifest's `files` array or
        // module-level sha256, so there is nothing to list here. Verify returns
        // the per-file answer on demand, which is the honest fallback.
        <div className={SUBTLE}>
          Per-file hashes are not reported by /api/modules — run Verify for a
          streamed SHA-256 of every file.
        </div>
      ) : null}

      <LicenceBlock module={m} />

      {(m.sources || []).length > 0 && (
        <div className="space-y-0.5">
          <div className={LABEL}>sources</div>
          {m.sources.map((s, i) => (
            <div key={`${s.type}-${i}`} className="font-mono text-[9px] text-subtle break-all">
              {s.type}
              {s.asset ? ` · ${s.asset}` : ""}
              {s.tag ? ` · ${s.tag}` : ""}
              {s.url ? ` · ${s.url}` : ""}
              {s.packages ? ` · ${s.packages.join(", ")}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModuleRow({ module: m, job, freeBytes, focused, onInstall, onSideload, onSlotInstall, onUninstall, onVerify, onCancel, onDismiss }) {
  const rowRef = useRef(null);
  const fileRef = useRef(null);
  const [open, setOpen] = useState(!!focused);
  const [confirmLicence, setConfirmLicence] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);

  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    rowRef.current?.scrollIntoView({ block: "center" });
  }, [focused]);

  // Backend flags win where present (it knows whether a release base is
  // configured, and whether the module resolves inside the module root); the
  // manifest-derived fallbacks keep the store usable against a backend that
  // predates them.
  const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);

  const status = moduleStatus(m);
  const supported = m.notInstallableReason ? false : isInstallableType(m);
  const redistributable = isRedistributable(m);
  const dl = downloadSource(m);
  const upstream = upstreamSource(m);
  const sideloadable = bool(m.sideloadable, supported && acceptsSideload(m));
  // A download needs BOTH a fetchable source and the right to serve it. Every
  // non-redistributable module in the manifest deliberately omits its
  // github-release source, so this is belt-and-braces.
  const downloadable = bool(m.downloadable, supported && redistributable && !!dl);
  const uninstallable = bool(m.uninstallable, status !== "missing");
  // Distinguishes "licence forbids hosting it" from "nothing is hosted yet".
  const noReleaseConfigured = supported && !downloadable && m.sideloadOnly === false;
  // Multi-file modules must be sideloaded as a .zip (the backend rejects a
  // bare file for them). `files` is not in the API payload today, so fall back
  // to the reported missing-file list.
  const multiFile = moduleFiles(m).length > 1
    || (Array.isArray(m.missing) && m.missing.length > 1);
  const busy = !!job && !job.done;
  const cancellable = busy && (!!job.jobId || job.phase === "sideload");
  const tooBig = freeBytes !== null && freeBytes !== undefined && m.bytes > freeBytes;
  // Slots are chosen by path. Without a native picker (browser build) there is
  // no path to send, so those builds fall back to the upload path.
  const isSlot = isSlotModule(m);
  const slotInstallable = bool(m.slotInstallable, isSlot) && canPickFiles();

  const pickFile = () => fileRef.current?.click();

  return (
    <div
      ref={rowRef}
      className={`border ${focused ? "border-muted-foreground" : "border-border"}`}
      data-testid={`module-row-${m.id}`}
    >
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-0.5 text-muted-foreground hover:text-foreground transition-colors"
            title={open ? "Hide details" : "Show details"}
            data-testid={`module-details-${m.id}`}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[11px] text-foreground leading-snug">{m.name}</div>
            <div className={`${SUBTLE} mt-0.5`}>{m.id}</div>
          </div>
          <StatusBadge status={status} verified={m.verified} />
        </div>

        {m.description && <div className={BODY}>{m.description}</div>}

        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Meta k="size" v={moduleSize(m)} />
          <Meta k="tier" v={m.tier} />
          <Meta k="type" v={m.type} />
          <Meta k="version" v={m.version} />
        </div>

        {/* --- Actions ------------------------------------------------------ */}
        {!supported ? (
          <div className="border border-border px-2.5 py-2 space-y-1" data-testid={`module-unsupported-${m.id}`}>
            <div className={LABEL}>not installable yet</div>
            <div className={SUBTLE}>
              {m.notInstallableReason
                || (m.type === "python-package"
                  ? "Python-package modules install via pip and are out of scope for this phase. Install the requirements file listed under sources by hand."
                  : `Modules of type "${m.type}" have no installer.`)}
            </div>
          </div>
        ) : busy ? (
          <div className="space-y-2">
            <ProgressBar job={job} />
            {cancellable && (
              <button type="button" onClick={() => onCancel(m)} className={`${BTN} w-full`} data-testid={`module-store-cancel-${m.id}`}>
                <X size={11} /> Cancel
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {/* Non-redistributable: no download button can ever work here, so
                say why and point at the upstream the user must obtain it from.
                Licence text is shown up-front, not behind a click. */}
            {!redistributable && (
              <div className="border border-amber-500/40 px-2.5 py-2 space-y-1.5" data-testid={`module-nonredist-${m.id}`}>
                <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-amber-500">
                  <AlertTriangle size={10} /> sideload only
                </div>
                <div className={BODY}>
                  {m.license?.spdx ? `${m.license.spdx} — ` : ""}
                  this module is not redistributable, so MRLatte cannot download it for you.
                  Obtain it yourself under its terms, then sideload the file below.
                </div>
                {m.license?.attribution && <div className={SUBTLE}>{m.license.attribution}</div>}
                {provenanceReview(m) && (
                  <div className="border border-amber-500/50 px-2 py-1.5 space-y-1">
                    <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-amber-500">
                      <ShieldAlert size={10} /> provenance review
                    </div>
                    <div className="font-mono text-[9px] text-amber-500/90 leading-relaxed">{provenanceReview(m)}</div>
                  </div>
                )}
                {upstream?.url && (
                  <div className="font-mono text-[9px] text-subtle break-all">obtain from: {upstream.url}</div>
                )}
                <label className="flex items-start gap-2 font-mono text-[9px] text-muted-foreground leading-relaxed cursor-pointer">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                    className="mt-0.5"
                    data-testid={`module-terms-${m.id}`}
                  />
                  I obtained this data from its source and accept the terms above.
                </label>
              </div>
            )}

            {/* Redistributable download: licence text before the transfer. */}
            {confirmLicence && downloadable && (
              <div className="border border-border px-2.5 py-2 space-y-2" data-testid={`module-confirm-${m.id}`}>
                <div className={LABEL}>before downloading</div>
                <div className={BODY}>
                  {moduleSize(m)} will be downloaded from{" "}
                  {dl?.type === "github-release" ? `the ${dl.tag || "release"} assets`
                    : dl?.url || "the backend's configured release source"}
                  {" "}and installed under the module root, then SHA-256 verified before use.
                </div>
                <LicenceBlock module={m} />
                {tooBig && (
                  <div className="font-mono text-[9px] text-red-400 leading-relaxed">
                    Not enough free space: {moduleSize(m)} needed, {formatBytes(freeBytes)} free.
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={tooBig}
                    onClick={() => { setConfirmLicence(false); onInstall(m, { repair: status === "broken" }); }}
                    className={BTN}
                    data-testid={`module-store-confirm-install-${m.id}`}
                  >
                    <Download size={11} /> Accept &amp; install
                  </button>
                  <button type="button" onClick={() => setConfirmLicence(false)} className={BTN}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {confirmUninstall && (
              <div className="border border-red-500/40 px-2.5 py-2 space-y-2" data-testid={`module-confirm-uninstall-${m.id}`}>
                <div className={BODY}>
                  {isSlot && m.slotMode === "link"
                    // Nothing is deleted here, and saying "delete" would be a lie
                    // about the user's own file sitting outside the module root.
                    ? `Stop using ${m.slotPath || "this file"}? It stays exactly where it is — only MRLatte's registration is removed. The features it unlocks re-gate immediately.`
                    : isSlot
                      ? `Remove the file from ${m.slot?.directory || "the slot"}/ under the module root? It goes to the recycle bin where the system supports it, otherwise it is deleted outright. The features it unlocks re-gate immediately.`
                      : <>Delete this module&apos;s files and free {moduleSize(m)}? It goes to the recycle bin
                        where the system supports it, otherwise it is deleted outright. Any feature it unlocks
                        re-gates immediately. A module resolving through a dev-checkout path is refused by the
                        backend rather than deleted.</>}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => { setConfirmUninstall(false); onUninstall(m); }}
                    className={`${BTN} border-red-500/50 text-red-400 hover:text-red-300 hover:border-red-400`}
                    data-testid={`module-store-confirm-uninstall-${m.id}`}
                  >
                    <Trash2 size={11} /> Confirm uninstall
                  </button>
                  <button type="button" onClick={() => setConfirmUninstall(false)} className={BTN}>
                    Keep
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {/* A broken module gets Repair instead of Install — same
                  endpoint, but the label has to say what it will do. */}
              {status === "missing" && downloadable && !confirmLicence && (
                <button
                  type="button"
                  onClick={() => setConfirmLicence(true)}
                  className={`${BTN} flex-1`}
                  data-testid={`module-store-install-${m.id}`}
                >
                  <Download size={11} /> Install ({moduleSize(m)})
                </button>
              )}

              {status === "broken" && downloadable && !confirmLicence && (
                <button
                  type="button"
                  onClick={() => onInstall(m, { repair: true })}
                  className={`${BTN} flex-1 border-amber-500/50 text-amber-500 hover:text-amber-400 hover:border-amber-400`}
                  data-testid={`module-store-repair-${m.id}`}
                >
                  <Wrench size={11} /> Repair
                </button>
              )}

              {/* Slot: choose a file by path. `Copy` duplicates it into the
                  slot directory; `Use in place` registers it where it already
                  is, which for a 673 MB tractogram is the difference between a
                  long copy and none at all. */}
              {slotInstallable && (
                <>
                  <button
                    type="button"
                    onClick={() => onSlotInstall(m, "copy")}
                    disabled={!termsAccepted && !redistributable}
                    title={!termsAccepted && !redistributable
                      ? "Accept the licence terms above first."
                      : `Copy the file into ${m.slot?.directory || "the slot"}/ under the module root.`}
                    className={`${BTN} flex-1`}
                    data-testid={`module-store-slot-copy-${m.id}`}
                  >
                    <Download size={11} /> {status === "installed" ? "Replace (copy)" : "Choose file (copy)"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSlotInstall(m, "link")}
                    disabled={!termsAccepted && !redistributable}
                    title={!termsAccepted && !redistributable
                      ? "Accept the licence terms above first."
                      : "Leave the file where it is and just point MRLatte at it. Moving or deleting it later will disable this feature."}
                    className={`${BTN} flex-1`}
                    data-testid={`module-store-slot-link-${m.id}`}
                  >
                    <HardDrive size={11} /> {status === "installed" ? "Replace (in place)" : "Use in place"}
                  </button>
                </>
              )}

              {sideloadable && (
                <button
                  type="button"
                  onClick={pickFile}
                  disabled={!redistributable && !termsAccepted}
                  title={!redistributable && !termsAccepted
                    ? "Accept the licence terms above first."
                    : status === "installed"
                      ? "Replace the installed files with a copy you supply."
                      : multiFile
                        ? "Upload a .zip containing this module's files."
                        : "Upload the module file, or a .zip containing it."}
                  className={`${BTN} flex-1`}
                  data-testid={`module-store-sideload-${m.id}`}
                >
                  <Upload size={11} />{" "}
                  {status === "broken" ? "Repair by sideload"
                    : status === "installed" ? "Replace" : "Sideload"}
                </button>
              )}

              {/* Slots carry no hash — they are validated structurally on every
                  read — so /verify has nothing to check and answers 409. */}
              {status !== "missing" && !isSlot && (
                <button type="button" onClick={() => onVerify(m)} className={BTN} data-testid={`module-store-verify-${m.id}`}>
                  <ShieldAlert size={11} /> Verify
                </button>
              )}

              {status !== "missing" && !confirmUninstall && (
                <button
                  type="button"
                  onClick={() => setConfirmUninstall(true)}
                  disabled={!uninstallable}
                  title={uninstallable
                    ? "Delete this module's files"
                    : "MRLatte did not install this — it is either part of your checkout or outside the module root — so uninstall refuses to delete it."}
                  className={BTN}
                  data-testid={`module-store-uninstall-${m.id}`}
                >
                  <Trash2 size={11} /> Uninstall
                </button>
              )}
            </div>

            {noReleaseConfigured && status !== "installed" && (
              <div className={SUBTLE} data-testid={`module-norelease-${m.id}`}>
                This module may be redistributed, but the running backend has no download
                source configured yet — sideload it in the meantime.
              </div>
            )}
            {status === "installed" && !uninstallable && (
              <div className={SUBTLE}>
                {isSlot
                  // A hand-dropped file in the slot directory IS removable now.
                  // The only slot that is not is one behind an env override,
                  // which points at storage this app does not manage.
                  ? `Resolves through the ${m.envVar || "per-asset"} environment override, which points at storage MRLatte does not manage — it will not be deleted from here. Unset that variable to manage this slot from the app.`
                  : "This ships as part of your checkout (no install-ledger entry) or resolves outside the module root — either way it isn't uninstallable from here. If it's the former, hitting Verify re-hashes the files already on disk and registers them, no download needed."}
              </div>
            )}

            {/* Shown for the installed state too: that is exactly when a
                Replace button most needs to say what it does. */}
            {sideloadable && (
              <div className={SUBTLE}>
                {status === "installed"
                  ? "Already installed. Sideloading again replaces the current files — useful to move to a different build, or to fix a file that is corrupt but still the right size."
                  : multiFile
                    ? "Sideload expects a .zip containing this module's files; every member is checked against the module root and SHA-256 verified before anything is promoted."
                    : "Sideload expects the module file itself (or a .zip containing it); it is SHA-256 verified before being promoted."}
              </div>
            )}

            {slotInstallable && (
              <div className={SUBTLE} data-testid={`module-slot-hint-${m.id}`}>
                {`Accepts ${slotExtensions(m).join(", ") || "a conforming file"}. It is validated before anything moves, so a wrong file is rejected immediately. `}
                {m.slotMode === "link" && m.slotPath
                  ? `Currently used in place from ${m.slotPath} — MRLatte does not own this file and will not delete it.`
                  : m.slotMode === "copy"
                    ? "Currently a copy under the module root, so uninstall can remove it."
                    : `You can also drop a file straight into ${m.slot?.directory || "the slot"}/ — it is picked up without a restart.`}
              </div>
            )}

            {isSlot && !canPickFiles() && (
              <div className={SUBTLE} data-testid={`module-slot-nopicker-${m.id}`}>
                {`Choosing a file by path needs the desktop app. In the browser, drop a conforming file into ${m.slot?.directory || "the slot"}/ under the module root instead.`}
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              className="hidden"
              data-testid={`module-store-file-${m.id}`}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) onSideload(m, f);
              }}
            />
          </div>
        )}

        {/* Terminal job outcome, kept until dismissed. */}
        {job?.done && (
          <div
            className={`border px-2.5 py-2 space-y-1 ${job.error ? "border-red-500/50" : "border-emerald-500/40"}`}
            data-testid={`module-outcome-${m.id}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className={`font-mono text-[9px] uppercase tracking-[0.25em] ${job.error ? "text-red-400" : "text-emerald-500"}`}>
                {job.error ? (job.endpointMissing ? "not available yet" : "failed")
                  : job.cancelled ? "cancelled" : `${job.phase || "job"} complete`}
              </div>
              <button type="button" onClick={() => onDismiss(m)} className="text-muted-foreground hover:text-foreground">
                <X size={11} />
              </button>
            </div>
            {job.error && <div className="font-mono text-[9px] text-red-400 leading-relaxed break-words">{job.error}</div>}
            {job.result && <VerifyResult result={job.result} />}
          </div>
        )}
      </div>

      {open && <Details module={m} />}
    </div>
  );
}

export function ModuleStore() {
  const {
    loading, ok, reason, modules, installable, moduleRoot, freeBytes,
    refresh, storeOpen, storeFocus, closeStore,
  } = useModules();

  const { jobs, setJob, clearJob } = useModuleJobs({
    onSettled: (mid, job) => {
      if (job.error) toast.error("Module job failed", { description: job.error });
      else if (job.cancelled) toast("Module job cancelled");
      else toast.success("Module updated");
      refresh();
    },
  });

  // Aborts for in-flight sideload uploads (an upload is a live XHR, not a
  // backend job, so /cancel cannot stop it).
  const uploadsRef = useRef({});

  useEffect(() => {
    if (!storeOpen) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closeStore(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [storeOpen, closeStore]);

  // Re-read /api/modules whenever the store is opened: it is the only source of
  // truth for installed state and may have changed since startup.
  useEffect(() => { if (storeOpen) refresh(); }, [storeOpen, refresh]);

  const finish = useCallback((mid, res, phase) => {
    // Shared tail for every action: a job id means poll, a plain 2xx means the
    // backend did the work synchronously.
    if (!res.ok) {
      const err = res.unreachable
        ? `backend unreachable — ${res.error}`
        : res.missing
          ? `${res.error} — this endpoint is not available in the running backend yet`
          : res.error;
      setJob(mid, { phase, done: true, error: err, endpointMissing: !!res.missing });
      toast.error(`${phase} failed`, { description: err });
      return;
    }
    const jobId = jobIdOf(res.data);
    if (jobId) {
      setJob(mid, { phase, jobId, done: false, stage: "queued", progress: null });
      return;
    }
    // Synchronous endpoint. A 200 does NOT mean success: /verify answers
    // { ok: false, corrupt, missing } for a bad file, and /uninstall answers
    // { ok: false, failed } when a file could not be removed.
    const data = res.data || {};
    if (data.ok === false) {
      const bad = [...(data.corrupt || []), ...(data.missing || []),
        ...(data.failed || []).map((f) => f?.file || f?.error || "")].filter(Boolean);
      const err = bad.length ? `${phase} reported problems: ${bad.join(", ")}` : `${phase} failed`;
      setJob(mid, { phase, done: true, error: err, stage: "error", progress: 1, result: data });
      toast.error(`${phase} failed`, { description: err });
      refresh();
      return;
    }
    setJob(mid, { phase, done: true, error: null, stage: "done", progress: 1, result: data });
    toast.success(`${phase} complete`, { description: mid });
    refresh();
  }, [setJob, refresh]);

  const onInstall = useCallback(async (m, { repair } = {}) => {
    const phase = repair ? "repair" : "install";
    setJob(m.id, { phase, done: false, stage: "starting", progress: null, jobId: null, error: null, result: null });
    finish(m.id, await installModule(m.id, { repair: !!repair }), phase);
  }, [setJob, finish]);

  const onSideload = useCallback(async (m, file) => {
    const controller = new AbortController();
    uploadsRef.current[m.id] = controller;
    setJob(m.id, {
      phase: "sideload", done: false, stage: "uploading", jobId: null,
      progress: 0, bytesDone: 0, bytesTotal: file.size, error: null, result: null,
    });
    const res = await sideloadModule(m.id, file, {
      signal: controller.signal,
      onProgress: (loaded, total) => setJob(m.id, {
        stage: "uploading", bytesDone: loaded, bytesTotal: total, progress: total ? loaded / total : null,
      }),
    });
    delete uploadsRef.current[m.id];
    if (res.aborted) {
      setJob(m.id, { done: true, cancelled: true, stage: "cancelled", error: null });
      return;
    }
    finish(m.id, res, "sideload");
  }, [setJob, finish]);

  // Slot install: a native picker gives a PATH, and the backend copies or
  // registers it. No upload, so there is no progress to report — a copy of a
  // 673 MB file is a local filesystem operation, and `link` moves nothing.
  const onSlotInstall = useCallback(async (m, mode) => {
    const path = await pickSlotFile(m);
    if (!path) return;                       // cancelled, or no native picker
    const phase = mode === "link" ? "register" : "copy";
    setJob(m.id, { phase, done: false, stage: mode === "link" ? "registering" : "copying",
      progress: null, jobId: null, error: null, result: null });
    finish(m.id, await slotInstallModule(m.id, path, mode), phase);
  }, [setJob, finish]);

  const onVerify = useCallback(async (m) => {
    setJob(m.id, { phase: "verify", done: false, stage: "hashing", progress: null, jobId: null, error: null, result: null });
    finish(m.id, await verifyModule(m.id), "verify");
  }, [setJob, finish]);

  const onUninstall = useCallback(async (m) => {
    setJob(m.id, { phase: "uninstall", done: false, stage: "removing", progress: null, jobId: null, error: null, result: null });
    finish(m.id, await uninstallModule(m.id), "uninstall");
  }, [setJob, finish]);

  const onCancel = useCallback(async (m) => {
    // An upload is a live XHR in this browser, not a backend job — abort it
    // locally. Only a download job has something for /cancel to stop.
    const upload = uploadsRef.current[m.id];
    if (upload) { upload.abort(); return; }
    const res = await cancelModuleJob(m.id, jobs[m.id]?.jobId);
    if (!res.ok) {
      toast.error("Cancel failed", { description: res.error });
      return;
    }
    // The job keeps polling until the worker writes stage="cancelled"; the
    // backend keeps the .part so a later install resumes.
  }, [jobs]);

  // Core-tier first (a missing core module breaks the viewer itself), manifest
  // order within a tier.
  const ordered = useMemo(
    () => [...modules].sort((a, b) => (a.tier === "core" ? 0 : 1) - (b.tier === "core" ? 0 : 1)),
    [modules],
  );

  const counts = useMemo(() => {
    const c = { installed: 0, broken: 0, missing: 0 };
    modules.forEach((m) => { c[moduleStatus(m)] += 1; });
    return c;
  }, [modules]);

  if (!storeOpen) return null;

  const unreachable = !loading && ok !== true;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 py-10 overflow-y-auto"
      onClick={closeStore}
      data-testid="module-store"
    >
      <div
        className="w-[760px] max-w-[94vw] border border-border bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Package size={14} className="text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-foreground leading-none">Module store</div>
            <div className={`${SUBTLE} mt-1 break-all`}>
              {moduleRoot ? `module root · ${moduleRoot}` : "optional and core assets"}
            </div>
          </div>
          {freeBytes !== null && freeBytes !== undefined && (
            <div className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground">
              <HardDrive size={11} /> {formatBytes(freeBytes)} free
            </div>
          )}
          <button
            type="button"
            onClick={refresh}
            className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            title="Re-read /api/modules"
            data-testid="module-store-refresh"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
          <button
            type="button"
            onClick={closeStore}
            className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            data-testid="module-store-close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="max-h-[72vh] overflow-y-auto thin-scroll px-4 py-3 space-y-2.5">
          {loading && (
            <div className={BODY} data-testid="module-store-loading">Reading /api/modules…</div>
          )}

          {/* Fail open. With no answer from /api/modules we cannot know what is
              installed — listing everything as "not installed" would make a
              perfectly good install look broken. */}
          {unreachable && (
            <div className="border border-amber-500/50 px-3 py-2.5 space-y-1.5" data-testid="module-store-unreachable">
              <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-amber-500">
                <AlertTriangle size={10} /> backend unreachable
              </div>
              <div className={BODY}>
                Module state is unknown — nothing below is being reported as missing.
                Start the MRLatte backend and refresh.
              </div>
              {reason && <div className={SUBTLE}>{reason}</div>}
            </div>
          )}

          {!loading && ok === true && (
            <>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pb-1">
                <Meta k="modules" v={modules.length} />
                <Meta k="installed" v={counts.installed} />
                {counts.broken > 0 && <Meta k="broken" v={counts.broken} />}
                <Meta k="not installed" v={counts.missing} />
              </div>

              {!installable && (
                <div className="border border-border px-3 py-2 space-y-1" data-testid="module-store-installer-off">
                  <div className={LABEL}>installer not reported</div>
                  <div className={SUBTLE}>
                    The running backend reports <span className="text-foreground">installable: false</span>.
                    Install, sideload, repair and uninstall are still offered here; if the endpoints are
                    absent they answer 404 and each action says so instead of failing silently.
                  </div>
                </div>
              )}

              {ordered.map((m) => (
                <ModuleRow
                  key={m.id}
                  module={m}
                  job={jobs[m.id]}
                  freeBytes={freeBytes}
                  focused={storeFocus === m.id}
                  onInstall={onInstall}
                  onSideload={onSideload}
                  onSlotInstall={onSlotInstall}
                  onVerify={onVerify}
                  onUninstall={onUninstall}
                  onCancel={onCancel}
                  onDismiss={(mod) => clearJob(mod.id)}
                />
              ))}

              {ordered.length === 0 && (
                <div className={BODY}>The manifest lists no modules.</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ModuleStore;
