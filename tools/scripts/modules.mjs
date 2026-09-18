#!/usr/bin/env node
// MRLatte module CLI — `yarn modules list | add <id> | add --all | verify | remove <id>`
//
// Dev-side counterpart to backend/routers/modules.py. Both read the SAME
// modules/manifest.json and resolve the SAME module root, so a dev checkout and
// a packaged install never disagree about what is present.
//
// Deliberate properties, in rough order of importance:
//
//   1. `remove` NEVER deletes outside the module root. A module can still resolve
//      OUTSIDE the root via an explicit env override (ATLAS_DIR,
//      GLOBAL_TRACT_FILE, …); anything resolving there — including the ~843 MB of
//      user-supplied, unrecoverable slot data — was never installed by this tool
//      and is refused, loudly.
//   2. Nothing is installed without a recorded sha256 match. Bytes land in
//      `<file>.part`, every declared file is hashed, and only when ALL match are
//      the parts renamed into place — same discipline as the backend installer.
//      This FAILS CLOSED: a file the manifest declares no sha256 for is refused
//      before anything is downloaded. Absence is never read as permission; the
//      only way past is an explicit `"sha256": "unverified"`, which is announced
//      loudly and recorded as unverified in the ledger.
//   3. `slot` modules are never fetched. They are user-supplied by licence, not
//      by omission, so `add` refuses them with the manifest's dropInHint.
//   4. No dependencies. Plain Node (fetch, zlib, crypto) — including a small
//      read-only ZIP reader, because adding a dep to a CLI whose whole job is
//      "get the big files" would be silly.
//
// MRLATTE_MODULE_RELEASE_BASE has no default by design. With nothing hosted,
// unset must mean "no downloadable source", not a guess at a URL.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// SCRIPT_DIR is <repo>/tools/scripts, so the repo root is two levels up.
const REPO_ROOT = path.dirname(path.dirname(SCRIPT_DIR));

// Matches backend/routers/modules.py:_SIZE_TOLERANCE. Exact equality is too
// brittle (an asset can be a slightly different build of the same
// dataset); a bare existence check would accept a truncated or HTML-stub file.
const SIZE_TOLERANCE = 0.02;
const HASH_CHUNK = 1 << 20;

// === Terminal ================================================================

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR ? `[${code}m${s}[0m` : String(s));
const bold = c(1);
const dim = c(2);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);

function out(s = '') { process.stdout.write(s + '\n'); }
function errline(s = '') { process.stderr.write(s + '\n'); }

class UserError extends Error {}

// === Manifest ================================================================

function manifestPath() {
  // The manifest is checked-in source, but lives INSIDE the module root
  // (moduleRoot()/manifest.json) alongside the payload it describes — matching
  // what a packaged install already does. Deriving from moduleRoot() rather
  // than a hardcoded 'modules' segment keeps this correct in both dev
  // (data/modules) and packaged (<bundle>/modules) without an if/else.
  return process.env.MRLATTE_MODULE_MANIFEST
    || path.join(moduleRoot(), 'manifest.json');
}

function loadManifest() {
  const p = manifestPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    throw new UserError(`module manifest not found: ${p}\n`
      + `Set MRLATTE_MODULE_MANIFEST if it lives elsewhere.`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new UserError(`module manifest is not valid JSON (${p}): ${e.message}`);
  }
  const modules = Array.isArray(data.modules) ? data.modules : [];
  return { schemaVersion: data.schemaVersion || 0, modules, path: p };
}

function moduleType(entry) { return entry.type || 'data'; }

function findEntry(manifest, id) {
  const entry = manifest.modules.find((m) => m.id === id);
  if (!entry) {
    const ids = manifest.modules.map((m) => m.id).join(', ');
    throw new UserError(`unknown module '${id}'.\nKnown modules: ${ids}`);
  }
  return entry;
}

// === Module root (mirrors backend/deps.py:_default_module_root) =============

function defaultModuleRoot() {
  // .git is a directory in a normal clone and a file in a worktree/submodule.
  if (fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    return path.join(REPO_ROOT, 'data', 'modules');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'MRLatte', 'modules');
  }
  return path.join(os.homedir(), '.local', 'share', 'MRLatte', 'modules');
}

function moduleRoot() {
  return path.resolve(process.env.MRLATTE_MODULE_ROOT || defaultModuleRoot());
}

function ledgerPath() { return path.join(moduleRoot(), 'manifest.installed.json'); }
function stagingRoot() { return path.join(moduleRoot(), '.staging'); }

// === Path safety =============================================================

/** Case/separator-normalised absolute path, for containment tests (NTFS is
 *  case-insensitive, so a raw string compare is not enough). */
function norm(p) {
  const n = path.normalize(path.resolve(p));
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** realpath of the longest existing prefix, with the rest re-joined. Plain
 *  realpath throws on a path that does not exist yet, which is the normal state
 *  for an install destination. */
function realpathBestEffort(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True iff `p` is `root` or lives underneath it, after resolving symlinks and
 *  junctions in whatever part of the path already exists. */
function within(root, p) {
  const r = norm(realpathBestEffort(root));
  const q = norm(realpathBestEffort(p));
  return q === r || q.startsWith(r + path.sep);
}

class BoundaryError extends Error {}

/** Join `rel` under `root`, refusing absolute paths, drive letters, UNC paths,
 *  `..`, NUL bytes, and anything that resolves outside `root` (which catches a
 *  symlink already sitting inside it). Mirrors modules.py:_safe_join. */
function safeJoin(root, rel) {
  const rootR = realpathBestEffort(root);
  if (!rel) return rootR;
  const text = String(rel).replace(/\\/g, '/');
  if (text.includes('\0')) throw new BoundaryError('member contains a NUL byte');
  if (text.startsWith('/')) throw new BoundaryError(`absolute path not allowed: ${rel}`);
  if (text.length >= 2 && text[1] === ':') {
    throw new BoundaryError(`drive-qualified path not allowed: ${rel}`);
  }
  const parts = [];
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new BoundaryError(`parent-directory traversal not allowed: ${rel}`);
    if (part.includes(':')) throw new BoundaryError(`drive/stream qualifier not allowed: ${rel}`);
    parts.push(part);
  }
  if (!parts.length) return rootR;
  const dest = path.join(rootR, ...parts);
  if (!within(rootR, dest)) throw new BoundaryError(`path escapes the module root: ${rel}`);
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) {
      throw new BoundaryError(`destination is a symlink: ${rel}`);
    }
  } catch (e) {
    if (e instanceof BoundaryError) throw e;   // ENOENT is the normal case
  }
  return realpathBestEffort(dest);
}

// === Resolution (mirrors backend/deps.py) =====================================

/** deps.module_path(): env override > module root. */
function resolveDataEntry(entry) {
  const envVar = entry.envVar;
  if (envVar && process.env[envVar]) return path.resolve(process.env[envVar]);
  return path.join(moduleRoot(), entry.installTo || '');
}

/** Where a data module's payload is WRITTEN. Pinned to the module root via
 *  safeJoin: an env override could point reads elsewhere, but writes must never
 *  land outside the root we promised to stay in. */
function installBase(entry) {
  const root = moduleRoot();
  const envVar = entry.envVar;
  const override = envVar ? process.env[envVar] : null;
  if (override) {
    const p = realpathBestEffort(override);
    if (!within(root, p)) {
      throw new UserError(`${envVar}=${override} points outside the module root `
        + `(${root}); refusing to install there. Unset ${envVar} or move it under `
        + `the module root.`);
    }
    return p;
  }
  return safeJoin(root, entry.installTo || '');
}

/** deps.slot_path(), presence tier only: env override > slot dir.
 *  Structural validation (streamline count, affine sanity, .npz array shapes)
 *  stays in backend/module_slots.py — this reports presence + extension,
 *  which is all a Node CLI can honestly claim. */
function resolveSlot(entry) {
  const slot = entry.slot || {};
  const exts = (slot.extensions || []).map((e) => e.toLowerCase());
  const dir = path.join(moduleRoot(), slot.directory || '');
  const envVar = entry.envVar;
  if (envVar && process.env[envVar]) {
    const p = path.resolve(process.env[envVar]);
    if (!fs.existsSync(p)) {
      return { dir, exts, file: null, state: 'broken', tier: 'env',
        reason: `${envVar} points at a missing file: ${p}` };
    }
    if (!exts.includes(path.extname(p).toLowerCase())) {
      return { dir, exts, file: p, state: 'broken', tier: 'env',
        reason: `${path.basename(p)}: unsupported extension — expected ${exts.join(', ')}` };
    }
    return { dir, exts, file: p, state: 'present', tier: 'env', reason: '' };
  }
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch { names = []; }
  const hits = names.filter((n) => !n.endsWith('.part')
    && exts.includes(path.extname(n).toLowerCase())
    && fs.statSync(path.join(dir, n)).isFile());
  if (hits.length) {
    return { dir, exts, file: path.join(dir, hits[0]), state: 'present', tier: 'slot', reason: '' };
  }
  // A non-conforming file sitting in the slot is worth naming: "not installed"
  // sends the user looking for something already on their disk.
  const strays = names.filter((n) => !n.endsWith('.part'));
  return { dir, exts, file: null, state: 'missing', tier: 'slot',
    reason: strays.length
      ? `${strays.length} file(s) present but none matching ${exts.join(', ')}`
      : '' };
}

// === Installed check (mirrors modules.py:_check_data) ========================

function sizeOk(actual, declared) {
  if (!declared) return actual > 0;
  return Math.abs(actual - Number(declared)) <= Math.max(1, Math.floor(Number(declared) * SIZE_TOLERANCE));
}

function plannedFiles(entry, base) {
  if (!entry.files || !entry.files.length) {
    return [{ module: entry.id, rel: path.basename(base), dest: base,
      sha256: entry.sha256 || null, bytes: entry.bytes || null }];
  }
  return entry.files.map((f) => ({
    module: entry.id,
    rel: f.path || '',
    dest: safeJoin(base, f.path || ''),
    sha256: f.sha256 || null,
    bytes: f.bytes || null,
  }));
}

function checkData(entry) {
  const base = resolveDataEntry(entry);
  const missing = [];
  let present = 0;
  const files = entry.files && entry.files.length
    ? entry.files.map((f) => ({ rel: f.path || '', p: path.join(base, f.path || ''), bytes: f.bytes, mutable: Boolean(f.mutable) }))
    : [{ rel: path.basename(base), p: base, bytes: entry.bytes, mutable: false }];
  for (const f of files) {
    let st;
    try { st = fs.statSync(f.p); } catch { missing.push(f.rel); continue; }
    present += 1;
    // Mutable files (atlas.json, *.labels.json) are app-writable after
    // install — presence only, same as verifyData(). A renamed region or
    // recolored atlas rewrites a ~600-byte atlas.json past the 2% size
    // tolerance below, which would otherwise flag every legitimate edit as
    // the whole module being "broken".
    if (f.mutable) continue;
    if (!st.size || !sizeOk(st.size, f.bytes)) missing.push(f.rel);
  }
  return { installed: missing.length === 0, missing, anyPresent: present > 0, base, count: files.length };
}

function state(entry) {
  const type = moduleType(entry);
  if (type === 'slot') {
    const s = resolveSlot(entry);
    return {
      type,
      state: s.state === 'present' ? 'installed' : s.state,
      detail: s.file ? path.basename(s.file) : (s.reason || 'slot empty'),
      tier: s.tier,
      slot: s,
    };
  }
  if (type === 'python-package') {
    return { type, state: 'unknown', detail: (entry.pythonPackages || []).join(', '), tier: 'pip' };
  }
  const chk = checkData(entry);
  const root = moduleRoot();
  const tier = (entry.envVar && process.env[entry.envVar]) ? 'env'
    : within(root, chk.base) ? 'module-root' : 'outside-root';
  return {
    type,
    state: chk.installed ? 'installed' : (chk.anyPresent ? 'broken' : 'missing'),
    detail: chk.installed ? `${chk.count} file(s)` : `${chk.missing.length}/${chk.count} missing`,
    tier,
    check: chk,
  };
}

// === Formatting ==============================================================

function humanBytes(n) {
  n = Number(n || 0);
  if (!Number.isFinite(n)) return 'unknown size';
  if (n < 1024) return `${Math.round(n)} B`;
  for (const unit of ['KB', 'MB', 'GB', 'TB']) {
    n /= 1024;
    if (n < 1024 || unit === 'TB') return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${unit}`;
  }
  return `${Math.round(n)} TB`;
}

const MARK = {
  installed: () => green('[+]'),
  broken: () => yellow('[~]'),
  missing: () => dim('[ ]'),
  unknown: () => dim('[?]'),
};

function pad(s, n) {
  const plain = String(s).replace(/\[[0-9;]*m/g, '');
  return String(s) + ' '.repeat(Math.max(0, n - plain.length));
}

function downloadUrl(entry) {
  const base = (process.env.MRLATTE_MODULE_RELEASE_BASE || '').replace(/\/+$/, '');
  if (!base) return null;
  for (const src of entry.sources || []) {
    if (src.type === 'github-release' && src.asset) {
      const url = src.tag ? `${base}/${src.tag}/${src.asset}` : `${base}/${src.asset}`;
      if (!/^https?:\/\//i.test(url)) {
        throw new UserError(`only http(s) download URLs are allowed: ${url}`);
      }
      return url;
    }
  }
  return null;
}

function hasReleaseSource(entry) {
  return (entry.sources || []).some((s) => s.type === 'github-release' && s.asset);
}

// === list ====================================================================

const TYPE_SECTIONS = [
  ['data', 'DATA', 'downloadable + sha256-verified — `yarn modules add <id>`'],
  ['slot', 'SLOT', 'user-supplied, drop a file in — never downloaded'],
  ['python-package', 'PYTHON PACKAGE', 'installed with pip, not by this CLI'],
];

function cmdList(manifest, opts) {
  const rows = manifest.modules.map((e) => ({ entry: e, st: state(e) }));

  if (opts.json) {
    out(JSON.stringify({
      manifest: manifest.path,
      moduleRoot: moduleRoot(),
      releaseBase: process.env.MRLATTE_MODULE_RELEASE_BASE || null,
      modules: rows.map(({ entry, st }) => ({
        id: entry.id, type: st.type, tier: entry.tier || 'optional',
        state: st.state, resolvedFrom: st.tier, bytes: entry.bytes || 0,
        unlocks: entry.unlocks || [],
        downloadable: st.type === 'data' && Boolean(downloadUrl(entry)),
      })),
    }, null, 2));
    return 0;
  }

  const root = moduleRoot();
  out(bold('MRLatte modules'));
  out(`  manifest      ${manifest.path}`);
  out(`  module root   ${root}${fs.existsSync(root) ? '' : dim('  (not created yet)')}`);
  out(`  release base  ${process.env.MRLATTE_MODULE_RELEASE_BASE
    || dim('(unset — `add` has nothing to download from)')}`);

  for (const [type, title, blurb] of TYPE_SECTIONS) {
    const group = rows.filter((r) => moduleType(r.entry) === type);
    if (!group.length) continue;
    out('');
    out(`${bold(title)}  ${dim('— ' + blurb)}`);
    for (const { entry, st } of group) {
      const mark = (MARK[st.state] || MARK.unknown)();
      const size = type === 'slot' ? '-' : humanBytes(entry.bytes);
      out(`  ${mark} ${pad(cyan(entry.id), 34)}${pad(entry.tier || 'optional', 10)}`
        + `${pad(size, 10)}${pad(st.state, 11)}${dim(entry.name || '')}`);
      const unlocks = (entry.unlocks || []).join(', ');
      if (type === 'data') {
        out(dim(`        ${st.state === 'installed' ? 'at' : 'to'} ${st.check.base}`
          + (st.tier === 'outside-root' ? '   <- outside module root (env override)' : '')));
        if (st.state !== 'installed') {
          out(dim(`        ${hasReleaseSource(entry)
            ? (downloadUrl(entry) ? `download: ${downloadUrl(entry)}`
              : 'download: set MRLATTE_MODULE_RELEASE_BASE')
            : 'sideload only'}`));
        }
      } else if (type === 'slot') {
        out(dim(`        dir  ${st.slot.dir}  (${st.slot.exts.join(', ')})`));
        out(dim(`        hint ${(entry.slot || {}).dropInHint || 'Drop a conforming file in.'}`));
        if (st.slot.file) out(dim(`        file ${st.slot.file}`
          + (st.slot.tier === 'env' ? '   <- env override' : '')));
        if (st.slot.reason) out(yellow(`        ${st.slot.reason}`));
      } else {
        out(dim(`        pip install ${(entry.pythonPackages || []).join(' ')}`));
      }
      if (unlocks) out(dim(`        unlocks ${unlocks}`));
    }
  }

  const missing = rows.filter((r) => moduleType(r.entry) === 'data' && r.st.state !== 'installed');
  out('');
  out(missing.length
    ? `${missing.length} data module(s) not installed: ${missing.map((r) => r.entry.id).join(', ')}`
    : 'All data modules installed.');
  return 0;
}

// === postinstall (one line, never fails, never downloads) ====================

function cmdPostinstall() {
  try {
    const manifest = loadManifest();
    const missing = manifest.modules
      .filter((e) => moduleType(e) !== 'python-package')
      .map((e) => ({ e, st: state(e) }))
      .filter((r) => r.st.state !== 'installed');
    if (missing.length) {
      out(`MRLatte: ${missing.length} optional module(s) not installed `
        + `(${missing.map((r) => r.e.id).join(', ')}) — run \`yarn modules list\`.`);
    } else {
      out('MRLatte: all modules present.');
    }
  } catch {
    // postinstall runs on every `yarn install`, including CI. It reports; it is
    // never the reason an install fails.
  }
  return 0;
}

// === Hashing =================================================================

async function sha256File(p) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(p, { highWaterMark: HASH_CHUNK }), h);
  return h.digest('hex');
}

// === Minimal ZIP reader ======================================================
// Read-only, central-directory driven, no dependency. Only what a release asset
// needs: stored + deflate, Zip64 sizes/offsets, and a refusal on link members.

const S_IFMT = 0xf000, S_IFREG = 0x8000, S_IFDIR = 0x4000;

function findEOCD(fd, size) {
  const maxBack = Math.min(size, 0xffff + 22);
  const buf = Buffer.alloc(maxBack);
  fs.readSync(fd, buf, 0, maxBack, size - maxBack);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return { buf, i, base: size - maxBack };
  }
  throw new UserError('not a readable zip archive (no end-of-central-directory record)');
}

function readCentralDirectory(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const { buf, i, base } = findEOCD(fd, size);
    let entries = buf.readUInt16LE(i + 10);
    let cdSize = buf.readUInt32LE(i + 12);
    let cdOffset = buf.readUInt32LE(i + 16);

    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entries === 0xffff) {
      // Zip64: locator sits immediately before the EOCD.
      const li = i - 20;
      if (li < 0 || buf.readUInt32LE(li) !== 0x07064b50) {
        throw new UserError('zip needs Zip64 but has no Zip64 locator');
      }
      const z64Off = Number(buf.readBigUInt64LE(li + 8));
      const z = Buffer.alloc(56);
      fs.readSync(fd, z, 0, 56, z64Off);
      if (z.readUInt32LE(0) !== 0x06064b50) throw new UserError('bad Zip64 end-of-central-directory');
      entries = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOffset = Number(z.readBigUInt64LE(48));
    }
    void base;

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);

    const members = [];
    let p = 0;
    for (let n = 0; n < entries; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new UserError('corrupt zip central directory');
      const versionMadeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const externalAttr = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

      // Zip64 extended information: only the fields that were saturated appear,
      // in a fixed order.
      let e = 0;
      while (e + 4 <= extra.length) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + len;
      }

      const isDir = name.endsWith('/') || ((versionMadeBy >> 8) === 3
        && ((externalAttr >>> 16) & S_IFMT) === S_IFDIR);
      const mode = (versionMadeBy >> 8) === 3 ? ((externalAttr >>> 16) & S_IFMT) : 0;
      const isLink = mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR;

      members.push({ name, method, compressedSize, uncompressedSize, localOffset, isDir, isLink, flags });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return members;
  } finally {
    fs.closeSync(fd);
  }
}

/** Byte offset of a member's compressed data (the local header repeats the name
 *  and may carry a different extra-field length than the central record). */
function dataOffset(file, member) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(30);
    fs.readSync(fd, h, 0, 30, member.localOffset);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new UserError(`corrupt local header for ${member.name}`);
    return member.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }
}

/** Stream one member into `dest`, hashing as it goes. Returns the sha256. */
async function extractMember(file, member, dest) {
  if (member.flags & 0x1) throw new UserError(`${member.name} is encrypted`);
  if (member.method !== 0 && member.method !== 8) {
    throw new UserError(`${member.name} uses unsupported compression method ${member.method}`);
  }
  const start = dataOffset(file, member);
  const end = start + member.compressedSize - 1;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const h = crypto.createHash('sha256');
  const src = fs.createReadStream(file, { start, end, highWaterMark: HASH_CHUNK });
  const sink = fs.createWriteStream(dest);
  const tap = new Transform({
    transform(chunk, _enc, cb) { h.update(chunk); cb(null, chunk); },
  });
  const stages = member.method === 8
    ? [src, zlib.createInflateRaw(), tap, sink]
    : [src, tap, sink];
  await pipeline(...stages);
  return h.digest('hex');
}

/** Release zips are usually wrapped in a single top-level directory. If every
 *  member shares one, also index by the un-prefixed path so a manifest
 *  `files[].path` still matches. Never drops the original keys. */
function indexMembers(members) {
  const idx = new Map();
  for (const m of members) {
    if (m.isDir) continue;
    idx.set(m.name.replace(/\\/g, '/').replace(/^\.\//, ''), m);
  }
  const keys = [...idx.keys()];
  const tops = new Set(keys.filter((k) => k.includes('/')).map((k) => k.split('/')[0]));
  const flat = keys.filter((k) => !k.includes('/'));
  if (tops.size === 1 && flat.length === 0) {
    const top = [...tops][0];
    for (const [k, v] of [...idx]) {
      const stripped = k.slice(top.length + 1);
      if (!idx.has(stripped)) idx.set(stripped, v);
    }
  }
  return idx;
}

// === Download ================================================================

async function download(url, dest, expectedBytes) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (!/^https?:\/\//i.test(url)) throw new UserError(`only http(s) download URLs are allowed: ${url}`);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', headers: { 'Accept-Encoding': 'identity' } });
  } catch (e) {
    throw new UserError(`download failed: ${url}\n  ${e.message}`);
  }
  if (!res.ok) throw new UserError(`download failed: HTTP ${res.status} ${res.statusText}\n  ${url}`);
  const total = Number(res.headers.get('content-length') || 0) || Number(expectedBytes || 0);
  let done = 0;
  let lastTick = 0;
  const sink = fs.createWriteStream(dest);
  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => {
    done += chunk.length;
    const now = Date.now();
    if (process.stdout.isTTY && now - lastTick > 200) {
      lastTick = now;
      const pct = total ? ` ${Math.floor((done / total) * 100)}%` : '';
      process.stdout.write(`\r    downloading ${humanBytes(done)}${total ? ` / ${humanBytes(total)}` : ''}${pct}   `);
    }
  });
  await pipeline(src, sink);
  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(60) + '\r');
  return done;
}

// === Declared-hash policy ====================================================
// Mirrors backend/routers/modules.py. "No hash declared" is NOT "hash verified":
// a module added to the manifest with `"sha256": null` would otherwise install
// unverified bytes through the very download-then-promote machinery that exists
// to stop exactly that.
//
// Two manifest shapes this must not break: a multi-file `data` module carries
// `sha256: null` at MODULE level and a real digest per entry in `files[]` (that
// null is correct — plannedFiles only reads the module-level hash when there is
// no `files` array), and `slot` / `python-package` modules carry no hashes at
// all and are turned away by refuseNonData long before this.

const UNVERIFIED = 'unverified';
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Normalised manifest sha256, or null when nothing was declared. null, absent
 *  and '' all collapse to null — they are the same claim. */
function declaredHash(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return text || null;
}

function usableHash(value) {
  const declared = declaredHash(value);
  return declared && SHA256_RE.test(declared) ? declared : null;
}

/** The refusal message: names the module and the file, and says what to fix. */
function noHashMessage(item) {
  const declared = declaredHash(item.sha256);
  const head = `${red('refusing to install ' + item.module)}: `;
  if (declared === null) {
    return head + `the manifest declares no sha256 for\n`
      + `    ${item.rel}\n`
      + `  Installing bytes nothing has vouched for defeats the point of the\n`
      + `  download-then-verify design, so this is refused rather than skipped.\n`
      + `  Add that file's sha256 to the manifest. If the asset genuinely cannot\n`
      + `  be hashed, declare "sha256": "unverified" for it explicitly — an absent\n`
      + `  hash is never taken as permission.`;
  }
  return head + `the manifest's sha256 for\n`
    + `    ${item.rel}\n`
    + `  is not usable (${JSON.stringify(item.sha256)}).\n`
    + `  It must be 64 hex characters, or the literal "unverified".`;
}

/** Pre-flight for a whole install: a refusal message, or null if every file may
 *  proceed. Checked before a single byte is downloaded. */
function hashRefusal(items) {
  for (const it of items) {
    if (declaredHash(it.sha256) === UNVERIFIED) continue;
    if (!usableHash(it.sha256)) return noHashMessage(it);
  }
  return null;
}

/** An explicit opt-out is a decision, so it gets said out loud. */
function announceOptOuts(items) {
  for (const it of items) {
    if (declaredHash(it.sha256) === UNVERIFIED) {
      errline(yellow(`  [!] ${it.module}: ${it.rel} declares "sha256": "unverified" — `
        + `installing WITHOUT integrity verification, because the manifest`));
      errline(yellow('      explicitly opts out. It will be recorded as unverified.'));
    }
  }
}

/** True only if every file was checked against a real digest — an explicit
 *  opt-out must never be recorded as `verified` in the ledger. */
function allVerified(items) {
  return items.every((it) => Boolean(usableHash(it.sha256)));
}

// === add =====================================================================

function refuseNonData(entry) {
  const type = moduleType(entry);
  if (type === 'slot') {
    const slot = entry.slot || {};
    const dir = path.join(moduleRoot(), slot.directory || '');
    const lines = [
      `'${entry.id}' is a ${bold('slot')} module: it is user-supplied and is never downloaded.`,
      `  ${slot.dropInHint || 'Drop a conforming file into this folder.'}`,
      `  folder      ${dir}`,
      `  extensions  ${(slot.extensions || []).join(', ')}`,
    ];
    const lic = entry.license || {};
    if (lic.attribution) lines.push(`  why         ${lic.attribution}`);
    return lines.join('\n');
  }
  if (type === 'python-package') {
    return [
      `'${entry.id}' is a ${bold('python-package')} module — not installable by this CLI.`,
      `  Install it into the backend environment instead:`,
      `      pip install ${(entry.pythonPackages || []).join(' ')}`,
    ].join('\n');
  }
  return null;
}

async function addOne(entry, opts) {
  const refusal = refuseNonData(entry);
  if (refusal) { errline(refusal); return 'refused'; }

  const chk = checkData(entry);
  const inRoot = within(moduleRoot(), chk.base);
  if (chk.installed && inRoot && !opts.force) {
    out(`  ${green('[+]')} ${entry.id} already installed (${chk.base}) — use --force to reinstall`);
    return 'skipped';
  }
  if (chk.installed && !inRoot) {
    out(`  ${yellow('[~]')} ${entry.id} already resolves from ${chk.base} (outside the module root).`);
    if (!opts.force) { out('      Nothing to do — use --force to install a module-root copy anyway.'); return 'skipped'; }
  }

  if (!hasReleaseSource(entry)) {
    errline(`'${entry.id}' has no github-release source — it is sideload only.`);
    for (const s of entry.sources || []) {
      if (s.url) errline(`  upstream: ${s.url}`);
    }
    return 'refused';
  }
  const url = downloadUrl(entry);
  if (!url) {
    errline(`  ${red('MRLATTE_MODULE_RELEASE_BASE is not set')} — there is nothing to download from.`);
    errline(`  '${entry.id}' declares a github-release asset `
      + `(${(entry.sources || []).find((s) => s.type === 'github-release').asset}), `
      + `but no release base URL is configured and this CLI will not invent one.`);
    errline(`  Either set MRLATTE_MODULE_RELEASE_BASE=<base url> or obtain the files `
      + `yourself and sideload them via the app's Module Store.`);
    return 'failed';
  }

  const base = installBase(entry);
  const items = plannedFiles(entry, base);

  // Fail closed BEFORE anything is fetched: refuse a module the manifest gives
  // us no way to check, rather than downloading it and quietly trusting it.
  const refusedForHash = hashRefusal(items);
  if (refusedForHash) { errline(refusedForHash); return 'refused'; }
  announceOptOuts(items);

  const multi = Boolean(entry.files && entry.files.length);
  const stage = path.join(stagingRoot(), `cli-${entry.id}-${process.pid}`);
  const parts = items.map((it) => it.dest + '.part');

  out(`  ${cyan(entry.id)} <- ${url}`);
  try {
    if (multi) {
      const archivePart = path.join(stage, 'module.zip.part');
      const archive = path.join(stage, 'module.zip');
      await download(url, archivePart, entry.bytes);
      await fsp.rename(archivePart, archive);

      const members = readCentralDirectory(archive);
      // Fail-closed: check EVERY member against the boundary before extracting
      // anything, so a hostile archive is rejected whole rather than in part.
      for (const m of members) {
        if (m.isLink) throw new BoundaryError(`archive contains a link/special member: ${m.name}`);
        safeJoin(base, m.name);
      }
      const idx = indexMembers(members);
      const chosen = [];
      const absent = [];
      for (const it of items) {
        const m = idx.get(it.rel.replace(/\\/g, '/'));
        if (!m) absent.push(it.rel); else chosen.push([it, m]);
      }
      if (absent.length) {
        throw new UserError(`archive is missing required files:\n  ${absent.join('\n  ')}`);
      }
      for (const [it, m] of chosen) {
        // Zip-bomb / wrong-payload guard: the declared size is known before a
        // single byte is decompressed.
        if (it.bytes && m.uncompressedSize !== Number(it.bytes)) {
          throw new UserError(`declared size mismatch for ${it.rel}: `
            + `expected ${it.bytes} B, archive says ${m.uncompressedSize} B`);
        }
        const actual = await extractMember(archive, m, it.dest + '.part');
        verifyHash(it, actual);
      }
    } else {
      const it = items[0];
      const got = await download(url, it.dest + '.part', it.bytes);
      if (it.bytes && !sizeOk(got, it.bytes)) {
        throw new UserError(`declared size mismatch for ${it.rel}: expected ${it.bytes} B, got ${got} B`);
      }
      verifyHash(it, await sha256File(it.dest + '.part'));
    }
    // Promote only once EVERY file has matched, so a mid-way failure never
    // leaves the module half-upgraded.
    for (const it of items) {
      await fsp.mkdir(path.dirname(it.dest), { recursive: true });
      await fsp.rename(it.dest + '.part', it.dest);
    }
    writeLedger(entry, items.map((it) => it.rel), allVerified(items));
    out(`  ${green('[+]')} ${entry.id}: ${items.length} file(s) verified and installed -> ${base}`);
    return 'installed';
  } catch (e) {
    for (const p of parts) { try { fs.unlinkSync(p); } catch { /* not there */ } }
    errline(`  ${red('[x]')} ${entry.id}: ${e.message}`);
    return 'failed';
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    await fsp.rmdir(stagingRoot()).catch(() => {});   // only if now empty
  }
}

/** The promote gate, and the last line of defence for the hash policy: a file
 *  with no usable declared sha256 is refused here too, in case a future caller
 *  reaches this without the pre-flight. Only an explicit opt-out passes. */
function verifyHash(item, actual) {
  if (declaredHash(item.sha256) === UNVERIFIED) return;   // explicit, announced
  const expected = usableHash(item.sha256);
  if (!expected) throw new UserError(noHashMessage(item));
  if (String(actual).toLowerCase() !== expected) {
    throw new UserError(`sha256 mismatch for ${item.rel}\n`
      + `      expected ${item.sha256}\n      actual   ${actual}`);
  }
}

function readLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    const entries = raw && typeof raw === 'object' ? raw.modules : null;
    if (entries && !Array.isArray(entries)) return entries;
    if (Array.isArray(entries)) {
      return Object.fromEntries(entries.filter((e) => e && e.id).map((e) => [e.id, e]));
    }
  } catch { /* absent on every un-installed machine */ }
  return {};
}

function writeLedgerRaw(ledger) {
  const p = ledgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, modules: ledger }, null, 2));
  fs.renameSync(tmp, p);     // atomic: a concurrent reader never sees a partial file
}

function writeLedger(entry, files, verified) {
  const ledger = readLedger();
  ledger[entry.id] = {
    id: entry.id,
    version: entry.version || null,
    verified: Boolean(verified),
    installedAt: new Date().toISOString(),
    files,
  };
  writeLedgerRaw(ledger);
}

function dropLedger(id) {
  const ledger = readLedger();
  if (!(id in ledger)) return;
  delete ledger[id];
  writeLedgerRaw(ledger);
}

async function cmdAdd(manifest, args, opts) {
  let targets;
  if (opts.all || opts.core) {
    const wantCore = opts.core && !opts.all;
    targets = manifest.modules.filter((e) => moduleType(e) === 'data'
      && (!wantCore || (e.tier || 'optional') === 'core'));
    const skipped = manifest.modules.filter((e) => !targets.includes(e));
    out(bold(`Installing ${targets.length} ${wantCore ? 'core ' : ''}data module(s).`));
    if (skipped.length) {
      out(dim(`  Skipping ${skipped.length} module(s): `
        + skipped.map((e) => `${e.id} (${wantCore && moduleType(e) === 'data'
          ? 'optional' : moduleType(e)})`).join(', ')));
      out(dim('  Slots are user-supplied and pip packages are not this CLI\'s job'
        + (wantCore ? '; optional data modules install with `add --all`' : '')
        + ' — run `yarn modules list` for details.'));
    }
  } else {
    if (!args.length) throw new UserError('usage: yarn modules add <id> | yarn modules add --all | yarn modules add --core');
    targets = args.map((id) => findEntry(manifest, id));
  }

  const results = {};
  for (const entry of targets) results[entry.id] = await addOne(entry, opts);

  const tally = (v) => Object.values(results).filter((r) => r === v).length;
  out('');
  out(`installed ${tally('installed')}, skipped ${tally('skipped')}, `
    + `refused ${tally('refused')}, failed ${tally('failed')}`);
  return (tally('failed') || tally('refused')) ? 1 : 0;
}

// === verify ==================================================================

async function verifyData(entry) {
  const base = resolveDataEntry(entry);
  const files = entry.files && entry.files.length
    ? entry.files.map((f) => ({ rel: f.path, p: path.join(base, f.path), sha256: f.sha256,
                               bytes: f.bytes, mutable: Boolean(f.mutable) }))
    : [{ rel: path.basename(base), p: base, sha256: entry.sha256, bytes: entry.bytes }];
  const rows = [];
  for (const f of files) {
    // A `mutable` file is one the APP rewrites after install — atlas.json holds
    // an atlas's display name and colormap, *.labels.json holds per-region
    // colours. Both are still hash-checked at INSTALL time; afterwards the file
    // belongs to the user and a mismatch is an edit, not corruption.
    const expected = f.mutable ? null : usableHash(f.sha256);
    const row = { file: f.rel, path: f.p, present: fs.existsSync(f.p),
      hashed: Boolean(expected), mutable: f.mutable, ok: false, note: '' };
    if (row.present) {
      const size = fs.statSync(f.p).size;
      if (expected) {
        const actual = await sha256File(f.p);
        row.ok = actual.toLowerCase() === expected;
        if (!row.ok) row.note = `sha256 ${actual.slice(0, 12)}… != ${expected.slice(0, 12)}…`;
      } else if (f.mutable) {
        // Presence only. Renaming an atlas rewrites a ~600-byte atlas.json,
        // which moves its size past the 2% tolerance, so a size check would
        // flag every edit as damage just as a hash check would.
        row.ok = true;
        row.note = 'app-writable metadata — presence checked only';
      } else {
        // Reported, never counted as verified — see the declared-hash policy.
        row.ok = sizeOk(size, f.bytes);
        row.note = 'no usable sha256 in manifest — size checked only, NOT verified';
      }
    }
    rows.push(row);
  }
  return { base, rows };
}

async function cmdVerify(manifest, args, opts) {
  const targets = args.length ? args.map((id) => findEntry(manifest, id)) : manifest.modules;
  const report = [];
  let corrupt = 0;

  for (const entry of targets) {
    const type = moduleType(entry);
    if (type === 'data') {
      const { base, rows } = await verifyData(entry);
      const bad = rows.filter((r) => r.present && !r.ok);
      const gone = rows.filter((r) => !r.present);
      corrupt += bad.length;
      report.push({ entry, type, base, rows, bad, gone,
        verdict: bad.length ? 'CORRUPT' : gone.length ? (gone.length === rows.length ? 'MISSING' : 'INCOMPLETE') : 'OK' });
    } else if (type === 'slot') {
      // Presence + extension only. The structural contract (streamline count,
      // reference affine, .npz array shapes) lives in backend/module_slots.py and
      // needs nibabel/numpy — reimplementing it here would only produce a second,
      // subtly different answer.
      const s = resolveSlot(entry);
      report.push({ entry, type, slot: s,
        verdict: s.state === 'present' ? 'PRESENT' : s.state === 'broken' ? 'BROKEN' : 'EMPTY' });
    } else {
      report.push({ entry, type, verdict: 'SKIPPED' });
    }
  }

  if (opts.json) {
    out(JSON.stringify(report.map((r) => ({
      id: r.entry.id, type: r.type, verdict: r.verdict,
      files: (r.rows || []).map(({ file, present, hashed, ok, note }) => ({ file, present, hashed, ok, note })),
      slot: r.slot ? { dir: r.slot.dir, file: r.slot.file, tier: r.slot.tier } : undefined,
    })), null, 2));
    return corrupt ? 1 : 0;
  }

  out(bold('Verifying against ') + manifest.path);
  out(dim(`module root ${moduleRoot()}`));
  for (const r of report) {
    const colour = { OK: green, PRESENT: green, MISSING: dim, EMPTY: dim, SKIPPED: dim,
      INCOMPLETE: yellow, BROKEN: yellow, CORRUPT: red }[r.verdict] || dim;
    out('');
    out(`${pad(cyan(r.entry.id), 34)}${pad(dim(r.type), r.type === 'python-package' ? 22 : 16)}${colour(r.verdict)}`);
    if (r.type === 'data') {
      out(dim(`  ${r.rows.filter((x) => x.ok).length}/${r.rows.length} file(s) verified under ${r.base}`));
      for (const x of r.bad) out(red(`  corrupt  ${x.file}  ${x.note}`));
      for (const x of r.gone) out(dim(`  missing  ${x.file}`));
      const noHash = r.rows.filter((x) => x.present && !x.hashed && !x.mutable);
      if (noHash.length) {
        out(yellow(`  ${noHash.length} file(s) have no usable sha256 in the manifest — `
          + `size checked only, NOT verified`));
      }
    } else if (r.type === 'slot') {
      out(dim(`  slot ${r.slot.dir}  (${r.slot.exts.join(', ')})`));
      if (r.slot.file) {
        out(dim(`  file ${r.slot.file}`
          + (r.slot.tier === 'env' ? '   <- env override' : '')));
        out(dim('  presence + extension only; structural validation runs in the backend '
          + '(module_slots.py)'));
      } else {
        out(dim(`  ${r.slot.reason || (r.entry.slot || {}).dropInHint || 'nothing dropped in yet'}`));
      }
    } else {
      out(dim(`  pip module — checked by the backend importer, not here `
        + `(${(r.entry.pythonPackages || []).join(', ')})`));
    }
  }
  out('');
  out(corrupt ? red(`${corrupt} corrupt file(s).`) : green('No corrupt files.'));
  return corrupt ? 1 : 0;
}

// === remove ==================================================================

/** The safety property this whole CLI exists to preserve: never delete anything
 *  this CLI did not itself install. A module fails that test two ways —
 *
 *    * it resolves OUTSIDE the module root, via an explicit env override
 *      (ATLAS_DIR, GLOBAL_TRACT_FILE, …) pointed elsewhere; or
 *    * it sits INSIDE the root but has no install-ledger entry — i.e. it is
 *      tracked source or user-supplied data in a dev checkout (the atlases the
 *      repo ships, a hand-dropped slot file), not something `add` downloaded.
 *
 *  An `add` writes the ledger; only then may `remove` delete those files. */
function uninstallGuard(entry) {
  const resolved = resolveDataEntry(entry);
  const root = moduleRoot();
  if (!within(root, resolved)) {
    throw new UserError(`${red('refusing to remove ' + entry.id)}: it resolves to\n`
      + `    ${resolved}\n`
      + `  which is outside the module root\n`
      + `    ${root}\n`
      + (entry.envVar && process.env[entry.envVar]
        ? `  (via the ${entry.envVar} override). Unset it to manage this module here.`
        : `  Refusing to delete files outside the module root.`));
  }
  if (!(entry.id in readLedger())) {
    throw new UserError(`${red('refusing to remove ' + entry.id)}: it is present under\n`
      + `    ${resolved}\n`
      + `  but was not installed by this CLI (no install-ledger entry) — it is part\n`
      + `  of your checkout, not a managed install. Refusing to delete files it did\n`
      + `  not install.`);
  }
  return resolved;
}

/** Remove now-empty directories up to, but never including, `stop`. */
function pruneEmpty(dir, stop) {
  let cur = path.resolve(dir);
  while (norm(cur) !== norm(stop) && within(stop, cur)) {
    try {
      if (fs.readdirSync(cur).length) return;
      fs.rmdirSync(cur);
    } catch { return; }
    cur = path.dirname(cur);
  }
}

function cmdRemove(manifest, args) {
  if (!args.length) throw new UserError('usage: yarn modules remove <id>');
  let failedAny = false;

  for (const id of args) {
    const entry = findEntry(manifest, id);
    const type = moduleType(entry);
    if (type !== 'data') {
      // Same refusal as the backend: a slot holds a file the USER put there,
      // and a pip package is pip's to remove.
      errline(type === 'slot'
        ? `${red('refusing to remove ' + id)}: it is a slot module. Its file is user-supplied — `
          + `delete it yourself from\n    ${path.join(moduleRoot(), (entry.slot || {}).directory || '')}`
        : `${red('refusing to remove ' + id)}: it is a python-package module — `
          + `uninstall it with pip (${(entry.pythonPackages || []).join(' ')}).`);
      failedAny = true;
      continue;
    }

    uninstallGuard(entry);        // throws (and aborts) if it would leave the root

    const root = moduleRoot();
    const base = installBase(entry);
    const items = plannedFiles(entry, base);
    let freed = 0;
    const removed = [];
    // Only the manifest's declared files: four modules share the `atlases`
    // directory, so removing installTo wholesale would take three others with it.
    for (const it of items) {
      for (const p of [it.dest, it.dest + '.part']) {
        let size;
        try { size = fs.statSync(p).size; } catch { continue; }
        if (!within(root, p)) {   // belt and braces
          errline(`  ${red('[x]')} ${p}: outside the module root, skipped`);
          failedAny = true;
          continue;
        }
        try { fs.unlinkSync(p); } catch (e) {
          errline(`  ${red('[x]')} ${p}: ${e.message}`);
          failedAny = true;
          continue;
        }
        freed += size;
        removed.push(p);
      }
    }
    // Prune upward from each file's own directory, not just from `base`: the
    // four atlas modules share `atlases/`, so `base` is still populated while
    // `atlases/benson14/` is now an empty husk. `within` bounds every step.
    for (const dir of new Set(removed.map((p) => path.dirname(p)))) pruneEmpty(dir, root);
    pruneEmpty(entry.files && entry.files.length ? base : path.dirname(base), root);
    dropLedger(id);
    out(`  ${green('[-]')} ${id}: removed ${removed.length} file(s), freed ${humanBytes(freed)}`);
    for (const p of removed) out(dim(`        ${p}`));
  }
  return failedAny ? 1 : 0;
}

// === Entry point =============================================================

const USAGE = `MRLatte module CLI

  yarn modules list                    what the manifest declares and what is on disk
  yarn modules add <id> [<id>...]      download, sha256-verify and install a data module
  yarn modules add --core              every core-tier data module (the default install set)
  yarn modules add --all               every data module (slots and pip modules are skipped)
  yarn modules verify [<id>...]        streamed sha256 of every installed file
  yarn modules remove <id>             delete a data module's files from the module root

Options
  --core       with "add": only core-tier data modules
  --all        with "add": every data module
  --force      with "add": reinstall even if already present
  --json       with "list" / "verify": machine-readable output

Environment
  MRLATTE_MODULE_ROOT           where modules live      (default ${defaultModuleRoot()})
  MRLATTE_MODULE_MANIFEST       manifest location       (default <repo>/modules/manifest.json)
  MRLATTE_MODULE_RELEASE_BASE   base URL for github-release assets — no default: with
                                nothing hosted, unset means "no downloadable source"

Slot modules (the tractogram, the DA-LNM bundle) are never downloaded. They are
user-supplied by licence: \`list\` prints the folder to drop a file into.`;

async function main(argv) {
  const args = [];
  const opts = { all: false, core: false, force: false, json: false };
  for (const a of argv) {
    if (a === '--') continue;              // npm-style `npm run modules -- add --all`
    else if (a === '--all' || a === '-a') opts.all = true;
    else if (a === '--core') opts.core = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') return (out(USAGE), 0);
    else if (a.startsWith('-')) throw new UserError(`unknown option '${a}'\n\n${USAGE}`);
    else args.push(a);
  }
  const cmd = args.shift() || 'list';
  if (cmd === 'help') return (out(USAGE), 0);
  if (cmd === 'postinstall') return cmdPostinstall();

  const manifest = loadManifest();
  switch (cmd) {
    case 'list': case 'ls': case 'status': return cmdList(manifest, opts);
    case 'add': case 'install': return await cmdAdd(manifest, args, opts);
    case 'verify': case 'check': return await cmdVerify(manifest, args, opts);
    case 'remove': case 'rm': case 'uninstall': return cmdRemove(manifest, args);
    default: throw new UserError(`unknown command '${cmd}'\n\n${USAGE}`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UserError || e instanceof BoundaryError) {
    errline(red('error: ') + e.message);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
