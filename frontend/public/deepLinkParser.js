"use strict";
// mrlatte:// deep-link parser.
//
// A small, dependency-free, pure(ish) function — no Electron, no IPC, no UI —
// so it can be unit-tested with plain `node` and so the security-sensitive
// parsing logic for an externally-triggered URL lives in one auditable place
// instead of being inline in electron.js.
//
// Threat model: ANY web page can trigger a mrlatte:// URL (an <a href>, a
// window.location assignment, an <iframe>, ...), so this input is fully
// untrusted, same as a URL bar entry. In particular, on Windows merely
// TOUCHING a UNC/network path (\\server\share\..., //server/...) — including
// fs.existsSync — can make the OS silently send the user's NTLM credentials
// to that remote host. A malicious page could trigger that with no file ever
// being opened. So UNC/network-path rejection here is pure string logic that
// runs BEFORE any filesystem call, on both the raw and the once-more-decoded
// form of the path (to catch double percent-encoding).
//
// electron.js is the only caller: it hands this whatever raw string the OS
// gave it (an argv entry on Windows, an 'open-url' URL on macOS) and treats
// the result as the ONLY thing it's allowed to open — never executed, never
// shelled out, never used to navigate.
const fs = require("fs");
const path = require("path");

// Mirrors what Explorer file-association quick-open already accepts (used to
// be a private regex duplicated in electron.js's niftiPathFromArgv) — single
// source of truth for "what MRLatte can open" now lives here.
const ALLOWED_EXT_RE = /\.(nii|nii\.gz|gz)$/i;

// A leading "\\", "//", or a mix of the two (raw or percent-encoded) is a
// UNC/network path. Checked before anything else touches the string.
function looksLikeUncOrNetworkPath(candidate) {
  if (!candidate) return false;
  // Collapse just the encoded slash forms so `%5C%5Cserver...` and
  // `\\server...` are caught by the same check, without fully decoding
  // (full decoding happens once, safely, by the caller before this runs).
  const collapsed = candidate.replace(/%5c/gi, "\\").replace(/%2f/gi, "/");
  return /^[\\/]{2}/.test(collapsed);
}

function decodeSafely(s) {
  try {
    return decodeURIComponent(s);
  } catch (_e) {
    return s;
  }
}

/**
 * @param {string} urlString Raw `mrlatte://...` URL exactly as handed to us
 *   by the OS — untrusted.
 * @returns {{ok:true, path:string} | {ok:false, reason:string}}
 */
function parseMrlatteDeepLink(urlString) {
  if (typeof urlString !== "string" || !urlString) {
    return { ok: false, reason: "empty-url" };
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (_e) {
    return { ok: false, reason: "malformed-url" };
  }

  if (parsed.protocol !== "mrlatte:") {
    return { ok: false, reason: `wrong-protocol:${parsed.protocol}` };
  }

  // `mrlatte://open?path=...` parses with the authority position ("open") as
  // hostname. `mrlatte:open?path=...` (no //) has no authority at all, so
  // fall back to the first path segment — both spellings name the same
  // action. Anything else is rejected outright; we never guess.
  const action =
    (parsed.hostname || "").toLowerCase() ||
    (parsed.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
  if (action !== "open") {
    return { ok: false, reason: `unknown-action:${action || "(none)"}` };
  }

  const rawPath = parsed.searchParams.get("path");
  if (!rawPath) {
    return { ok: false, reason: "missing-path" };
  }

  // UNC/network-path check FIRST — on the value as handed back by
  // URLSearchParams (decoded once) AND decoded a second time (catches
  // double-encoding, e.g. %255C%255C) — before ANY other validation and
  // long before any filesystem call. See module header.
  if (looksLikeUncOrNetworkPath(rawPath) || looksLikeUncOrNetworkPath(decodeSafely(rawPath))) {
    return { ok: false, reason: "unc-or-network-path" };
  }

  const candidate = rawPath;

  // Platform-aware absolute-path check: Windows needs a drive letter
  // (C:\...) — a rootless absolute path (\foo\bar.nii, no drive) is
  // "absolute" by Node's own definition but not a path we can safely resolve
  // without inheriting whatever the current drive happens to be, so it's
  // rejected too. macOS/Linux (the 'open-url' path) just need a POSIX
  // absolute path; the UNC check above already rejected a leading "//".
  const isWindows = process.platform === "win32";
  const pathImpl = isWindows ? path.win32 : path.posix;
  if (!pathImpl.isAbsolute(candidate)) {
    return { ok: false, reason: "relative-path" };
  }
  if (isWindows && !/^[a-zA-Z]:[\\/]/.test(candidate)) {
    return { ok: false, reason: "not-a-drive-path" };
  }

  if (!ALLOWED_EXT_RE.test(candidate)) {
    return { ok: false, reason: "unsupported-extension" };
  }

  // Filesystem check is last on purpose — everything above is string-only.
  try {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      return { ok: false, reason: "not-found" };
    }
  } catch (_e) {
    return { ok: false, reason: "not-found" };
  }

  return { ok: true, path: candidate };
}

module.exports = { parseMrlatteDeepLink, ALLOWED_EXT_RE };
