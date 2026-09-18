import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "mrlatte-theme";
const ThemeContext = createContext(null);

// Dark is the app's original/default look and needs no class (see :root in
// index.css) — only "light" ever gets applied to <html>. Kept in sync with
// the anti-flash inline script in public/index.html, which must apply the
// same class before first paint.
function applyThemeClass(theme) {
  document.documentElement.classList.toggle("light", theme === "light");
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
    } catch (_e) {
      return "dark";
    }
  });

  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  const setTheme = useCallback((next) => {
    setThemeState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch (_e) { /* storage unavailable */ }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
