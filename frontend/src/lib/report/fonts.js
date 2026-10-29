// The app's fonts, embedded in every report so a saved .html reads the same
// anywhere — in the report window, a browser, or on another machine — with no
// font download. Latin subsets only (~70 KB of woff2); anything outside them
// falls back to the system font.
//
// buildReport() is synchronous and called inline in render, so the fonts are
// read once at startup (preloadReportFonts, from index.js) and cached as CSS.
// A report built before that finishes simply uses the system font.

import sans400 from "@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2";
import sans500 from "@fontsource/instrument-sans/files/instrument-sans-latin-500-normal.woff2";
import sans600 from "@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2";
import mono400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2";

const FACES = [
  { family: "Instrument Sans", weight: 400, url: sans400 },
  { family: "Instrument Sans", weight: 500, url: sans500 },
  { family: "Instrument Sans", weight: 600, url: sans600 },
  { family: "JetBrains Mono", weight: 400, url: mono400 },
];

let fontCss = "";
let loading = null;

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** The @font-face rules to embed in a report, or "" until they've loaded. */
export function reportFontCss() {
  return fontCss;
}

/** Reads the bundled font files once. Never rejects: on failure reports keep
 * the system font. */
export function preloadReportFonts() {
  if (loading || typeof fetch !== "function") return loading;
  loading = Promise.all(FACES.map(async (f) => {
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`${f.url}: ${res.status}`);
    const b64 = toBase64(await res.arrayBuffer());
    return `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};font-display:swap;`
      + `src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
  }))
    .then((rules) => { fontCss = rules.join("\n"); })
    .catch(() => {});
  return loading;
}
