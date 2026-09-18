'use strict';
// Remote directory indexer: builds a list of directories (optionally files) for a host,
// stores it gzipped on disk and serves fast fuzzy searches for quick navigation.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const EventEmitter = require('events');

const DEFAULT_PRUNE = ['.git', 'node_modules', '.cache', '.npm', '.cargo', '__pycache__', '.venv', 'proc', 'sys', 'dev', 'run', 'snap', 'lost+found'];

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

class Indexer extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.cache = new Map();   // hostId -> index object
    this.building = new Map(); // hostId -> {cancel}
    fs.mkdirSync(dir, { recursive: true });
  }

  _file(hostId) { return path.join(this.dir, encodeURIComponent(hostId) + '.json.gz'); }

  load(hostId) {
    if (this.cache.has(hostId)) return this.cache.get(hostId);
    const f = this._file(hostId);
    if (!fs.existsSync(f)) return null;
    try {
      const idx = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
      idx.lower = idx.entries.map(e => e.toLowerCase());
      this.cache.set(hostId, idx);
      return idx;
    } catch (_) { return null; }
  }

  info(hostId) {
    const idx = this.load(hostId);
    const b = this.building.get(hostId);
    return {
      exists: !!idx, builtAt: idx ? idx.builtAt : null, count: idx ? idx.entries.length : 0, root: idx ? idx.root : null,
      includeFiles: idx ? !!idx.includeFiles : false, truncated: idx ? !!idx.truncated : false,
      building: !!b, progress: b ? b.count : 0,
    };
  }

  clear(hostId) {
    this.cache.delete(hostId);
    try { fs.unlinkSync(this._file(hostId)); } catch (_) {}
  }

  clearAll() { this.cache.clear(); try { for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.json.gz')) fs.unlinkSync(path.join(this.dir, f)); } catch (_) {} }
  cancel(hostId) { const b = this.building.get(hostId); if (b) b.cancel(); }

  _store(hostId, idx) {
    idx.lower = idx.entries.map(e => e.toLowerCase());
    this.cache.set(hostId, idx);
    const { lower, ...persist } = idx;
    fs.writeFileSync(this._file(hostId), zlib.gzipSync(Buffer.from(JSON.stringify(persist), 'utf8')));
  }

  /**
   * Build via SSH `find`. session: SshSession. Returns info.
   */
  async buildSsh(hostId, session, { root = '/', includeFiles = false, maxEntries = 1000000, prune = DEFAULT_PRUNE } = {}) {
    if (this.building.has(hostId)) throw new Error('Index build already running');
    const state = { count: 0, cancel: () => { state.cancelled = true; try { state.stream && state.stream.close(); } catch (_) {} } };
    this.building.set(hostId, state);
    try {
      const pruneExpr = prune.length ? `\\( ${prune.map(n => `-name ${shQuote(n)}`).join(' -o ')} \\) -prune -o ` : '';
      const typeExpr = includeFiles ? '\\( -type d -o -type f \\)' : '-type d';
      const cmd = `LC_ALL=C find ${shQuote(root)} -xdev ${pruneExpr}${typeExpr} -print0 2>/dev/null`;
      const stream = await session.execStream(cmd);
      state.stream = stream;
      const entries = [];
      let truncated = false;
      await new Promise((resolve, reject) => {
        let rest = Buffer.alloc(0);
        let lastEmit = 0;
        stream.on('data', (chunk) => {
          if (truncated) return;
          let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
          let start = 0;
          for (;;) {
            const i = buf.indexOf(0, start);
            if (i < 0) break;
            entries.push(buf.subarray(start, i).toString('utf8'));
            start = i + 1;
            if (entries.length >= maxEntries) { truncated = true; try { stream.close(); } catch (_) {} break; }
          }
          rest = buf.subarray(start);
          state.count = entries.length;
          const now = Date.now();
          if (now - lastEmit > 250) { lastEmit = now; this.emit('progress', { hostId, count: entries.length }); }
        });
        stream.on('close', () => { if (rest.length) entries.push(rest.toString('utf8')); resolve(); });
        stream.on('error', reject);
      });
      if (state.cancelled) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
      const idx = { version: 1, hostId, root, includeFiles, builtAt: Date.now(), truncated, entries };
      this._store(hostId, idx);
      this.emit('progress', { hostId, count: entries.length, done: true });
      return this.info(hostId);
    } finally {
      this.building.delete(hostId);
    }
  }

  /**
   * Build by walking any FS backend (used for FTP). Slow but generic.
   */
  async buildWalk(hostId, fsb, { root = '/', includeFiles = false, maxEntries = 200000, maxDepth = 12, prune = DEFAULT_PRUNE } = {}) {
    if (this.building.has(hostId)) throw new Error('Index build already running');
    const state = { count: 0, cancelled: false, cancel: () => { state.cancelled = true; } };
    this.building.set(hostId, state);
    try {
      const entries = [root];
      const pruneSet = new Set(prune);
      let truncated = false; let lastEmit = 0;
      const walk = async (dir, depth) => {
        if (state.cancelled || truncated || depth > maxDepth) return;
        let items;
        try { items = await fsb.list(dir); } catch (_) { return; }
        for (const it of items) {
          if (state.cancelled) return;
          if (it.type === 'd') {
            if (pruneSet.has(it.name)) continue;
            entries.push(it.path);
            if (entries.length >= maxEntries) { truncated = true; return; }
            await walk(it.path, depth + 1);
          } else if (includeFiles && it.type === 'f') {
            entries.push(it.path);
            if (entries.length >= maxEntries) { truncated = true; return; }
          }
          state.count = entries.length;
          const now = Date.now();
          if (now - lastEmit > 250) { lastEmit = now; this.emit('progress', { hostId, count: entries.length }); }
        }
      };
      await walk(root, 0);
      if (state.cancelled) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
      const idx = { version: 1, hostId, root, includeFiles, builtAt: Date.now(), truncated, entries };
      this._store(hostId, idx);
      this.emit('progress', { hostId, count: entries.length, done: true });
      return this.info(hostId);
    } finally {
      this.building.delete(hostId);
    }
  }

  /** Fuzzy search. Returns [{ path, score }] best first. */
  search(hostId, query, { limit = 100 } = {}) {
    const idx = this.load(hostId);
    if (!idx) return [];
    return searchEntries(idx.entries, idx.lower, query, limit);
  }
}

// ---- scoring ----
// Each whitespace-separated term must match. Substring matches score high (more at segment start /
// basename); otherwise an in-order subsequence match with gap penalties. Shorter paths win ties.
function searchEntries(entries, lower, query, limit) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries.slice(0, limit).map(p => ({ path: p, score: 0 }));
  const results = [];
  const n = entries.length;
  for (let i = 0; i < n; i++) {
    const l = lower[i];
    let total = 0; let ok = true;
    for (const t of terms) {
      const s = scoreTerm(l, t);
      if (s < 0) { ok = false; break; }
      total += s;
    }
    if (!ok) continue;
    total -= Math.min(30, l.length / 8);       // prefer shorter paths
    total -= countSlashes(l) * 0.5;             // prefer shallower paths
    results.push({ path: entries[i], score: total });
  }
  results.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return results.slice(0, limit);
}

function countSlashes(s) { let c = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 47) c++; return c; }

function scoreTerm(hay, term) {
  const pos = hay.indexOf(term);
  if (pos >= 0) {
    let s = 100;
    const lastSlash = hay.lastIndexOf('/');
    if (pos > lastSlash) s += 60;                                   // in basename
    if (pos === 0 || hay[pos - 1] === '/') s += 40;                 // segment start
    else if (/[-_. ]/.test(hay[pos - 1])) s += 15;                  // word start
    if (pos + term.length === hay.length) s += 25;                  // basename exact tail
    if (hay.length === term.length) s += 50;
    return s;
  }
  // subsequence
  let hi = 0, score = 0, lastMatch = -2, first = -1;
  for (let ti = 0; ti < term.length; ti++) {
    const c = term[ti];
    const idx = hay.indexOf(c, hi);
    if (idx < 0) return -1;
    if (first < 0) first = idx;
    if (idx === lastMatch + 1) score += 8;             // consecutive
    else if (idx === 0 || hay[idx - 1] === '/') score += 6;
    else if (/[-_. ]/.test(hay[idx - 1])) score += 4;
    else score += 1;
    score -= Math.min(10, (idx - hi)) * 0.3;            // gap penalty
    lastMatch = idx; hi = idx + 1;
  }
  const lastSlash = hay.lastIndexOf('/');
  if (first > lastSlash) score += 10;
  return Math.max(1, score);
}

module.exports = { Indexer, searchEntries, DEFAULT_PRUNE, shQuote };
