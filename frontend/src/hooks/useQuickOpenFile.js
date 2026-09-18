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
 *     activation file (or no file, or any failure) resolves
 *     `initialBaseVolume` to the default BASE_VOLUME (MNI152) instead,
 *     since an activation overlay still needs MNI as its base.
 *  2. Once `viewerReady` flips true (the viewer's first load — whichever
 *     volume that was — has resolved), apply what's left: for base/
 *     timeseries the volume is already loaded, so this is just the
 *     baseLabel/focus/slice-type bookkeeping; for activation, add the
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
 * @returns {{ initialBaseVolume: object|null }} pass straight through as
 *   NiivueViewer's `baseVolume` prop; null means "still resolving, don't
 *   mount the viewer yet" (resolves in a single microtask/IPC round trip).
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
  // { kind: "none" | "error" | "base" | "timeseries" | "activation", ... }
  const resolvedRef = useRef(null);
  const appliedRef = useRef(false);

  const cbRef = useRef(null);
  cbRef.current = { handleBaseUpload, markBaseLoadedExternally, addUserFile, removeUserLayer, setAsymmetric, setSliceType, setFocusMode };

  // Phase 1.
  useEffect(() => {
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

        if (classified.kind === "activation") {
          resolvedRef.current = { kind: "activation", file, classified };
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

    if (resolved.kind === "base" || resolved.kind === "timeseries") {
      if (resolved.blobUrl) URL.revokeObjectURL(resolved.blobUrl); // niivue has already read it into memory
      markBaseLoadedExternally(resolved.file.name, resolved.filePath);
      setAsymmetric(false);
      setSliceType(resolved.kind === "timeseries" ? "multiplanar" : "render");
      setFocusMode(true);
      return;
    }

    // activation — MNI is already loaded as the base (phase 1's fallback).
    // Multiplanar + 3D, not pure Render: shows the overlay in the 2D slice
    // planes alongside the 3D view, matching the 4D timeseries route rather
    // than the base-volume route.
    (async () => {
      const id = await addUserFile(resolved.file, "activation");
      setAsymmetric(false);
      setSliceType("multiplanar");
      setFocusMode(true);
      if (id) {
        toast.info("Opened as an activation overlay", {
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

  return { initialBaseVolume };
}
