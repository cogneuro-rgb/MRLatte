import React from "react";
import { ChevronDown, ChevronRight, ChevronUp, RefreshCw } from "lucide-react";

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
        <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-destructive">
          {this.state.isChunkError
            ? "Failed to load panel (network error)"
            : "Something went wrong"}
        </p>
        <button
          onClick={() => this.reset()}
          className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors"
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
 */
export function useSidebarSectionsController() {
  // id -> { isOpen, setOpen }. A ref (not state) because sections mutate their
  // own entry on every open/close and we only want ONE re-render per change,
  // driven by the openCount below.
  const entriesRef = React.useRef(new Map());
  const [openCount, setOpenCount] = React.useState(0);

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

  const setAll = React.useCallback((open) => {
    entriesRef.current.forEach((e) => {
      if (e.isOpen !== open) e.setOpen(open);
    });
  }, []);

  const ctx = React.useMemo(() => ({ register, report }), [register, report]);
  return { ctx, openCount, setAll };
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
  children,
  // Optional controlled-open mode: when `open` is provided, the parent owns the
  // open/closed state and gets notified via `onOpenChange`. Omit both to keep
  // the default uncontrolled behaviour (internal state seeded by defaultOpen).
  open: openProp,
  onOpenChange,
  keepMounted = false,
}) => {
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

  return (
    <div
      // Item: divider between two sections becomes pure white (dark mode) /
      // pure black (light mode) ONLY when this section AND the section
      // directly below it are both open — otherwise it stays the muted
      // `border-border` gray. Done with pure CSS, no neighbor-tracking JS:
      // `data-open` records this section's own open state, and
      // `has-[+[data-open=true]]` (CSS `:has(+ [data-open="true"])`,
      // Tailwind 3.4+) checks whether the NEXT sibling is also open. The
      // `[.light_&]` arbitrary variant hooks into the same `.light` class
      // on <html> that index.css themes off of (this app never toggles a
      // `.dark` class — dark is the default, unclassed state — so the
      // built-in `dark:` variant would never fire here).
      className={`border-b border-border data-[open=true]:has-[+[data-open=true]]:border-white [.light_&]:data-[open=true]:has-[+[data-open=true]]:border-black ${open ? "bg-panel-active" : ""}`}
      data-open={open}
      data-testid={testId}
    >
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-panel-hover transition-colors"
        data-testid={`${testId}-toggle`}
      >
        <div className="flex items-center gap-2.5">
          {Icon && <Icon size={13} className="text-muted-foreground" />}
          <span className="font-mono text-[11px] uppercase tracking-[0.3em] text-foreground">
            {title}
          </span>
          {badge !== undefined && badge !== null && badge !== 0 && (
            <span className="ml-1 font-mono text-[9px] text-emerald-500 tabular-nums">
              {badge}
            </span>
          )}
        </div>
        {open ? (
          <ChevronDown size={12} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={12} className="text-muted-foreground" />
        )}
      </button>
      {(open || keepMounted) && (
        <div className={`px-5 pb-4 space-y-3 ${open ? "" : "hidden"}`}>
          {/* Suspense boundary so lazily code-split panels can stream their chunk
              on first open without a top-level fallback flashing the whole UI. */}
          <React.Suspense
            fallback={
              <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground py-2">
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
            className="mt-1 w-full flex items-center justify-center gap-1.5 border-t border-border pt-2 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground hover:text-foreground hover:bg-panel-hover transition-colors"
            data-testid={`${testId}-close`}
          >
            <ChevronUp size={11} />
            Close
          </button>
        </div>
      )}
    </div>
  );
};

export default SidebarSection;
