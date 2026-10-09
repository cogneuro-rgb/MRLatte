"use strict";
// Plain-Node unit tests for deepLinkParser.js — no Electron, no build step.
//
//   cd frontend && node public/deepLinkParser.test.js
//
// (deepLinkParser.js is a dependency-free CommonJS module, unlike the
// `@/`-aliased ES modules under src/lib that need the __parity__ harness's
// --import hook — see src/lib/__parity__/README.md for that case.)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseMrlatteDeepLink } = require("./deepLinkParser");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`NOT OK - ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

// Scratch files the "valid" cases point at — a missing file must be rejected
// even when everything else about the URL is well-formed, so the happy-path
// cases need something real on disk to point at.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mrlatte-deeplink-test-"));
const validNii = path.join(tmpDir, "scan.nii");
const validNiiWithSpace = path.join(tmpDir, "my scan.nii.gz");
fs.writeFileSync(validNii, "");
fs.writeFileSync(validNiiWithSpace, "");

function urlFor(rawPathValue) {
  // Build the query string by hand (not URLSearchParams.set) so callers can
  // pass already-encoded or deliberately-malformed strings verbatim.
  return `mrlatte://open?path=${rawPathValue}`;
}

test("valid local path", () => {
  const r = parseMrlatteDeepLink(urlFor(encodeURIComponent(validNii)));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.path, validNii);
});

test("URL-encoded spaces", () => {
  const r = parseMrlatteDeepLink(urlFor(encodeURIComponent(validNiiWithSpace)));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.path, validNiiWithSpace);
});

test("UNC path, plain backslashes", () => {
  const r = parseMrlatteDeepLink(urlFor("\\\\evil-server\\share\\foo.nii"));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unc-or-network-path");
});

test("UNC path, forward slashes", () => {
  const r = parseMrlatteDeepLink(urlFor("//evil-server/share/foo.nii"));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unc-or-network-path");
});

test("UNC path, percent-encoded", () => {
  const r = parseMrlatteDeepLink(urlFor("%5C%5Cevil-server%5Cshare%5Cfoo.nii"));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unc-or-network-path");
});

test("UNC path, double percent-encoded", () => {
  const r = parseMrlatteDeepLink(urlFor("%255C%255Cevil-server%255Cshare%255Cfoo.nii"));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unc-or-network-path");
});

test("relative path", () => {
  const r = parseMrlatteDeepLink(urlFor(encodeURIComponent("foo.nii")));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "relative-path");
});

test("rootless absolute path (no drive letter)", () => {
  const r = parseMrlatteDeepLink(urlFor(encodeURIComponent("\\foo\\bar.nii")));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-a-drive-path");
});

test("missing file", () => {
  const missing = path.join(tmpDir, "does-not-exist.nii");
  const r = parseMrlatteDeepLink(urlFor(encodeURIComponent(missing)));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-found");
});

test("wrong extension", () => {
  const exe = path.join(tmpDir, "evil.exe");
  fs.writeFileSync(exe, "");
  const r = parseMrlatteDeepLink(urlFor(encodeURIComponent(exe)));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unsupported-extension");
});

test("wrong action", () => {
  const r = parseMrlatteDeepLink(`mrlatte://execute?path=${encodeURIComponent(validNii)}`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unknown-action:execute");
});

test("extra unknown host", () => {
  const r = parseMrlatteDeepLink(`mrlatte://not-open-at-all?path=${encodeURIComponent(validNii)}`);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith("unknown-action:"));
});

test("missing path parameter entirely", () => {
  const r = parseMrlatteDeepLink("mrlatte://open?other=1");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "missing-path");
});

test("malformed URL", () => {
  const r = parseMrlatteDeepLink("not a url at all ::::");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "malformed-url");
});

test("wrong protocol entirely", () => {
  const r = parseMrlatteDeepLink(`https://evil.example/open?path=${encodeURIComponent(validNii)}`);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith("wrong-protocol"));
});

test("non-string input", () => {
  const r = parseMrlatteDeepLink(undefined);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "empty-url");
});

// ---- base + overlay form ----
const enc = encodeURIComponent;

test("base + one overlay, type auto", () => {
  const r = parseMrlatteDeepLink(`mrlatte://open?base=${enc(validNii)}&overlay=${enc(validNiiWithSpace)}`);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.request, { base: validNii, overlays: [{ path: validNiiWithSpace, type: null }] });
});

test("several overlays; overlaytype applies by position, auto/missing = null", () => {
  const r = parseMrlatteDeepLink(
    `mrlatte://open?base=${enc(validNii)}&overlay=${enc(validNiiWithSpace)}&overlay=${enc(validNii)}&overlay=${enc(validNii)}`
    + `&overlaytype=Activation&overlaytype=auto`);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.request.overlays.map((o) => o.type), ["activation", null, null]);
});

test("overlays without a base", () => {
  const r = parseMrlatteDeepLink(`mrlatte://open?overlay=${enc(validNii)}&overlaytype=lesion`);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.request, { base: null, overlays: [{ path: validNii, type: "lesion" }] });
});

test("base alone", () => {
  const r = parseMrlatteDeepLink(`mrlatte://open?base=${enc(validNii)}`);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.request, { base: validNii, overlays: [] });
});

test("path mixed with base/overlay is rejected", () => {
  const r = parseMrlatteDeepLink(`mrlatte://open?path=${enc(validNii)}&overlay=${enc(validNii)}`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "path-mixed-with-base-or-overlay");
});

test("two bases rejected", () => {
  const r = parseMrlatteDeepLink(`mrlatte://open?base=${enc(validNii)}&base=${enc(validNii)}`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "more-than-one-base");
});

test("unknown overlaytype rejected", () => {
  const r = parseMrlatteDeepLink(`mrlatte://open?overlay=${enc(validNii)}&overlaytype=exe`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unknown-overlay-type:exe");
});

test("more overlaytypes than overlays rejected", () => {
  const r = parseMrlatteDeepLink(`mrlatte://open?overlay=${enc(validNii)}&overlaytype=lesion&overlaytype=roi`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "more-overlaytypes-than-overlays");
});

test("too many files rejected", () => {
  const many = Array.from({ length: 9 }, () => `overlay=${enc(validNii)}`).join("&");
  const r = parseMrlatteDeepLink(`mrlatte://open?${many}`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "too-many-files");
});

test("one missing overlay fails the whole link", () => {
  const r = parseMrlatteDeepLink(`mrlatte://open?base=${enc(validNii)}&overlay=${enc(path.join(tmpDir, "nope.nii"))}`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-found");
});

test("a UNC overlay rejects the link with NO filesystem call for any path", () => {
  // Record every filesystem probe the parser makes. A network path anywhere
  // in the link must stop it before it touches the disk for ANY path — even
  // the perfectly valid base listed first.
  const realExists = fs.existsSync, realStat = fs.statSync;
  const touched = [];
  fs.existsSync = (p) => { touched.push(p); return realExists(p); };
  fs.statSync = (p, ...rest) => { touched.push(p); return realStat(p, ...rest); };
  try {
    const r = parseMrlatteDeepLink(`mrlatte://open?base=${enc(validNii)}&overlay=${enc("\\\\evil-server\\share\\x.nii")}`);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "unc-or-network-path");
    assert.deepStrictEqual(touched, []);
  } finally {
    fs.existsSync = realExists;
    fs.statSync = realStat;
  }
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("SOME TESTS FAILED");
  process.exit(1);
}
