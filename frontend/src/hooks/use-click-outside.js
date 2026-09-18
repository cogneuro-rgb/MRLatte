import { useEffect } from "react";

// Fires `handler` on any mousedown/touchstart outside `ref`'s element.
// Pass `active=false` to skip attaching the listener (e.g. when the
// popover it guards is already closed).
//
// `shouldIgnore(e)` (optional, item 102/6e): when it returns true for an
// otherwise-outside event, the close is skipped entirely. Used by the clip
// popover so a right-click/right-drag on the 3D render (which rotates the
// camera and is meant to be watched while the popover's az/el sliders track
// it) doesn't auto-close it.
export function useClickOutside(ref, handler, active = true, shouldIgnore) {
  useEffect(() => {
    if (!active) return;
    const listener = (e) => {
      const el = ref.current;
      if (!el || el.contains(e.target)) return;
      if (shouldIgnore?.(e)) return;
      handler(e);
    };
    document.addEventListener("mousedown", listener);
    document.addEventListener("touchstart", listener);
    return () => {
      document.removeEventListener("mousedown", listener);
      document.removeEventListener("touchstart", listener);
    };
  }, [ref, handler, active, shouldIgnore]);
}
