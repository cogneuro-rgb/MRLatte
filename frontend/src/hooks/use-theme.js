import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "mrlatte-theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";
const ThemeContext = createContext(null);

// "system" (also what an unset or unknown stored value means) | "light" | "dark".
function readAppearance() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch (_e) {
    return "system";
  }
}

// Does the OS (in the desktop app, nativeTheme — see setAppearance) prefer
// light right now? Dark where matchMedia is missing: it's the app's original look.
function systemPrefersLight() {
  try {
    return !!window.matchMedia?.(LIGHT_QUERY).matches;
  } catch (_e) {
    return false;
  }
}

// Dark is the app's original/default look and needs no class (see :root in
// index.css) — only "light" ever gets applied to <html>. Kept in sync with
// the anti-flash inline script in public/index.html, which must apply the
// same class before first paint.
function applyThemeClass(theme) {
  document.documentElement.classList.toggle("light", theme === "light");
}

export function ThemeProvider({ children }) {
  const [appearance, setAppearanceState] = useState(readAppearance);
  const [systemLight, setSystemLight] = useState(systemPrefersLight);

  useEffect(() => {
    const mq = window.matchMedia?.(LIGHT_QUERY);
    if (!mq?.addEventListener) return undefined;
    const onChange = (e) => setSystemLight(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // The resolved look, "light" | "dark" — what everything else keys off.
  const theme = appearance === "system" ? (systemLight ? "light" : "dark") : appearance;

  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  // Desktop app: the main process mirrors this into nativeTheme.themeSource, so
  // the window frame and prefers-color-scheme follow the same choice. Runs on
  // mount too, so a stored choice reaches the main process at startup.
  useEffect(() => {
    window.mrlatte?.setAppearance?.(appearance);
  }, [appearance]);

  const setAppearance = useCallback((next) => {
    const mode = next === "light" || next === "dark" ? next : "system";
    setAppearanceState(mode);
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (_e) { /* storage unavailable */ }
  }, []);

  // Existing callers pick an explicit look: "light" | "dark".
  const toggleTheme = useCallback(() => {
    setAppearance(theme === "dark" ? "light" : "dark");
  }, [theme, setAppearance]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme: setAppearance, toggleTheme, appearance, setAppearance }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
