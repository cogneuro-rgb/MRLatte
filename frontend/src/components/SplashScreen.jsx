import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import copheLogo from "@/assets/cophe-logo.jpg";

const CLIMB_MS = 900; // bar 0% -> 90%
const MIN_VISIBLE_MS = 1200; // floor: mount -> earliest allowed "complete"
const SAFETY_TIMEOUT_MS = 12000; // stuck-viewer fallback
const SNAP_MS = 200; // bar ~90% -> 100%
const HOLD_MS = 250; // pause at 100% before wipe starts
const WIPE_MS = 520; // circle scale(0) -> scale(1)
const DROP_MS = 380; // drop + fade
const FADE_MS = 200; // Reduce Motion: the whole splash fades out instead of wipe + drop

// The wipe scales a circle across the screen and the drop slides the page down;
// with Reduce Motion on, neither runs.
const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// `steps`: what startup is doing, shown under the bar — [{ label, state }]
// with state "done" | "active" | "pending". Continues the status line of
// Electron's first loading page (public/electron.js loadingHtml), which shows
// the analysis engine starting before this page exists.
export default function SplashScreen({ ready, steps = [] }) {
  const [phase, setPhase] = useState("loading"); // loading|complete|wiping|dropping|done (complete|fading|done with Reduce Motion)
  const [barPct, setBarPct] = useState(0);
  const [wipeOn, setWipeOn] = useState(false);
  const [dropOn, setDropOn] = useState(false);
  const [fadeOn, setFadeOn] = useState(false);
  const [origin, setOrigin] = useState(null); // {x, y} viewport px

  const cupRef = useRef(null);
  const mountedAtRef = useRef(Date.now());

  // Kick off the climb-to-90 and arm the safety timeout.
  useEffect(() => {
    let raf1, raf2;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setBarPct(90));
    });
    const safety = setTimeout(() => {
      setPhase((p) => (p === "loading" ? "complete" : p));
    }, SAFETY_TIMEOUT_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(safety);
    };
  }, []);

  // React to the real readiness signal, honoring the minimum-visible floor.
  useEffect(() => {
    if (!ready) return;
    const elapsed = Date.now() - mountedAtRef.current;
    const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
    const t = setTimeout(() => {
      setPhase((p) => (p === "loading" ? "complete" : p));
    }, wait);
    return () => clearTimeout(t);
  }, [ready]);

  // Snap bar to 100, hold, then start the wipe (or, with Reduce Motion, the fade).
  useEffect(() => {
    if (phase !== "complete") return;
    setBarPct(100);
    const t = setTimeout(() => setPhase(reducedMotion() ? "fading" : "wiping"), HOLD_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // Measure the cup's center, trigger the circle scale.
  useEffect(() => {
    if (phase !== "wiping") return;
    const rect = cupRef.current?.getBoundingClientRect();
    if (rect) {
      setOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }
    let raf1, raf2;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setWipeOn(true));
    });
    const t = setTimeout(() => setPhase("dropping"), WIPE_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(t);
    };
  }, [phase]);

  // Drop + fade the cup/bar block.
  useEffect(() => {
    if (phase !== "dropping") return;
    let raf1, raf2;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setDropOn(true));
    });
    const t = setTimeout(() => setPhase("done"), DROP_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(t);
    };
  }, [phase]);

  // Reduce Motion: fade the whole splash out.
  useEffect(() => {
    if (phase !== "fading") return;
    let raf1, raf2;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setFadeOn(true));
    });
    const t = setTimeout(() => setPhase("done"), FADE_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(t);
    };
  }, [phase]);

  if (phase === "done") return null;

  return (
    <div
      className="splash fixed inset-0 z-[9999] overflow-hidden"
      style={phase === "fading" ? { opacity: fadeOn ? 0 : 1, transition: `opacity ${FADE_MS}ms ease-out` } : undefined}
      data-testid="splash-screen"
    >
      <div
        className="absolute inset-0 transition-[transform,opacity] ease-in"
        style={{
          transform: dropOn ? "translateY(120vh)" : "translateY(0)",
          opacity: dropOn ? 0 : 1,
          transitionDuration: `${DROP_MS}ms`,
        }}
      >
        {/* The logo sits dead centre and never moves: the bar and the status
            lines hang BELOW it (fixed offset), so lines added during startup
            grow downwards. Same geometry as Electron's first loading page
            (public/electron.js loadingHtml), so the hand-over doesn't jump. */}
        <img
          ref={cupRef}
          src={copheLogo}
          alt=""
          draggable={false}
          className="splash-logo absolute left-1/2 top-1/2 h-[88px] w-[88px] -translate-x-1/2 -translate-y-1/2 select-none pointer-events-none rounded-[22px] object-cover"
          data-testid="splash-logo"
        />
        <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center" style={{ top: "calc(50% + 66px)" }}>
        <div className="flex w-[220px] flex-col items-center">
          {/* Not the app's theme tokens: the splash follows the app's
              appearance through prefers-color-scheme (.splash in index.css;
              Electron sets nativeTheme.themeSource from the app's setting,
              which drives that query), exactly like Electron's first page
              (public/electron.js loadingHtml), which cannot read the app's
              theme tokens. Matching each other is what keeps the hand-over
              still; the wipe below then reveals the app in its own theme. */}
          <div className="splash-bar h-[3px] w-full overflow-hidden rounded-sm">
            <div
              className="splash-fill h-full rounded-sm transition-[width] ease-out"
              style={{
                width: `${barPct}%`,
                transitionDuration: `${barPct >= 100 ? SNAP_MS : CLIMB_MS}ms`,
              }}
            />
          </div>
          {steps.length > 0 && (
            <ul className="mt-3.5 w-[270px] text-[12.5px]" data-testid="splash-steps">
              {steps.map((s) => (
                <li
                  key={s.label}
                  className={`flex h-6 items-center gap-2.5 whitespace-nowrap ${
                    s.state === "pending" ? "splash-dim" : s.state === "active" ? "font-medium" : ""
                  }`}
                  data-state={s.state}
                >
                  <span className="grid h-4 w-4 shrink-0 place-items-center">
                    {s.state === "done" ? <Check size={14} strokeWidth={2.2} className="splash-ok" />
                      : s.state === "active" ? <span className="splash-active h-2 w-2 rounded-full" />
                      : <span className="splash-pending h-1.5 w-1.5 rounded-full" />}
                  </span>
                  {s.label}
                </li>
              ))}
            </ul>
          )}
        </div>
        </div>
      </div>

      {origin && (
        <div
          className="fixed rounded-full bg-background transition-transform ease-out"
          style={{
            left: origin.x,
            top: origin.y,
            width: "300vmax",
            height: "300vmax",
            marginLeft: "-150vmax",
            marginTop: "-150vmax",
            transform: wipeOn ? "scale(1)" : "scale(0)",
            transitionDuration: `${WIPE_MS}ms`,
            willChange: "transform",
          }}
        />
      )}
    </div>
  );
}
