import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchAtlases, setAtlasOrder } from "@/lib/atlasApi";

// Which atlases are installed, and in what order — fetched once at startup and
// shared by every consumer (the sidebar, the overlap panel, the lesion report,
// the summary, the cluster table and the Atlas Manager).
//
// This replaces the `import { STANDARD_ATLASES }` that four components did
// independently. That list was a module-level constant, so it could not react
// to an install, an uninstall or a reorder; nor could it ever show the five
// atlases that were on disk but missing from it.

const AtlasContext = createContext(null);

const EMPTY = {
  loading: true,
  ok: null,            // null = not answered yet, false = backend unreachable
  reason: null,
  atlases: [],
  catalog: [],
  atlasDir: null,
};

export function AtlasProvider({ children }) {
  const [state, setState] = useState(EMPTY);
  // Manager visibility lives here, not in Dashboard: the other things that open
  // it (the sidebar's empty state, the "Manage atlases…" button) are rendered
  // deep in the sidebar, several components away from the overlay.
  const [manager, setManager] = useState({ open: false, tab: null });

  const refresh = useCallback(async () => {
    const res = await fetchAtlases();
    setState({
      loading: false,
      ok: res.ok,
      reason: res.reason || null,
      atlases: res.atlases || [],
      catalog: res.catalog || [],
      atlasDir: res.atlasDir || null,
    });
    return res;
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Reorder optimistically: dragging a row should not wait for a round trip,
  // and a failed save re-syncs from the server rather than leaving the list
  // showing an order that was never persisted.
  const reorder = useCallback(async (order) => {
    setState((p) => {
      const byId = new Map(p.atlases.map((a) => [a.id, a]));
      const next = order.map((id) => byId.get(id)).filter(Boolean);
      for (const a of p.atlases) if (!order.includes(a.id)) next.push(a);
      return { ...p, atlases: next };
    });
    try {
      await setAtlasOrder(order);
    } catch (e) {
      console.warn("atlas reorder failed, resyncing:", e);
      refresh();
    }
  }, [refresh]);

  const openManager = useCallback((tab = null) => setManager({ open: true, tab }), []);
  const closeManager = useCallback(() => setManager({ open: false, tab: null }), []);

  const value = useMemo(() => ({
    ...state,
    refresh,
    reorder,
    managerOpen: manager.open,
    managerTab: manager.tab,
    openManager,
    closeManager,
  }), [state, refresh, reorder, manager, openManager, closeManager]);

  return <AtlasContext.Provider value={value}>{children}</AtlasContext.Provider>;
}

/** Full atlas state. Safe outside a provider (tests) — degrades to "unknown". */
export function useAtlases() {
  return useContext(AtlasContext) || {
    ...EMPTY, refresh: () => {}, reorder: () => {},
    managerOpen: false, managerTab: null, openManager: () => {}, closeManager: () => {},
  };
}

/** Just the visible, ordered atlases — what the sidebar and pickers render. */
export function useVisibleAtlases() {
  const { atlases } = useAtlases();
  return useMemo(() => atlases.filter((a) => !a.hidden), [atlases]);
}

/** Open/close handle for the Atlas Manager overlay. */
export function useAtlasManager() {
  const { managerOpen, managerTab, openManager, closeManager } = useAtlases();
  return { managerOpen, managerTab, openManager, closeManager };
}

/**
 * Resolve an atlas id OR one of its legacy aliases to the installed descriptor.
 *
 * Aliases exist because the canonical ids changed in the atlas revamp
 * (ho_cort -> harvard_oxford_cort, hcp1065 -> hcp1065_tracts, visfAtlas ->
 * visfatlas). Saved workspaces, layerLabelAtlas maps and
 * OneClickSummaryPanel's defaults still carry the old ids.
 */
export function useResolveAtlas() {
  const { atlases } = useAtlases();
  const index = useMemo(() => {
    const m = new Map();
    for (const a of atlases) {
      m.set(a.id, a);
      m.set(a.id.toLowerCase(), a);
      for (const alias of a.aliases || []) m.set(String(alias).toLowerCase(), a);
    }
    return m;
  }, [atlases]);
  return useCallback(
    (id) => (id ? index.get(id) || index.get(String(id).toLowerCase()) || null : null),
    [index],
  );
}

/**
 * Lazily-fetched label tables, keyed by atlas id.
 *
 * State, not a ref. The old `atlasLabelsRef.current` was passed as a prop and
 * never triggered a render, so the label list only appeared because an
 * unrelated setAtlasState happened to follow the await — load-bearing by
 * accident. `regions` here re-renders its consumers on its own.
 */
export function useAtlasRegions() {
  const [regions, setRegions] = useState({});
  // Mirrors `regions` for the async guard: reading state inside the callback
  // would capture a stale value and refetch the same atlas repeatedly.
  const inflight = useRef(new Map());

  const ensure = useCallback(async (atlas) => {
    if (!atlas?.id) return [];
    const id = atlas.id;
    const pending = inflight.current.get(id);
    if (pending) return pending;
    const p = (async () => {
      const { loadRegions } = await import("@/lib/atlasLabels");
      const list = await loadRegions(atlas.labelsUrl);
      setRegions((prev) => ({ ...prev, [id]: list }));
      return list;
    })();
    inflight.current.set(id, p);
    try {
      return await p;
    } finally {
      // Keep the resolved promise cached so repeat callers short-circuit, but
      // drop it if it produced nothing so a transient failure can be retried.
      const settled = await p.catch(() => []);
      if (!settled.length) inflight.current.delete(id);
    }
  }, []);

  const clear = useCallback((id) => {
    if (id) {
      inflight.current.delete(id);
      setRegions((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    } else {
      inflight.current.clear();
      setRegions({});
    }
  }, []);

  return { regions, ensure, clear };
}

export default AtlasContext;
