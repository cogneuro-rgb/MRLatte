// The MNI menu's saved coordinates (GotoMniInput). They last for the session —
// sessionStorage keeps them across a reload of this window but not into a new
// run of the app — and travel in workspace files (Dashboard save/restore).
// They used to sit in localStorage and reappear in every later session.
const KEY = "mrlatte.mniLibrary";
const OLD_KEY = "mrlatte.mniLibrary";   // the same name, formerly in localStorage

let items = null;
const listeners = new Set();

function load() {
  if (items) return items;
  try { localStorage.removeItem(OLD_KEY); } catch (_e) { /* storage unavailable */ }
  try { items = JSON.parse(sessionStorage.getItem(KEY)) || []; } catch (_e) { items = []; }
  if (!Array.isArray(items)) items = [];
  return items;
}

export function getMniLibrary() {
  return load();
}

export function setMniLibrary(next) {
  items = Array.isArray(next) ? next.filter((s) => s && Array.isArray(s.coord) && s.coord.length >= 3) : [];
  try { sessionStorage.setItem(KEY, JSON.stringify(items)); } catch (_e) { /* storage unavailable */ }
  listeners.forEach((fn) => fn());
}

export function subscribeMniLibrary(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
