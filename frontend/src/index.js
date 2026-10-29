import React from "react";
import ReactDOM from "react-dom/client";
// Fonts ship with the app (OFL-1.1): the desktop build runs offline and must
// not call out to a font CDN.
import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@/index.css";
import App from "@/App";
import { preloadReportFonts } from "@/lib/report/fonts";
import { ThemeProvider } from "@/hooks/use-theme";
import HeaderViewerPage from "@/pages/HeaderViewerPage";

// #/header = the standalone NIfTI header window (Explorer right-click →
// MRLatte › View NIfTI header; electron.js --header mode). It must not mount
// <App/>: App's providers call the backend on startup, and that window runs
// without one.
const isHeaderViewer = window.location.hash.startsWith("#/header");

// Reports embed the app's fonts; read them once, in the background.
preloadReportFonts();

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    {isHeaderViewer ? (
      <ThemeProvider>
        <HeaderViewerPage />
      </ThemeProvider>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
