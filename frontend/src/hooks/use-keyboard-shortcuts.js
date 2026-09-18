import { useEffect } from "react";

// Single global keydown listener that dispatches to a caller-supplied handler
// map keyed by a normalized key string. Ignores events originating from text
// inputs / textareas / contentEditable so typing in a coordinate field or a
// layer name never triggers a shortcut (mirrors DrawingPanel's undo/redo guard).
//
// `handlers` is a map of `key -> () => void`. Keys are matched
// case-insensitively against `event.key`; a few aliases are normalized
// (arrows, +/-, ?). Modifier combos aren't needed here — the app's only
// modifier shortcut (Ctrl+scroll zoom) lives on the wheel handler.
//
// `captureKeys` (default []) opt in a subset of `handlers`' keys to a
// SEPARATE capture-phase listener that also stops propagation. Needed for
// ArrowLeft/ArrowRight (4D frame stepping): niivue's own canvas keydown
// listener already handles those internally when the canvas has focus, and
// since window-capture runs before that listener, claiming them there is the
// only way to guarantee a single step per keypress instead of a double-step
// (this listener's step plus niivue's own). Every other key stays on the
// plain bubble-phase listener below, which must NOT stop propagation — niivue's
// own H/J/K/L crosshair keys and M drag-mode key rely on it running last.
export function useKeyboardShortcuts(handlers, { enabled = true, captureKeys = [] } = {}) {
  useEffect(() => {
    if (!enabled) return;
    const isTypingTarget = (t) => {
      const tag = t?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable;
    };

    const onKey = (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // reserve modifiers

      let key = e.key;
      // Normalize a handful of keys to stable names.
      if (key === "=" || key === "+") key = "+";
      if (key === "_" ) key = "-";
      const fn = handlers[key] || handlers[key?.toLowerCase?.()];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener("keydown", onKey);

    let onCaptureKey = null;
    if (captureKeys.length) {
      const claimed = new Set(captureKeys);
      onCaptureKey = (e) => {
        if (!claimed.has(e.key)) return;
        if (isTypingTarget(e.target)) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const fn = handlers[e.key] || handlers[e.key?.toLowerCase?.()];
        if (fn) {
          e.preventDefault();
          e.stopPropagation();
          fn(e);
        }
      };
      window.addEventListener("keydown", onCaptureKey, true);
    }

    return () => {
      window.removeEventListener("keydown", onKey);
      if (onCaptureKey) window.removeEventListener("keydown", onCaptureKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handlers, enabled, captureKeys.join(",")]);
}
