/**
 * Save a PNG of the scene.
 *
 * Backs the saveScreenshot entry of NiivueViewer's imperative handle. Method
 * name, signature and behaviour are unchanged — this is a relocation.
 *
 * @param {object} ctx  viewer context (see lib/viewer/context.js); uses
 *                      nvRef, canvasRef.
 */
export function createScreenshotApi(ctx) {
  const { nvRef, canvasRef } = ctx;

  return {
    // Save a PNG of the scene. The GL canvas already contains the colorbar and
    // orientation labels (they're drawn into it), so those come for free. When
    // a `caption` is given, composite the canvas onto a slightly taller 2D
    // canvas with a caption bar (scan label + timestamp) for report/slide use;
    // otherwise fall back to NiiVue's native saveScene.
    saveScreenshot: (opts = {}) => {
      const nv = nvRef.current;
      if (!nv) return;
      const caption = opts.caption;
      if (!caption) { nv.saveScene("mrlatte-scene.png"); return; }
      try {
        nv.drawScene(); // ensure the backing buffer is current for readback
        const src = canvasRef.current;
        if (!src) { nv.saveScene("mrlatte-scene.png"); return; }
        const capH = Math.max(30, Math.round(src.height * 0.05));
        const out = document.createElement("canvas");
        out.width = src.width;
        out.height = src.height + capH;
        const ctx = out.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(src, 0, 0);            // GL canvas (same synchronous frame)
        ctx.fillStyle = "#111";
        ctx.fillRect(0, src.height, out.width, capH);
        const fontPx = Math.round(capH * 0.42);
        ctx.font = `${fontPx}px sans-serif`;
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#e5e5e5";
        ctx.textAlign = "left";
        ctx.fillText(String(caption).slice(0, 80), 14, src.height + capH / 2);
        ctx.textAlign = "right";
        ctx.fillStyle = "#a1a1a1";
        ctx.fillText(new Date().toLocaleString(), out.width - 14, src.height + capH / 2);
        out.toBlob((blob) => {
          if (!blob) { nv.saveScene("mrlatte-scene.png"); return; }
          const url = URL.createObjectURL(blob);
          try {
            const a = document.createElement("a");
            a.href = url;
            a.download = "mrlatte-scene.png";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } finally {
            URL.revokeObjectURL(url);
          }
        }, "image/png");
      } catch (_e) {
        nv.saveScene("mrlatte-scene.png");
      }
    },
  };
}
