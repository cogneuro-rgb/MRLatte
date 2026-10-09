"use strict";
// Guard against packaging an installer with a stale renderer.
//
// The installer does NOT take its React app from frontend/build. It takes it
// from the staged copy (MRLatte-build/MRLatte/frontend_build, an electron-
// builder extraResource), which only tools/build/assemble-bundle.ps1 refreshes.
// So `yarn dist:win` on its own happily rebuilds frontend/build and then ships
// whatever was staged last time -- a new main process with an old renderer.
// That is how the first 0.3.1 installer went out without any 0.3.1 UI code.
//
// Two commands close that gap:
//
//   node tools/build/staged-frontend.js stamp   (run by `yarn build`)
//       writes build/source-fingerprint.json: a hash of everything the renderer
//       is built from. The assemble step copies build/ to the staged folder, so
//       the fingerprint travels with the bundle it describes.
//
//   node tools/build/staged-frontend.js check   (run by every `yarn dist:*`)
//       recomputes the hash from the current source and fails if the staged
//       bundle was built from anything else.
//
// The comparison is on SOURCE, not on the built bundles: two builds of the same
// source are not byte-identical (source maps on/off, env), so comparing
// frontend/build against the staged copy would fail even when both are right.
//
// Only the overall hash is written -- no file list -- so the shipped file says
// nothing about the source tree.
//
// Dependency-free CommonJS, like deepLinkParser.js, so it runs with plain node
// before anything is installed or built.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STAMP_NAME = "source-fingerprint.json";

// Everything `craco build` reads, relative to frontend/. Directories are walked.
const INPUTS = [
  "src",
  "public",
  "plugins",
  "package.json",
  "yarn.lock",
  "craco.config.js",
  "tailwind.config.js",
  "postcss.config.js",
  "jsconfig.json",
  "components.json",
  ".env.production",
];

// public/atlases is excluded from the staged copy too (atlases ship once, under
// modules/atlases), so it has no say in whether the staged renderer is current.
const EXCLUDED_DIRS = new Set(["public/atlases"]);

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  let st;
  try {
    st = fs.statSync(abs);
  } catch (_e) {
    return; // an optional input that does not exist contributes nothing
  }
  if (st.isDirectory()) {
    if (EXCLUDED_DIRS.has(rel.split(path.sep).join("/"))) return;
    for (const name of fs.readdirSync(abs).sort()) walk(root, path.join(rel, name), out);
  } else if (st.isFile()) {
    out.push(rel);
  }
}

/** Hash of every renderer input: sorted relative paths plus file contents. */
function fingerprint(frontendDir) {
  const files = [];
  for (const input of INPUTS) walk(frontendDir, input, files);
  files.sort();
  const hash = crypto.createHash("sha256");
  for (const rel of files) {
    hash.update(rel.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(frontendDir, rel)));
    hash.update("\0");
  }
  return { fingerprint: hash.digest("hex"), files: files.length };
}

function readVersion(frontendDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(frontendDir, "package.json"), "utf8")).version || null;
  } catch (_e) {
    return null;
  }
}

/** The staged renderer folder, read from the same package.json electron-builder uses. */
function stagedDir(frontendDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(frontendDir, "package.json"), "utf8"));
  const entry = ((pkg.build && pkg.build.extraResources) || []).find((r) => r && r.to === "frontend_build");
  if (!entry) throw new Error('package.json build.extraResources has no entry with to: "frontend_build"');
  return path.resolve(frontendDir, entry.from);
}

function stamp(frontendDir) {
  const buildDir = path.join(frontendDir, "build");
  if (!fs.existsSync(path.join(buildDir, "index.html"))) {
    throw new Error(`${buildDir} has no index.html -- run the frontend build before stamping it`);
  }
  const fp = fingerprint(frontendDir);
  const record = {
    fingerprint: fp.fingerprint,
    files: fp.files,
    version: readVersion(frontendDir),
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(buildDir, STAMP_NAME), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/**
 * @returns {{ok: true, staged: object} | {ok: false, reason: string, staged: object|null, current: object}}
 */
function check(frontendDir, staged = stagedDir(frontendDir)) {
  const current = { ...fingerprint(frontendDir), version: readVersion(frontendDir) };
  if (!fs.existsSync(path.join(staged, "index.html"))) {
    return { ok: false, reason: "missing", staged: null, current };
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(staged, STAMP_NAME), "utf8"));
  } catch (_e) {
    return { ok: false, reason: "unstamped", staged: null, current };
  }
  if (record.fingerprint !== current.fingerprint) {
    return { ok: false, reason: "stale", staged: record, current };
  }
  return { ok: true, staged: record, current };
}

const REASONS = {
  missing: "there is no staged renderer at all",
  unstamped: "the staged renderer has no source fingerprint (it was staged before this check existed)",
  stale: "the staged renderer was built from different source than what is here now",
};

function explain(result, staged) {
  const short = (h) => (h ? h.slice(0, 12) : "-");
  const lines = [
    "",
    "[staged-frontend] NOT PACKAGING: " + REASONS[result.reason] + ".",
    "",
    "  staged copy : " + staged,
  ];
  if (result.staged) {
    lines.push(`                built ${result.staged.builtAt}, version ${result.staged.version}, source ${short(result.staged.fingerprint)}`);
  }
  lines.push(
    `  this source : version ${result.current.version}, source ${short(result.current.fingerprint)} (${result.current.files} files)`,
    "",
    "  The installer takes its renderer from the staged copy, not from frontend\\build,",
    "  so packaging now would ship an old UI inside a new app.",
    "",
    "  Fix: run build-minimal.bat (or build-full.bat) from the repository root. To refresh",
    "  only the staged copy:  powershell -File tools\\build\\assemble-bundle.ps1",
    ""
  );
  return lines.join("\n");
}

function main(argv) {
  const frontendDir = path.resolve(__dirname, "..", "..", "frontend");
  const command = argv[2];
  if (command === "stamp") {
    const record = stamp(frontendDir);
    console.log(`[staged-frontend] stamped build: source ${record.fingerprint.slice(0, 12)} (${record.files} files, version ${record.version})`);
    return 0;
  }
  if (command === "check") {
    const staged = stagedDir(frontendDir);
    const result = check(frontendDir, staged);
    if (result.ok) {
      console.log(`[staged-frontend] staged renderer matches the source (${result.staged.fingerprint.slice(0, 12)}, version ${result.staged.version}).`);
      return 0;
    }
    console.error(explain(result, staged));
    return 1;
  }
  console.error("usage: node tools/build/staged-frontend.js <stamp|check>");
  return 2;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (e) {
    console.error("[staged-frontend] " + e.message);
    process.exit(1);
  }
}

module.exports = { fingerprint, stamp, check, stagedDir, STAMP_NAME };
