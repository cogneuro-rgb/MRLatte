import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { classifyNiftiBuffer } from "@/lib/niftiClassify";
import { BASE_VOLUME } from "@/lib/atlasConfig";

const READ_ERROR_MESSAGE = {
  "too-large": "That file is too large to quick-open (over 1.5 GB).",
  "not-allowed": "Could not read that file.",
};

/**
 * Explorer double-click / file-association quick-open.
 *
 * Two phases, so a base/timeseries quick-open never shows the default
 * MNI152 template for a frame before swapping to the real file:
 *
 *  1. On mount, independent of the viewer: ask the main process whether
 *     THIS window was opened with a file, read + classify it. A base or
 *     timeseries file becomes `initialBaseVolume` directly (a blob URL) —
 *     the caller must render NiivueViewer with THAT as its `baseVolume`
 *     prop, so its first-ever load fetches the real file, never MNI152. An
 *     activation or lesion file (or no file, or any failure) resolves
 *     `initialBaseVolume` to the default BASE_VOLUME (MNI152) instead,
 *     since both overlay kinds still need MNI as their base — a lesion mask
 *     is never itself the base, even when it's the only file the window was
 *     opened with (Explorer quick-open, a `mrlatte://open?path=` deep link,
 *     or the equivalent drag-drop — see niftiClassify.js's "lesion" kind).
 *  2. Once `viewerReady` flips true (the viewer's first load — whichever
 *     volume that was — has resolved), apply what's left: for base/
 *     timeseries the volume is already loaded, so this is just the
 *     baseLabel/focus/slice-type bookkeeping; for activation/lesion, add the
 *     overlay now that MNI is loaded; for an error, toast it.
 *
 * A no-op in the browser build (no window.mrlatte) and for any window that
 * wasn't opened with a file — `initialBaseVolume` resolves straight to
 * BASE_VOLUME with nothing further to do in phase 2.
 *
 * @param {object} deps
 * @param {boolean} deps.viewerReady
 * @param {(file: File) => Promise<void>} deps.handleBaseUpload
 * @param {(name: string, fullPath: string|null) => void} deps.markBaseLoadedExternally
 * @param {(file: File, type: string, opts?: object) => Promise<string|null>} deps.addUserFile
 * @param {(id: string) => void} deps.removeUserLayer
 * @param {(v: boolean) => void} deps.setAsymmetric
 * @param {(v: string) => void} deps.setSliceType
 * @param {(v: boolean) => void} deps.setFocusMode
 * @returns {{ initialBaseVolume: object|null, openDroppedFiles: (files: File[]) => Promise<void> }}
 *   initialBaseVolume: pass straight through as NiivueViewer's `baseVolume`
 *   prop; null means "still resolving, don't mount the viewer yet" (resolves
 *   in a single microtask/IPC round trip).
 *   openDroppedFiles: files dropped on the viewer, routed the same way as a
 *   double-click — a base/timeseries replaces the base, a lesion or
 *   activation map is added as an overlay on the current base.
 */
export function useQuickOpenFile({
  viewerReady,
  handleBaseUpload,
  markBaseLoadedExternally,
  addUserFile,
  removeUserLayer,
  setAsymmetric,
  setSliceType,
  setFocusMode,
}) {
  const [initialBaseVolume, setInitialBaseVolume] = useState(null);
  // What phase 1 found, for phase 2 to act on once the viewer is ready.
  // { kind: "none" | "error" | "base" | "timeseries" | "activation" | "lesion" | "multi", ... }
  const resolvedRef = useRef(null);
  const appliedRef = useRef(false);

  const cbRef = useRef(null);
  cbRef.current = { handleBaseUpload, markBaseLoadedExternally, addUserFile, removeUserLayer, setAsymmetric, setSliceType, setFocusMode };

  // Phase 1. Runs once per window: getPendingOpenFile CONSUMES the queued
  // request, so a second run (React StrictMode re-invokes mount effects in
  // development) would find nothing and resolve to plain MNI — and with
  // several files to read, that empty run finished first and the link's
  // files arrived after the viewer had already settled. Refs survive
  // StrictMode's simulated remount, so this guard makes the second run a no-op.
  const phase1StartedRef = useRef(false);
  useEffect(() => {
    if (phase1StartedRef.current) return;
    phase1StartedRef.current = true;
    (async () => {
      if (!window.mrlatte?.getPendingOpenFile) {
        resolvedRef.current = { kind: "none" };
        setInitialBaseVolume(BASE_VOLUME);
        return;
      }
      try {
        const pending = await window.mrlatte.getPendingOpenFile();
        if (!pending) {
          resolvedRef.current = { kind: "none" };
          setInitialBaseVolume(BASE_VOLUME);
          return;
        }

        // A mrlatte://open?base=…&overlay=… link: { base|null, overlays[] }.
        // The base is the base whatever it looks like (the link said so);
        // each overlay takes the link's overlaytype, else the same detection
        // a double-click uses (a mask → lesion, anything else → activation).
        // A file that can't be read or isn't NIfTI is reported and skipped;
        // the rest still open.
        if (pending.overlays) {
          const errors = [];
          const readClassified = async (f) => {
            const res = await window.mrlatte.readOpenFile(f.filePath);
            if (!res?.ok) {
              errors.push({ title: "Could not open file", message: READ_ERROR_MESSAGE[res?.error] || f.name });
              return null;
            }
            const classified = await classifyNiftiBuffer(res.bytes, res.name);
            if (!classified.ok) {
              errors.push({ title: "Not a NIfTI file", message: res.name });
              return null;
            }
            return { res, classified };
          };

          let base = null;
          if (pending.base) {
            const r = await readClassified(pending.base);
            if (r) {
              base = {
                file: new File([r.res.bytes], r.res.name),
                blobUrl: URL.createObjectURL(new Blob([r.res.bytes])),
                filePath: pending.base.filePath,
                kind: r.classified.kind,
              };
            }
          }
          const overlays = [];
          for (const o of pending.overlays) {
            const r = await readClassified(o);
            if (!r) continue;
            overlays.push({
              file: new File([r.res.bytes], r.res.name),
              type: o.type || (r.classified.kind === "lesion" ? "lesion" : "activation"),
            });
          }
          resolvedRef.current = { kind: "multi", base, overlays, errors };
          setInitialBaseVolume(base
            ? { id: base.file.name, name: base.file.name, url: base.blobUrl, colormap: "gray", opacity: 1 }
            : BASE_VOLUME);
          return;
        }

        const res = await window.mrlatte.readOpenFile(pending.filePath);
        if (!res?.ok) {
          resolvedRef.current = { kind: "error", title: "Could not open file", message: READ_ERROR_MESSAGE[res?.error] || pending.name };
          setInitialBaseVolume(BASE_VOLUME);
          return;
        }

        const classified = await classifyNiftiBuffer(res.bytes, res.name);
        if (!classified.ok) {
          resolvedRef.current = { kind: "error", title: "Not a NIfTI file", message: res.name };
          setInitialBaseVolume(BASE_VOLUME);
          return;
        }

        const file = new File([res.bytes], res.name);

        if (classified.kind === "activation" || classified.kind === "lesion") {
          resolvedRef.current = { kind: classified.kind, file, classified };
          setInitialBaseVolume(BASE_VOLUME);
          return;
        }

        // base or timeseries: this file IS the viewer's first load — no
        // MNI152 fetch happens at all.
        const blobUrl = URL.createObjectURL(new Blob([res.bytes]));
        resolvedRef.current = { kind: classified.kind, file, blobUrl, filePath: pending.filePath };
        setInitialBaseVolume({ id: res.name, name: res.name, url: blobUrl, colormap: "gray", opacity: 1 });
      } catch (err) {
        console.error("[quick-open] phase 1 failed:", err);
        resolvedRef.current = { kind: "error", title: "Quick-open failed", message: err?.message || String(err) };
        setInitialBaseVolume(BASE_VOLUME);
      }
    })();
  }, []);

  // Phase 2.
  useEffect(() => {
    if (!viewerReady || appliedRef.current) return;
    const resolved = resolvedRef.current;
    if (!resolved) return; // phase 1 hasn't settled — viewerReady can't be true yet regardless, since it gates the viewer's own mount
    appliedRef.current = true;

    const { handleBaseUpload, markBaseLoadedExternally, addUserFile, removeUserLayer, setAsymmetric, setSliceType, setFocusMode } = cbRef.current;

    if (resolved.kind === "none") return;

    if (resolved.kind === "error") {
      toast.error(resolved.title, { description: resolved.message });
      return;
    }

    // Base + overlays deep link (see phase 1). The base, if any, is already
    // the viewer's first load; overlays are added in link order on top of it
    // (or on MNI when the link named no base).
    if (resolved.kind === "multi") {
      for (const e of resolved.errors) toast.error(e.title, { description: e.message });
      (async () => {
        if (resolved.base) {
          URL.revokeObjectURL(resolved.base.blobUrl); // niivue has already read it into memory
          markBaseLoadedExternally(resolved.base.file.name, resolved.base.filePath);
        }
        let added = 0;
        for (const o of resolved.overlays) {
          if (await addUserFile(o.file, o.type)) added++;
        }
        setAsymmetric(false);
        setSliceType(resolved.overlays.length || resolved.base?.kind === "timeseries" ? "multiplanar" : "render");
        setFocusMode(true);
        if (added) {
          toast.info(`Opened ${resolved.base ? "base + " : ""}${added} overlay${added === 1 ? "" : "s"}`, {
            description: resolved.overlays.map((o) => `${o.file.name} → ${o.type}`).join(", "),
          });
        }
      })();
      return;
    }

    if (resolved.kind === "base" || resolved.kind === "timeseries") {
      if (resolved.blobUrl) URL.revokeObjectURL(resolved.blobUrl); // niivue has already read it into memory
      markBaseLoadedExternally(resolved.file.name, resolved.filePath);
      setAsymmetric(false);
      setSliceType(resolved.kind === "timeseries" ? "multiplanar" : "render");
      setFocusMode(true);
      return;
    }

    // activation or lesion — MNI is already loaded as the base (phase 1's
    // fallback), and addUserFile's `type` drives the right colormap/opacity/
    // mask-zero defaults for each (same as the Activation Maps / Lesion Mask
    // sidebar sections). Multiplanar + 3D, not pure Render: shows the
    // overlay in the 2D slice planes alongside the 3D view, matching the 4D
    // timeseries route rather than the base-volume route.
    (async () => {
      const overlayType = resolved.kind; // "activation" | "lesion"
      const id = await addUserFile(resolved.file, overlayType);
      setAsymmetric(false);
      setSliceType("multiplanar");
      setFocusMode(true);
      if (id) {
        toast.info(overlayType === "lesion" ? "Opened as a lesion overlay" : "Opened as an activation overlay", {
          description: resolved.classified.reason,
          action: {
            label: "Use as base instead",
            onClick: async () => {
              removeUserLayer(id);
              await handleBaseUpload(resolved.file);
            },
          },
        });
      }
    })();
  }, [viewerReady]);

  // Files dropped on the viewer (Dashboard's onDropCapture). Same detection
  // as a double-click, but on the window as it is now: the current base stays
  // unless a dropped file is itself a base, and the view isn't switched to
  // focus mode. At most one base per drop — any further base-like files are
  // added as overlays rather than replacing each other.
  const openDroppedFiles = async (files) => {
    const { handleBaseUpload, addUserFile, removeUserLayer } = cbRef.current;
    let baseTaken = false;
    for (const file of files) {
      let classified;
      try {
        classified = await classifyNiftiBuffer(await file.arrayBuffer(), file.name);
      } catch (err) {
        toast.error("Could not open file", { description: file.name });
        continue;
      }
      if (!classified.ok) {
        toast.error("Not a NIfTI file", { description: file.name });
        continue;
      }
      if ((classified.kind === "base" || classified.kind === "timeseries") && !baseTaken) {
        baseTaken = true;
        await handleBaseUpload(file);
        continue;
      }
      const overlayType = classified.kind === "lesion" ? "lesion" : "activation";
      const id = await addUserFile(file, overlayType);
      if (id) {
        toast.info(overlayType === "lesion" ? `${file.name}: added as a lesion overlay` : `${file.name}: added as an activation overlay`, {
          description: classified.reason,
          action: {
            label: "Use as base instead",
            onClick: async () => {
              removeUserLayer(id);
              await handleBaseUpload(file);
            },
          },
        });
      }
    }
  };

  return { initialBaseVolume, openDroppedFiles };
}
