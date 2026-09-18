// Rasterizes electron/build-resources/icon.svg into icon.png (512x512) and
// icon.ico (16/32/48/64/128/256 ladder, matching the existing file's entry
// sizes) using Electron itself as the SVG rasterizer — no new dependency.
//
// Run from frontend/: npx electron ../tools/scripts/make-icon.mjs
import { app, BrowserWindow } from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 32, 48, 64, 128, 256];
const RES_DIR = path.join(__dirname, "..", "..", "frontend", "electron", "build-resources");
const SVG_PATH = path.join(RES_DIR, "icon.svg");
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mrlatte-icon-"));

// Trivial pure-Node ICO writer. Windows Vista+ accepts PNG-compressed
// entries at every size (no BMP/DIB encoding needed).
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  let offset = 6 + 16 * count;
  const dirEntries = [];
  const images = [];
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    const dim = size >= 256 ? 0 : size; // 0 means 256 in the ICO format
    entry.writeUInt8(dim, 0); // width
    entry.writeUInt8(dim, 1); // height
    entry.writeUInt8(0, 2); // color count (0 = not palette-based)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // size of image data
    entry.writeUInt32LE(offset, 12); // offset of image data
    offset += png.length;
    dirEntries.push(entry);
    images.push(png);
  }
  return Buffer.concat([header, ...dirEntries, ...images]);
}

function svgForSize(svgSource, size) {
  // Strip the root <svg>'s fixed width/height (keep viewBox) so CSS controls
  // the rendered pixel size exactly, then inline it into a transparent page
  // sized to match — avoiding any <img> decode race.
  const inlineSvg = svgSource.replace(/<svg[^>]*width="512"[^>]*height="512"/, (m) =>
    m.replace(/width="512"/, "").replace(/height="512"/, "")
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}
    svg{display:block;width:${size}px;height:${size}px}
  </style></head><body>${inlineSvg}</body></html>`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rasterizeOnce(svgSource, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: false },
  });
  const htmlPath = path.join(TMP_DIR, `icon-${size}.html`);
  fs.writeFileSync(htmlPath, svgForSize(svgSource, size), "utf8");
  try {
    await win.loadFile(htmlPath);
    await win.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const image = await win.webContents.capturePage();
    return image.resize({ width: size, height: size }).toPNG();
  } finally {
    win.destroy();
  }
}

// Loading back-to-back offscreen windows hits an intermittent ERR_FAILED
// (observed on both data: and file: URLs) — a transient GPU/renderer-process
// hiccup, not a real load failure (the very first window always succeeds).
// Retry with a short backoff rather than chase it further.
async function rasterize(svgSource, size, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await rasterizeOnce(svgSource, size);
    } catch (err) {
      lastErr = err;
      await sleep(300 * (i + 1));
    }
  }
  throw lastErr;
}

async function main() {
  // Without this, Electron's default "quit when the last window closes"
  // behavior kills the whole process the instant rasterize()'s first
  // win.destroy() drops the window count to zero — silently, well before
  // the later sizes ever run.
  app.on("window-all-closed", () => {});

  await app.whenReady();
  const svgSource = fs.readFileSync(SVG_PATH, "utf8");

  const entries = [];
  for (const size of SIZES) {
    const png = await rasterize(svgSource, size);
    entries.push({ size, png });
    console.log(`rasterized ${size}x${size} (${png.length} bytes)`);
  }

  fs.writeFileSync(path.join(RES_DIR, "icon.ico"), buildIco(entries));
  console.log("wrote icon.ico");

  const png512 = await rasterize(svgSource, 512);
  fs.writeFileSync(path.join(RES_DIR, "icon.png"), png512);
  console.log(`wrote icon.png (${png512.length} bytes)`);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  app.quit();
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
