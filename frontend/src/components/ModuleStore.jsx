import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, HardDrive,
  Layers, Loader2, Package, RefreshCw, ShieldAlert, Trash2, Upload, Wrench, X, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useModules } from "@/hooks/use-modules";
import { useAtlasManager } from "@/hooks/use-atlases";
import { useModuleJobs } from "@/hooks/use-module-jobs";
import { undoToastOptions } from "@/lib/undoToast";
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

const LABEL = "text-[12px] font-medium text-muted-foreground";
const SUBTLE = "text-[12px] text-muted-foreground leading-snug";
const BODY = "text-[12px] text-muted-foreground leading-snug";
const BTN =
  "btn inline-flex items-center justify-center gap-1.5 px-2.5 " +
  "text-foreground transition-colors hover:bg-panel-hover " +
  "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent";
const PRIMARY =
  "inline-flex items-center justify-center gap-1.5 px-3 py-1 text-[12px] font-medium bg-foreground text-background " +
  "transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed";

function Meta({ k, v }) {
  if (v === null || v === undefined || v === "") return null;
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={LABEL}>{k}</span>
      <span className="font-mono text-[11px] text-foreground">{v}</span>
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
        <span className="font-mono text-[10.5px] text-foreground">{pct === null ? "…" : `${pct}%`}</span>
      </div>
      <div className="h-1.5 w-full border border-border bg-panel-hover overflow-hidden rounded-sm">
        <div
          className="h-full bg-foreground transition-[width] duration-300 ease-out"
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
          <div key={name} className="flex items-center gap-1.5 font-mono text-[10.5px]">
            {okFlag ? <CheckCircle2 size={9} className="shrink-0 text-ok" />
              : <XCircle size={9} className="shrink-0 text-destructive" />}
            <span className="flex-1 min-w-0 truncate text-foreground" title={f?.path || name}>{name}</span>
            <span className={`shrink-0 ${okFlag ? "text-ok" : "text-destructive"}`}>{detail}</span>
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
    <div className="space-y-1" data-testid={`module-licence-${m.id}`}>
      <div className={BODY}>
        Licence: <span className="text-foreground">{lic.spdx || "not stated"}</span>
        {isRedistributable(m) ? ", free to redistribute." : ", not redistributable."}
        {lic.attribution ? ` ${lic.attribution}` : ""}
      </div>
      {review && (
        <div className="flex items-start gap-1.5 text-[12px] text-warn/90 leading-snug" data-testid={`module-provenance-${m.id}`}>
          <ShieldAlert size={11} className="mt-0.5 shrink-0" /> {review}
        </div>
      )}
    </div>
  );
}

function Details({ module: m }) {
  const files = moduleFiles(m);
  const sha = moduleSha256(m);
  return (
    <div className="space-y-2">
      {(m.unlocks || []).length > 0 && (
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className={LABEL}>unlocks</span>
          {m.unlocks.map((c) => (
            <span key={c} className="border border-border px-1.5 py-0.5 font-mono text-[10.5px] text-foreground">{c}</span>
          ))}
        </div>
      )}
      {m.path && (
        <div className="space-y-0.5">
          <div className={LABEL}>resolves to</div>
          <div className="font-mono text-[10.5px] text-foreground break-all">{m.path}</div>
        </div>
      )}
      {(Array.isArray(m.missing) && m.missing.length > 0) && (
        <div className="space-y-0.5">
          <div className={LABEL}>missing</div>
          <div className="font-mono text-[10.5px] text-warn break-all">{m.missing.join(" · ")}</div>
        </div>
      )}

      {/* Two manifest shapes: multi-file modules carry `files` and a null
          module-level sha256; single-file modules carry the sha256 itself. */}
      {files.length > 0 ? (
        <div className="space-y-0.5">
          <div className={LABEL}>{files.length} file{files.length === 1 ? "" : "s"}</div>
          <div className="border border-border divide-y divide-border rounded-lg">
            {files.map((f) => (
              <div key={f.path} className="flex items-baseline gap-2 px-2 py-1">
                <span className="flex-1 min-w-0 truncate font-mono text-[10.5px] text-foreground">{f.path}</span>
                <span className="font-mono text-[10.5px] text-muted-foreground whitespace-nowrap">{formatBytes(f.bytes)}</span>
                <span className="font-mono text-[10.5px] text-subtle whitespace-nowrap" title={f.sha256 || "no hash recorded"}>
                  {f.sha256 ? `${f.sha256.slice(0, 10)}…` : "no hash"}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : sha ? (
        <div className="space-y-0.5">
          <div className={LABEL}>sha256 (single file)</div>
          <div className="font-mono text-[10.5px] text-foreground break-all">{sha}</div>
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
            <div key={`${s.type}-${i}`} className="font-mono text-[10.5px] text-subtle break-all">
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

function firstSentence(text) {
  if (!text) return "";
  const m = String(text).match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : String(text);
}

function StatusDot({ status, verified }) {
  const cls = status === "installed" ? "bg-ok" : status === "broken" ? "bg-warn" : "bg-transparent border border-muted-foreground";
  const label = status === "installed" ? (verified ? "Installed" : "Installed (not verified)") : status === "broken" ? "Needs repair" : "Not installed";
  return (
    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${cls}`} title={label} data-testid={`module-status-${status}`}>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * One module: a compact line (status, name, one-line summary, size, the one
 * action that matters now) that expands to everything else — confirmations,
 * licence, file choices, Verify / Uninstall, and the technical details.
 * The Atlas Manager renders its template and atlases with it too: `removeNote`
 * says what stops working without the module, `children` adds atlas tools.
 */
export function ModuleRow({ module: m, job, freeBytes, focused, onInstall, onSideload, onSlotInstall, onUninstall, onVerify, onCancel, onDismiss, removeNote, children }) {
  const rowRef = useRef(null);
  const fileRef = useRef(null);
  const [open, setOpen] = useState(!!focused);
  const [showTech, setShowTech] = useState(false);
  const [confirmLicence, setConfirmLicence] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Opened at this module (a section's install prompt): glide to it and light
  // it briefly, so the eye lands on the right row.
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!focused) return undefined;
    setOpen(true);
    rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1800);
    return () => clearTimeout(t);
  }, [focused]);

  // A finished action's line clears itself after a few seconds (its toast
  // said it too). Errors and Verify's file table stay until dismissed.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!job?.done || job.error || job.phase === "verify") return undefined;
    const t = setTimeout(() => dismissRef.current(m), 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.done, job?.error, job?.phase]);

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
  const expandFor = (fn) => () => { setOpen(true); fn?.(); };

  // The one action shown on the collapsed line. Installed rows need none: the
  // group heading already says so.
  let primary = null;
  if (m.pendingRemoval && !busy) {
    primary = <span className="text-[12px] text-warn">Removed at next start</span>;
  } else if (busy || status === "installed" || confirmLicence) {
    primary = null;
  } else if (!supported) {
    primary = <span className="text-[12px] text-muted-foreground">Manual install</span>;
  } else if (status === "broken" && downloadable) {
    primary = (
      <button type="button" onClick={() => onInstall(m, { repair: true })} className={`${PRIMARY} bg-warn text-black`} data-testid={`module-store-repair-${m.id}`}>
        <Wrench size={11} /> Repair
      </button>
    );
  } else if (status === "missing" && downloadable) {
    primary = (
      <button type="button" onClick={expandFor(() => setConfirmLicence(true))} className={PRIMARY} data-testid={`module-store-install-${m.id}`}>
        <Download size={11} /> Install
      </button>
    );
  } else if (status !== "installed" && (slotInstallable || sideloadable)) {
    primary = (
      <button type="button" onClick={expandFor()} className={BTN} data-testid={`module-store-add-${m.id}`}>
        <Upload size={11} /> Add file…
      </button>
    );
  }

  return (
    <div ref={rowRef} className={flash ? "module-flash" : ""} data-testid={`module-row-${m.id}`}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <StatusDot status={status} verified={m.verified} />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 text-left"
          title={open ? "Hide details" : "Show details"}
          data-testid={`module-details-${m.id}`}
        >
          <div className="text-[13px] font-medium text-foreground leading-snug truncate">{m.name}</div>
          {m.description && !open && <div className="text-[12px] text-muted-foreground leading-snug truncate">{firstSentence(m.description)}</div>}
        </button>
        {m.bytes > 0 && <span className="mt-0.5 shrink-0 text-[12px] text-muted-foreground tabular-nums">{moduleSize(m)}</span>}
        <div className="shrink-0">{primary}</div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          aria-label={open ? "Hide details" : "Show details"}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>

      {busy && (
        <div className="px-3 pb-2.5 pl-8 space-y-1.5">
          <ProgressBar job={job} />
          {cancellable && (
            <button type="button" onClick={() => onCancel(m)} className={BTN} data-testid={`module-store-cancel-${m.id}`}>
              <X size={11} /> Cancel
            </button>
          )}
        </div>
      )}

      {/* Terminal job outcome, kept until dismissed. */}
      {job?.done && (
        <div className="px-3 pb-2.5 pl-8" data-testid={`module-outcome-${m.id}`}>
          <div className={`flex items-start gap-2 text-[12px] ${job.error ? "text-destructive" : "text-ok"}`}>
            {job.error ? <XCircle size={12} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={12} className="mt-0.5 shrink-0" />}
            <div className="flex-1 min-w-0 space-y-0.5">
              <div>
                {job.error ? (job.endpointMissing ? "Not available in this version yet" : `${job.phase || "Action"} failed`)
                  : job.cancelled ? "Cancelled" : `${(job.phase || "job").replace(/^./, (c) => c.toUpperCase())} complete`}
              </div>
              {job.error && <div className="text-muted-foreground break-words">{job.error}</div>}
              {job.result && <VerifyResult result={job.result} />}
            </div>
            <button type="button" onClick={() => onDismiss(m)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
              <X size={11} />
            </button>
          </div>
        </div>
      )}

      {open && (
        <div className="px-3 pb-3 pl-8 space-y-2.5">
          {m.description && <div className={BODY}>{m.description}</div>}

          {!supported && (
            <div className={SUBTLE} data-testid={`module-unsupported-${m.id}`}>
              {m.notInstallableReason
                || (m.type === "python-package"
                  ? "Installed with pip, not from here: install the requirements file listed under technical details."
                  : `Modules of type "${m.type}" have no installer.`)}
            </div>
          )}

          {/* Non-redistributable: MRLatte can't download it; say where it comes from. */}
          {supported && !redistributable && (
            <div className="border-l-2 border-warn pl-2.5 space-y-1.5" data-testid={`module-nonredist-${m.id}`}>
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-warn">
                <AlertTriangle size={11} /> {status === "installed" ? "Supplied by you, not by MRLatte" : "Get this one yourself"}
              </div>
              <div className={BODY}>
                {m.license?.spdx ? `${m.license.spdx}: ` : ""}its licence doesn't let MRLatte distribute it. Obtain it under its terms, then add the file here.
              </div>
              {m.license?.attribution && <div className={SUBTLE}>{m.license.attribution}</div>}
              {provenanceReview(m) && (
                <div className="flex items-start gap-1.5 text-[12px] text-warn/90 leading-snug">
                  <ShieldAlert size={11} className="mt-0.5 shrink-0" /> {provenanceReview(m)}
                </div>
              )}
              {upstream?.url && <div className={`${SUBTLE} break-all`}>From: {upstream.url}</div>}
              {(slotInstallable || sideloadable) && <label className="flex items-start gap-2 text-[12px] text-foreground leading-snug cursor-pointer">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  className="mt-0.5"
                  data-testid={`module-terms-${m.id}`}
                />
                I obtained this data from its source and accept its terms.
              </label>}
            </div>
          )}

          {/* Redistributable download: licence before the transfer. */}
          {confirmLicence && downloadable && (
            <div className="border border-border px-3 py-2.5 space-y-2 rounded-lg" data-testid={`module-confirm-${m.id}`}>
              <div className={BODY}>
                {m.bundledCopy ? `Copies ${moduleSize(m)} back from MRLatte's own copy (no download)` : (
                  <>
                    Downloads {moduleSize(m)} from{" "}
                    {dl?.type === "github-release" ? `the ${dl.tag || "release"} assets`
                      : dl?.type === "wheel" || m.type === "python-package" ? "PyPI"
                      : dl?.url || "the configured release source"}
                  </>
                )}
                , checks each file against its pinned hash, then installs it.
              </div>
              <LicenceBlock module={m} />
              {tooBig && (
                <div className="text-[12px] text-destructive">
                  Not enough free space: {moduleSize(m)} needed, {formatBytes(freeBytes)} free.
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmLicence(false)} className={BTN}>Cancel</button>
                <button
                  type="button"
                  disabled={tooBig}
                  onClick={() => { setConfirmLicence(false); onInstall(m, { repair: status === "broken" }); }}
                  className={PRIMARY}
                  data-testid={`module-store-confirm-install-${m.id}`}
                >
                  <Download size={11} /> Accept &amp; install
                </button>
              </div>
            </div>
          )}

          {confirmUninstall && (
            <div className="border border-destructive/40 px-3 py-2.5 space-y-2 rounded-lg" data-testid={`module-confirm-uninstall-${m.id}`}>
              <div className={BODY}>
                {isSlot && m.slotMode === "link"
                  // Nothing is deleted here, and saying "delete" would be a lie
                  // about the user's own file sitting outside the module root.
                  ? `Stop using ${m.slotPath || "this file"}? The file stays where it is; MRLatte just stops using it.`
                  : isSlot
                    ? `Remove the file from ${m.slot?.directory || "the slot"}/? It goes to the Recycle Bin where possible.`
                    : `Remove this module and free ${moduleSize(m)}? Its files go to the Recycle Bin where possible.`}
                {removeNote ? ` ${removeNote}` : ""}
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmUninstall(false)} className={BTN}>Keep</button>
                <button
                  type="button"
                  onClick={() => { setConfirmUninstall(false); onUninstall(m); }}
                  className={`${BTN} border-destructive/50 text-destructive hover:text-destructive`}
                  data-testid={`module-store-confirm-uninstall-${m.id}`}
                >
                  <Trash2 size={11} /> Remove
                </button>
              </div>
            </div>
          )}

          {supported && !busy && (
            <div className="flex flex-wrap gap-2">
              {/* Slot: choose a file by path. `Copy` duplicates it into the
                  slot directory; `Use in place` registers it where it already
                  is, which for a 673 MB tractogram is the difference between a
                  long copy and none at all. */}
              {slotInstallable && (
                <>
                  <button
                    type="button"
                    onClick={() => onSlotInstall(m, "link")}
                    disabled={!termsAccepted && !redistributable}
                    title={!termsAccepted && !redistributable
                      ? "Accept the terms above first."
                      : "Leave the file where it is and point MRLatte at it. Moving or deleting it later turns this feature off."}
                    className={BTN}
                    data-testid={`module-store-slot-link-${m.id}`}
                  >
                    <HardDrive size={11} /> {status === "installed" ? "Use another file (in place)" : "Use a file where it is"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSlotInstall(m, "copy")}
                    disabled={!termsAccepted && !redistributable}
                    title={!termsAccepted && !redistributable
                      ? "Accept the terms above first."
                      : `Copy the file into ${m.slot?.directory || "the slot"}/ under the module folder.`}
                    className={BTN}
                    data-testid={`module-store-slot-copy-${m.id}`}
                  >
                    <Download size={11} /> {status === "installed" ? "Replace (copy)" : "Copy a file in"}
                  </button>
                </>
              )}

              {sideloadable && (
                <button
                  type="button"
                  onClick={pickFile}
                  disabled={!redistributable && !termsAccepted}
                  title={!redistributable && !termsAccepted
                    ? "Accept the terms above first."
                    : multiFile ? "Choose a .zip with this module's files." : "Choose the module file, or a .zip containing it."}
                  className={BTN}
                  data-testid={`module-store-sideload-${m.id}`}
                >
                  <Upload size={11} />{" "}
                  {status === "broken" ? "Repair from a file" : status === "installed" ? "Replace from a file" : "Add from a file"}
                </button>
              )}

              {/* Slots carry no hash — they are validated structurally on every
                  read — so /verify has nothing to check and answers 409. */}
              {status !== "missing" && !isSlot && (
                <button type="button" onClick={() => onVerify(m)} className={BTN} data-testid={`module-store-verify-${m.id}`}>
                  <ShieldAlert size={11} /> Verify
                </button>
              )}

              {status !== "missing" && !confirmUninstall && !m.pendingRemoval && (
                <button
                  type="button"
                  onClick={() => setConfirmUninstall(true)}
                  disabled={!uninstallable}
                  title={uninstallable
                    ? "Remove this module"
                    : "MRLatte didn't install this (it's part of the app, or outside the module folder), so it can't remove it."}
                  className={BTN}
                  data-testid={`module-store-uninstall-${m.id}`}
                >
                  <Trash2 size={11} /> Remove
                </button>
              )}
            </div>
          )}

          {supported && !busy && (
            <div className={SUBTLE}>
              {slotInstallable
                ? `Accepts ${slotExtensions(m).join(", ") || "a matching file"}; it is checked before anything moves. `
                  + (m.slotMode === "link" && m.slotPath ? `Now using ${m.slotPath} in place (MRLatte won't delete it).`
                    : m.slotMode === "copy" ? "Now a copy in the module folder." : "")
                : sideloadable
                  ? (multiFile ? "A file you add is a .zip of this module's files; each is checked against its hash." : "A file you add is checked against its hash before use.")
                  : ""}
              {noReleaseConfigured && status !== "installed" && " No download source is set up yet, so add the file yourself for now."}
              {isSlot && !canPickFiles() && ` Choosing a file needs the desktop app; in the browser, drop it into ${m.slot?.directory || "the slot"}/ in the module folder.`}
              {status === "installed" && !uninstallable && !isSlot && !m.pendingRemoval && " Part of the app, so it can't be removed here."}
              {m.pendingRemoval && " It was in use when you removed it, so it goes the next time MRLatte starts."}
            </div>
          )}

          {children}

          <button
            type="button"
            onClick={() => setShowTech((v) => !v)}
            className="flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
            data-testid={`module-tech-${m.id}`}
          >
            {showTech ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Technical details
          </button>
          {showTech && (
            <div className="border-l border-border pl-2.5 space-y-1.5">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <Meta k="id" v={m.id} />
                <Meta k="type" v={m.type} />
                <Meta k="tier" v={m.tier} />
                <Meta k="version" v={m.version} />
              </div>
              <Details module={m} />
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
    </div>
  );
}

/**
 * A removal waits behind a toast with Undo: nothing is removed until the toast
 * closes (after 5 s, or when dismissed). Removed files go to the Recycle Bin,
 * which the app can't restore from, so waiting is what makes Undo safe.
 */
export function deferRemoval(name, run, undo) {
  let settled = false;
  const go = () => { if (!settled) { settled = true; run(); } };
  toast(`Removing ${name}`, {
    ...undoToastOptions(),
    description: "Undo to keep it.",
    action: { label: "Undo", onClick: () => { settled = true; undo?.(); } },
    onAutoClose: go,
    onDismiss: go,
  });
}

/**
 * The per-module actions (install, sideload, slot install, verify, uninstall,
 * cancel) and their job state. Shared by the Module Store and the Atlas
 * Manager; `onChanged` runs after anything that may have changed what is
 * installed.
 */
export function useModuleActions({ onChanged } = {}) {
  const { refresh } = useModules();
  const changed = useCallback(() => { refresh(); onChanged?.(); }, [refresh, onChanged]);

  const { jobs, setJob, clearJob } = useModuleJobs({
    onSettled: (mid, job) => {
      if (job.error) toast.error("Module job failed", { description: job.error });
      else if (job.cancelled) toast("Module job cancelled");
      else toast.success("Module updated");
      changed();
    },
  });

  // Aborts for in-flight sideload uploads (an upload is a live XHR, not a
  // backend job, so /cancel cannot stop it).
  const uploadsRef = useRef({});

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
      changed();
      return;
    }
    setJob(mid, { phase, done: true, error: null, stage: "done", progress: 1, result: data });
    toast.success(`${phase} complete`, { description: mid });
    changed();
  }, [setJob, changed]);

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

  const onUninstall = useCallback((m) => {
    setJob(m.id, { phase: "uninstall", done: false, stage: "removing in 5 s", progress: null, jobId: null, error: null, result: null });
    deferRemoval(m.name, async () => {
      setJob(m.id, { stage: "removing" });
      finish(m.id, await uninstallModule(m.id), "uninstall");
    }, () => clearJob(m.id));
  }, [setJob, finish, clearJob]);

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

  return { jobs, setJob, clearJob, finish, onInstall, onSideload, onSlotInstall, onVerify, onUninstall, onCancel };
}

export function ModuleStore() {
  const {
    loading, ok, reason, modules: allModules, installable, moduleRoot, freeBytes,
    refresh, storeOpen, storeFocus, closeStore,
  } = useModules();
  const { openManager } = useAtlasManager();
  const {
    jobs, clearJob, onInstall, onSideload, onSlotInstall, onVerify, onUninstall, onCancel,
  } = useModuleActions();
  // The template and the atlases are installed and removed in the Atlas
  // Manager, one at a time; the store lists them as one row that opens it.
  const modules = useMemo(() => allModules.filter((m) => !m.group), [allModules]);
  const atlasModules = useMemo(() => allModules.filter((m) => m.group), [allModules]);

  useEffect(() => {
    if (!storeOpen) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closeStore(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [storeOpen, closeStore]);

  // Re-read /api/modules whenever the store is opened: it is the only source of
  // truth for installed state and may have changed since startup.
  useEffect(() => { if (storeOpen) refresh(); }, [storeOpen, refresh]);

  // Grouped by what the user needs to do: broken first, then what is
  // installed, then what can be added. Core tier first within a group.
  const groups = useMemo(() => {
    const byTier = (a, b) => (a.tier === "core" ? 0 : 1) - (b.tier === "core" ? 0 : 1);
    const pick = (st) => modules.filter((m) => moduleStatus(m) === st).sort(byTier);
    return [
      { key: "broken", title: "Needs attention", items: pick("broken") },
      { key: "installed", title: "Installed", items: pick("installed") },
      { key: "missing", title: "Available", items: pick("missing") },
    ].filter((g) => g.items.length);
  }, [modules]);

  const counts = useMemo(() => {
    const c = { installed: 0, broken: 0, missing: 0 };
    modules.forEach((m) => { c[moduleStatus(m)] += 1; });
    return c;
  }, [modules]);

  if (!storeOpen) return null;

  const unreachable = !loading && ok !== true;

  return (
    <div
      className="modal-scrim fixed inset-0 z-[100] flex items-start justify-center bg-black/60 py-10 overflow-y-auto"
      onClick={closeStore}
      data-testid="module-store"
    >
      <div
        className="modal-panel w-[640px] max-w-[94vw] overflow-hidden rounded-xl border border-edge bg-panel shadow-elev-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Package size={15} className="text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-medium text-foreground leading-none">Modules</div>
            {!loading && ok === true && (
              <div className="mt-1 text-[12px] text-muted-foreground">
                {counts.installed} of {modules.length} installed
                {counts.broken > 0 && <span className="text-warn"> · {counts.broken} need{counts.broken === 1 ? "s" : ""} repair</span>}
                {freeBytes !== null && freeBytes !== undefined && <> · {formatBytes(freeBytes)} free</>}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={refresh}
            className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            title="Check again"
            data-testid="module-store-refresh"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <button
            type="button"
            onClick={closeStore}
            className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
            data-testid="module-store-close"
          >
            <X size={15} />
          </button>
        </div>

        {/* `relative`: keeps the rows' sr-only status words inside this scroll
            box, not hung off the fixed scrim (see AtlasManager). */}
        <div className="relative max-h-[72vh] overflow-y-auto thin-scroll">
          {loading && (
            <div className={`${BODY} px-4 py-3`} data-testid="module-store-loading">Checking modules…</div>
          )}

          {/* Fail open. With no answer from /api/modules we cannot know what is
              installed — listing everything as "not installed" would make a
              perfectly good install look broken. */}
          {unreachable && (
            <div className="m-4 border-l-2 border-warn pl-3 space-y-1" data-testid="module-store-unreachable">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-warn">
                <AlertTriangle size={12} /> Can't reach the analysis engine
              </div>
              <div className={BODY}>Which modules are installed is unknown right now, so nothing is shown as missing. Check again in a moment.</div>
              {reason && <div className={SUBTLE}>{reason}</div>}
            </div>
          )}

          {!loading && ok === true && (
            <>
              {!installable && (
                <div className={`${SUBTLE} px-4 pt-3`} data-testid="module-store-installer-off">
                  This version doesn't report an installer; actions it can't do will say so.
                </div>
              )}

              {atlasModules.length > 0 && (
                <div className="flex items-center gap-3 border-b border-border px-4 py-2.5" data-testid="module-store-atlases">
                  <Layers size={14} className="shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-foreground leading-snug">Atlases &amp; template</div>
                    <div className="text-[12px] text-muted-foreground leading-snug">
                      {atlasModules.filter((m) => moduleStatus(m) === "installed").length} of {atlasModules.length} installed.
                      Each one installs and is removed on its own, and you can add your own.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { closeStore(); openManager(); }}
                    className={BTN}
                    data-testid="module-store-open-atlas-manager"
                  >
                    Open Atlas Manager
                  </button>
                </div>
              )}

              {groups.map((g) => (
                <div key={g.key} data-testid={`module-group-${g.key}`}>
                  <div className={`${LABEL} px-4 pt-3 pb-1 ${g.key === "broken" ? "text-warn" : ""}`}>
                    {g.title} <span className="font-normal normal-case tracking-normal">· {g.items.length}</span>
                  </div>
                  <div className="divide-y divide-border border-y border-border">
                    {g.items.map((m) => (
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
                  </div>
                </div>
              ))}

              {modules.length === 0 && (
                <div className={`${BODY} px-4 py-3`}>No modules are listed.</div>
              )}

              {moduleRoot && (
                <div className={`${SUBTLE} px-4 py-3 break-all`} data-testid="module-store-root">
                  Stored in {moduleRoot}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ModuleStore;
