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

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("SOME TESTS FAILED");
  process.exit(1);
}
