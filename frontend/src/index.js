import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";
import { ThemeProvider } from "@/hooks/use-theme";
import HeaderViewerPage from "@/pages/HeaderViewerPage";

// #/header = the standalone NIfTI header window (Explorer right-click →
// MRLatte › View NIfTI header; electron.js --header mode). It must not mount
// <App/>: App's providers call the backend on startup, and that window runs
// without one.
const isHeaderViewer = window.location.hash.startsWith("#/header");

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
