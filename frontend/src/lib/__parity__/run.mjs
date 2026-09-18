// Parity-capture harness for Task 0c.
//
// Runs the REAL, unmodified computeAtlasOverlap (volumeAnalysis.js) and
// computeLesionVolume (lesionReport.js) — the functions about to be replaced
// by LQTpy — against a fixed set of synthetic lesion fixtures x atlases, and
// writes the full output as deterministic, pretty-printed JSON to golden.json
// next to this file. See README.md for how to run this and why it's built
// this way.
//
// Run with:  cd frontend && node --import ./src/lib/__parity__/register-hook.mjs ./src/lib/__parity__/run.mjs
import fs from "node:fs";
import path from "node:path";
import { computeLesionVolume } from "../lesionReport.js";
import { computeAtlasOverlap } from "../volumeAnalysis.js";
import { buildFixtures } from "./fixtures.mjs";
import { loadAtlases } from "./atlases.mjs";
import { affineDet3 } from "./geom.mjs";

const OUT_PATH = path.join(import.meta.dirname, "golden.json");

function round(n, dp = 6) {
  if (typeof n !== "number" || !Number.isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function roundDeep(v, dp = 6) {
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, dp));
  if (typeof v === "number") return round(v, dp);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = roundDeep(v[k], dp);
    return out;
  }
  return v;
}

function main() {
  const fixtures = buildFixtures();
  const atlases = loadAtlases();

  const goldenFixtures = {};
  for (const f of fixtures) {
    const { vol, description } = f;
    const [, nx, ny, nz] = vol.dimsRAS;

    const lesionVolume = computeLesionVolume(vol);
    // Cross-check only: affineDet3 itself is module-private in
    // lesionReport.js and is not exported, so it can't be called directly
    // without editing production code (out of scope — see README.md). This
    // recomputes the determinant of the SAME affine we constructed, using
    // the identical formula, purely to (a) sanity-check computeLesionVolume's
    // mm3 = voxelCount * |det| relationship and (b) record a determinant for
    // the empty fixture where voxelCount is 0 and mm3 can't be used to infer it.
    const affineDet3Check = affineDet3(vol.matRAS);

    const overlapByAtlas = {};
    for (const atlas of atlases) {
      const { rows, stats } = computeAtlasOverlap(vol, atlas.vol, atlas.labelMap);
      overlapByAtlas[atlas.id] = { rows: roundDeep(rows), stats };
    }

    goldenFixtures[f.name] = {
      description,
      grid: { dims: [nx, ny, nz], voxelCount: nx * ny * nz },
      lesionVolume: roundDeep(lesionVolume),
      affineDet3Check: round(affineDet3Check),
      overlapByAtlas,
    };
  }

  const golden = {
    capturedFrom: {
      note: "Golden values from the JS engine, captured before the LQTpy migration (Task 0c). See README.md.",
      functions: [
        "frontend/src/lib/volumeAnalysis.js:computeAtlasOverlap",
        "frontend/src/lib/lesionReport.js:computeLesionVolume",
        "frontend/src/lib/lesionReport.js:affineDet3 (private; cross-checked only, see affineDet3Check per fixture)",
      ],
    },
    atlases: atlases.map((a) => ({
      id: a.id,
      name: a.name,
      source: a.source,
      file: a.file,
      dims: a.vol.dims,
      matRAS: a.vol.matRAS,
      labelCount: Object.keys(a.labelMap || {}).length,
    })),
    fixtures: goldenFixtures,
  };

  const json = JSON.stringify(golden, null, 2) + "\n";
  fs.writeFileSync(OUT_PATH, json, "utf8");

  // Console summary for the transcript / report.
  console.log(`Wrote ${OUT_PATH} (${json.length} bytes)`);
  for (const [name, f] of Object.entries(goldenFixtures)) {
    console.log(
      `  ${name}: voxelCount=${f.lesionVolume?.voxelCount} mm3=${f.lesionVolume?.mm3} ` +
        `affineDet3=${f.affineDet3Check}`
    );
  }
}

main();
