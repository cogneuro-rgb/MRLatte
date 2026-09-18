import React, { useMemo, useState } from "react";
import { Search, Crosshair } from "lucide-react";
import { matchRegions } from "@/lib/atlasLabels";

/**
 * One search box across EVERY installed atlas.
 *
 * Per-atlas filtering already exists inside AtlasLabelList, but it only works
 * once you know which atlas holds the region — and with 11+ atlases installed
 * that is exactly the thing you do not know. This searches them all at once
 * and jumps the crosshair to whichever region you pick.
 *
 * Results are capped: "cortex" matches hundreds of regions across Destrieux,
 * AAL and Jülich, and rendering all of them makes the sidebar unusable.
 */
const MAX_RESULTS = 40;

export default function AtlasRegionSearch({ atlases, atlasRegions, onNavigate }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const hits = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    const out = [];
    for (const a of atlases || []) {
      for (const r of matchRegions(atlasRegions?.[a.id] || [], q)) {
        out.push({ atlasId: a.id, atlasShort: a.short || a.id, value: r.value, name: r.name });
        if (out.length >= MAX_RESULTS * 3) break;
      }
    }
    // Prefix matches first — searching "hippo" should surface "Hippocampus"
    // above "Parahippocampal gyrus".
    const lower = q.toLowerCase();
    out.sort((x, y) => {
      const px = x.name.toLowerCase().startsWith(lower) ? 0 : 1;
      const py = y.name.toLowerCase().startsWith(lower) ? 0 : 1;
      return px - py || x.name.localeCompare(y.name);
    });
    return out.slice(0, MAX_RESULTS);
  }, [query, atlases, atlasRegions]);

  return (
    <div className="relative min-w-0 flex-1">
      <div className="flex items-center gap-1 border border-border px-2">
        <Search size={12} className="shrink-0 opacity-60" />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          // A click on a result must land before the blur closes the list.
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Find a region in any atlas…"
          className="min-w-0 flex-1 bg-transparent py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none"
          data-testid="atlas-region-search"
        />
      </div>

      {open && query.trim().length >= 2 && (
        <div className="absolute left-0 right-0 top-full z-30 max-h-64 overflow-y-auto border border-border bg-panel shadow-lg">
          {hits.map((h) => (
            <button
              key={`${h.atlasId}-${h.value}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onNavigate?.(h.atlasId, h.value);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-panel-hover hover:text-foreground"
              data-testid={`atlas-search-hit-${h.atlasId}-${h.value}`}
            >
              <span className="truncate">{h.name}</span>
              <span className="flex shrink-0 items-center gap-1 opacity-60">
                <span className="text-[10px]">{h.atlasShort}</span>
                <Crosshair size={11} />
              </span>
            </button>
          ))}
          {!hits.length && (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              No region matches “{query.trim()}”.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
