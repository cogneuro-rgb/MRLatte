import React from "react";
import { ChevronDown, ChevronRight, ChevronUp, RefreshCw } from "lucide-react";
import { useCapability, useModulesFor } from "@/hooks/use-modules";
import { moduleSize, moduleStatus } from "@/lib/modules";

// Error boundary that catches chunk-load failures (and any other render error)
// inside a SidebarSection. Shows a minimal inline fallback with a Refresh
// button so the user can recover without a full page reload.
class ChunkErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, isChunkError: false };
  }
  static getDerivedStateFromError(error) {
    const isChunkError =
      error?.name === "ChunkLoadError" ||
      /loading chunk/i.test(error?.message ?? "") ||
      /loading css chunk/i.test(error?.message ?? "");
    return { hasError: true, isChunkError };
  }
  reset() {
    this.setState({ hasError: false, isChunkError: false });
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="space-y-2 py-2">
        <p className="cap text-destructive">
          {this.state.isChunkError
            ? "Failed to load panel (network error)"
            : "Something went wrong"}
        </p>
        <button
          onClick={() => this.reset()}
          className="flex items-center gap-1.5 cap text-subtle hover:text-foreground transition-colors"
        >
          <RefreshCw size={10} /> Try again
        </button>
      </div>
    );
  }
}


// Item 105: registry that lets the sidebar header's "toggle all" button see how
// many sections are currently open and drive them all at once, WITHOUT hoisting
// eleven separate open/closed states into Dashboard (most sections are
// uncontrolled via defaultOpen, and several live in their own section files).
// Every SidebarSection rendered under a provider self-registers here; sections
// rendered outside one (tests, storybook) simply see a null context and behave
// exactly as before.
const SidebarSectionsContext = React.createContext(null);

/**
 * Owns the "toggle all sections" registry. Returns:
 *   ctx       — pass to <SidebarSectionsContext.Provider value={ctx}>
 *   openCount — how many registered sections are currently open
 *   setAll    — setAll(true|false) opens/closes every registered section
 *   sections  — every registered section in sidebar order, with what the
 *               collapsed sidebar's icon rail shows for it: { id, testId,
 *               title, icon, badge, unavailable, gatePill, isOpen, setOpen }
 */
export function useSidebarSectionsController() {
  // id -> { isOpen, setOpen }. A ref (not state) because sections mutate their
  // own entry on every open/close and we only want ONE re-render per change,
  // driven by the openCount below.
  const entriesRef = React.useRef(new Map());
  const [openCount, setOpenCount] = React.useState(0);
  // Bumped when a section's rail metadata (title, badge, gate) changes.
  const [metaVersion, setMetaVersion] = React.useState(0);

  const recount = React.useCallback(() => {
    let n = 0;
    entriesRef.current.forEach((e) => { if (e.isOpen) n += 1; });
    setOpenCount(n);
  }, []);

  const register = React.useCallback((id, entry) => {
    entriesRef.current.set(id, entry);
    recount();
    return () => { entriesRef.current.delete(id); recount(); };
  }, [recount]);

  const report = React.useCallback((id, isOpen) => {
    const e = entriesRef.current.get(id);
    if (!e || e.isOpen === isOpen) return;
    e.isOpen = isOpen;
    recount();
  }, [recount]);

  const describe = React.useCallback((id, meta) => {
    const e = entriesRef.current.get(id);
    if (!e) return;
    const old = e.meta || {};
    if (Object.keys(meta).every((k) => old[k] === meta[k])) return;
    e.meta = meta;
    setMetaVersion((v) => v + 1);
  }, []);

  const setAll = React.useCallback((open) => {
    entriesRef.current.forEach((e) => {
      if (e.isOpen !== open) e.setOpen(open);
    });
  }, []);

  const sections = React.useMemo(
    () => [...entriesRef.current].map(([id, e]) => ({ id, ...e.meta, isOpen: e.isOpen, setOpen: e.setOpen })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openCount, metaVersion],
  );

  const ctx = React.useMemo(() => ({ register, report, describe }), [register, report, describe]);
  return { ctx, openCount, setAll, sections };
}

export { SidebarSectionsContext };

/**
 * Sidebar collapsible section.
 */
export const SidebarSection = ({
  title,
  icon: Icon,
  testId,
  defaultOpen = true,
  badge,
  // Short status shown on the closed row, e.g. "MNI152 · 0.74 mm".
  summary,
  children,
  // Optional controlled-open mode: when `open` is provided, the parent owns the
  // open/closed state and gets notified via `onOpenChange`. Omit both to keep
  // the default uncontrolled behaviour (internal state seeded by defaultOpen).
  open: openProp,
  onOpenChange,
  keepMounted = false,
  // Module capability this section needs (e.g. "lnm"). While it is missing the
  // heading is greyed out; the section still opens, so its install prompt
  // (ModuleGate) stays one click away. Unknown while module status loads.
  capability,
  // Or the section says itself: false greys the heading, undefined = unknown.
  // `unavailableHint` is its tooltip then.
  available,
  unavailableHint,
}) => {
  const has = useCapability(capability || "__none__");
  const neededModules = useModulesFor(capability || "__none__");
  const unavailable = available === false || (!!capability && has === false);
  const [openState, setOpenState] = React.useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openState;
  const setOpen = (next) => {
    if (next === open) return;
    if (!isControlled) setOpenState(next);
    onOpenChange?.(next);
  };
  const toggle = () => setOpen(!open);

  // Item 105: self-register with the "toggle all" controller. setOpen is routed
  // through a ref so the registered callback always drives the CURRENT
  // open/onOpenChange pair (a controlled section's parent handler changes
  // identity between renders; a stale one would silently no-op).
  const ctl = React.useContext(SidebarSectionsContext);
  const id = React.useId();
  const openRef = React.useRef(open);
  openRef.current = open;
  const setOpenRef = React.useRef(setOpen);
  setOpenRef.current = setOpen;
  React.useEffect(() => {
    if (!ctl) return undefined;
    return ctl.register(id, {
      isOpen: openRef.current,
      setOpen: (v) => setOpenRef.current(v),
    });
  }, [ctl, id]);
  React.useEffect(() => { ctl?.report(id, open); }, [ctl, id, open]);

  // What a greyed-out section needs, shown as a pill on its row: one
  // missing module names its size, several are counted.
  const missing = neededModules.filter((m) => moduleStatus(m) !== "installed");
  const gatePill = !unavailable ? null
    : missing.length === 1 ? (moduleSize(missing[0]) === "unknown size" ? "Install" : `Install · ${moduleSize(missing[0])}`)
    : missing.length > 1 ? `Add ${missing.length} modules`
    : null;

  React.useEffect(() => {
    ctl?.describe(id, { testId, title, icon: Icon, badge, unavailable, gatePill });
  }, [ctl, id, testId, title, Icon, badge, unavailable, gatePill]);

  return (
    <div
      className={`rounded-lg transition-colors ${open ? "my-1 border border-border bg-card" : "border border-transparent"}`}
      data-open={open}
      data-testid={testId}
    >
      <button
        onClick={toggle}
        aria-expanded={open}
        className={`flex h-[38px] w-full items-center gap-2.5 px-2.5 text-left transition-colors ${
          open ? "rounded-t-lg" : "rounded-md hover:bg-panel-hover"
        }`}
        data-testid={`${testId}-toggle`}
        data-unavailable={unavailable || undefined}
        title={!unavailable ? undefined
          : available === false ? unavailableHint
          : `Needs the ${neededModules.map((m) => m.name).join(" / ") || capability} module — open to install it`}
      >
        {Icon && (
          <Icon
            size={16}
            className={`flex-shrink-0 ${open ? "text-foreground" : "text-muted-foreground"} ${unavailable ? "opacity-50" : ""}`}
          />
        )}
        <span
          className={`min-w-0 flex-1 truncate text-[13.5px] ${open ? "font-semibold" : "font-medium"} ${
            unavailable ? "text-muted-foreground" : "text-foreground"
          }`}
        >
          {title}
        </span>
        {summary && !open && (
          <span className="truncate text-[12px] text-subtle">{summary}</span>
        )}
        {badge !== undefined && badge !== null && badge !== 0 && (
          <span className="count" title="Shown now">{badge}</span>
        )}
        {gatePill && (
          <span className="whitespace-nowrap rounded-full border border-edge px-2 text-[11.5px] leading-[18px] text-muted-foreground">
            {gatePill}
          </span>
        )}
        {open ? (
          <ChevronDown size={14} className="flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="flex-shrink-0 text-subtle" />
        )}
      </button>
      {(open || keepMounted) && (
        <div className={`space-y-2.5 px-2.5 pb-2 pt-0.5 ${open ? "" : "hidden"}`}>
          {/* Suspense boundary so lazily code-split panels can stream their chunk
              on first open without a top-level fallback flashing the whole UI. */}
          <React.Suspense
            fallback={
              <div className="py-2 text-[12px] text-subtle">
                Loading…
              </div>
            }
          >
            <ChunkErrorBoundary>
              {children}
            </ChunkErrorBoundary>
          </React.Suspense>
          {/* Item: per-section close row, reuses the existing toggle/setOpen
              handler (no new state). Lives inside the same open/keepMounted
              content div as `children`, so the shared `hidden` class above
              already keeps it out of view whenever keepMounted holds a
              closed section mounted — it is never visible unless `open`. */}
          <button
            type="button"
            onClick={toggle}
            className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md text-[12px] text-subtle transition-colors hover:bg-panel-hover hover:text-foreground"
            data-testid={`${testId}-close`}
          >
            <ChevronUp size={12} />
            Close
          </button>
        </div>
      )}
    </div>
  );
};

/** Small-caps heading over a group of sidebar sections (Volumes, Analysis, Reference). */
export const SidebarGroup = ({ children }) => (
  <div className="cap px-2.5 pb-1.5 pt-3.5 text-subtle first:pt-1.5">{children}</div>
);

export default SidebarSection;
