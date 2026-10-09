"use strict";
// Plain-Node tests for staged-frontend.js -- no build, no install.
//
//   node tools/build/staged-frontend.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { fingerprint, stamp, check, stagedDir, STAMP_NAME } = require("./staged-frontend");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A miniature repo: frontend/ with source + a build, and the staged folder
// electron-builder would package, wired together through package.json exactly
// as in the real one.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staged-frontend-"));
  const frontend = path.join(root, "repo", "frontend");
  write(path.join(frontend, "package.json"), JSON.stringify({
    version: "1.0.0",
    build: { extraResources: [{ from: "../../staged/frontend_build", to: "frontend_build" }] },
  }));
  write(path.join(frontend, "src", "App.jsx"), "export default 1;");
  write(path.join(frontend, "public", "electron.js"), "// main");
  write(path.join(frontend, "public", "atlases", "big.nii"), "atlas v1");
  write(path.join(frontend, "build", "index.html"), "<html>");
  return { root, frontend, staged: path.join(root, "staged", "frontend_build") };
}

// What assemble-bundle.ps1 does with the build: copy it to the staged folder.
function stage(repo) {
  fs.rmSync(repo.staged, { recursive: true, force: true });
  fs.cpSync(path.join(repo.frontend, "build"), repo.staged, { recursive: true });
}

const tests = {
  "the staged folder comes from package.json's extraResources"() {
    const repo = makeRepo();
    assert.strictEqual(stagedDir(repo.frontend), repo.staged);
  },

  "nothing staged yet is refused"() {
    const repo = makeRepo();
    stamp(repo.frontend);
    assert.strictEqual(check(repo.frontend).reason, "missing");
  },

  "a renderer staged before the check existed is refused"() {
    const repo = makeRepo();
    stage(repo); // no stamp in build/ yet
    assert.strictEqual(check(repo.frontend).reason, "unstamped");
  },

  "build, stage, package: accepted"() {
    const repo = makeRepo();
    stamp(repo.frontend);
    stage(repo);
    const result = check(repo.frontend);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.staged.version, "1.0.0");
  },

  "the 0.3.1 mistake -- source changed, build redone, staging skipped: refused"() {
    const repo = makeRepo();
    stamp(repo.frontend);
    stage(repo);
    write(path.join(repo.frontend, "src", "App.jsx"), "export default 2;"); // new UI code
    stamp(repo.frontend); // `yarn dist:win` rebuilds frontend/build ...
    const result = check(repo.frontend); // ... but the staged copy is the old one
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "stale");
    stage(repo); // running the assemble step fixes it
    assert.strictEqual(check(repo.frontend).ok, true);
  },

  "a version bump alone needs a re-stage (the version is baked into the UI)"() {
    const repo = makeRepo();
    stamp(repo.frontend);
    stage(repo);
    const pkgPath = path.join(repo.frontend, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.version = "1.0.1";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
    assert.strictEqual(check(repo.frontend).reason, "stale");
  },

  "added, removed and renamed files all change the fingerprint"() {
    const repo = makeRepo();
    const base = fingerprint(repo.frontend).fingerprint;
    write(path.join(repo.frontend, "src", "New.jsx"), "x");
    const added = fingerprint(repo.frontend).fingerprint;
    assert.notStrictEqual(added, base);
    fs.renameSync(path.join(repo.frontend, "src", "New.jsx"), path.join(repo.frontend, "src", "Renamed.jsx"));
    assert.notStrictEqual(fingerprint(repo.frontend).fingerprint, added);
    fs.rmSync(path.join(repo.frontend, "src", "Renamed.jsx"));
    assert.strictEqual(fingerprint(repo.frontend).fingerprint, base);
  },

  "atlases and the build output itself do not affect the fingerprint"() {
    const repo = makeRepo();
    const base = fingerprint(repo.frontend).fingerprint;
    write(path.join(repo.frontend, "public", "atlases", "big.nii"), "atlas v2");
    write(path.join(repo.frontend, "build", "static", "main.js"), "bundle");
    assert.strictEqual(fingerprint(repo.frontend).fingerprint, base);
  },

  "stamping needs a build to stamp"() {
    const repo = makeRepo();
    fs.rmSync(path.join(repo.frontend, "build"), { recursive: true });
    assert.throws(() => stamp(repo.frontend), /no index\.html/);
  },

  "the shipped stamp names no source files"() {
    const repo = makeRepo();
    stamp(repo.frontend);
    const text = fs.readFileSync(path.join(repo.frontend, "build", STAMP_NAME), "utf8");
    assert.ok(!text.includes("App.jsx"));
    assert.deepStrictEqual(Object.keys(JSON.parse(text)).sort(), ["builtAt", "files", "fingerprint", "version"]);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log("  ok   " + name);
  } catch (e) {
    failed++;
    console.log("  FAIL " + name + "\n       " + (e && e.message));
  }
}
console.log(`\n${Object.keys(tests).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
