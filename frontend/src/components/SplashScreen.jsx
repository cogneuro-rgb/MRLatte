import { useEffect, useRef, useState } from "react";
import copheLogo from "@/assets/cophe-logo.jpg";

const CLIMB_MS = 900; // bar 0% -> 90%
const MIN_VISIBLE_MS = 1200; // floor: mount -> earliest allowed "complete"
const SAFETY_TIMEOUT_MS = 12000; // stuck-viewer fallback
const SNAP_MS = 200; // bar ~90% -> 100%
const HOLD_MS = 250; // pause at 100% before wipe starts
const WIPE_MS = 520; // circle scale(0) -> scale(1)
const DROP_MS = 380; // drop + fade

export default function SplashScreen({ ready }) {
  const [phase, setPhase] = useState("loading"); // loading|complete|wiping|dropping|done
  const [barPct, setBarPct] = useState(0);
  const [wipeOn, setWipeOn] = useState(false);
  const [dropOn, setDropOn] = useState(false);
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

  // Snap bar to 100, hold, then start the wipe.
  useEffect(() => {
    if (phase !== "complete") return;
    setBarPct(100);
    const t = setTimeout(() => setPhase("wiping"), HOLD_MS);
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

  if (phase === "done") return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-white overflow-hidden" data-testid="splash-screen">
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-4 transition-[transform,opacity] ease-in"
        style={{
          transform: dropOn ? "translateY(120vh)" : "translateY(0)",
          opacity: dropOn ? 0 : 1,
          transitionDuration: `${DROP_MS}ms`,
        }}
      >
        <img
          ref={cupRef}
          src={copheLogo}
          alt=""
          draggable={false}
          className="w-40 h-40 select-none pointer-events-none object-contain"
        />
        <div className="w-40">
          <div className="h-1 w-full bg-[#050505]/15 overflow-hidden">
            <div
              className="h-full bg-[#050505] transition-[width] ease-out"
              style={{
                width: `${barPct}%`,
                transitionDuration: `${barPct >= 100 ? SNAP_MS : CLIMB_MS}ms`,
              }}
            />
          </div>
        </div>
      </div>

      {origin && (
        <div
          className="fixed rounded-full bg-[#050505] transition-transform ease-out"
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
