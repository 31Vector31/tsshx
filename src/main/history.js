'use strict';
// Remote shell history: fetch history files over the SSH session, parse bash/zsh/fish formats,
// merge with commands run from the app, rank by recency+frequency. Pins are stored per host.

const fs = require('fs');
const path = require('path');

const FETCH_CMD = `for f in "$HOME/.bash_history" "$HOME/.zsh_history" "$HOME/.local/share/fish/fish_history" "$HOME/.history" "$HOME/.sh_history"; do ` +
  `if [ -r "$f" ]; then printf '\\001%s\\n' "$f"; tail -n 8000 "$f"; printf '\\n'; fi; done 2>/dev/null`;

/** Parse a bash history file (optionally with "#<epoch>" timestamp lines). */
function parseBash(text) {
  const out = []; let ts = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^#(\d{9,11})$/);
    if (m) { ts = parseInt(m[1], 10) * 1000; continue; }
    out.push({ cmd: line, ts }); ts = null;
  }
  return out;
}

/** Parse zsh history (plain or EXTENDED_HISTORY ": <epoch>:<dur>;cmd", multi-line with trailing backslash). */
function parseZsh(text) {
  const out = []; let cur = null;
  const flush = () => { if (cur && cur.cmd.trim()) out.push(cur); cur = null; };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (cur && cur.cont) { cur.cmd += '\n' + line.replace(/\\$/, ''); cur.cont = line.endsWith('\\'); if (!cur.cont) { delete cur.cont; } continue; }
    if (!line.trim()) continue;
    flush();
    const m = line.match(/^: (\d+):\d+;(.*)$/);
    const cmd = m ? m[2] : line; const ts = m ? parseInt(m[1], 10) * 1000 : null;
    cur = { cmd: cmd.replace(/\\$/, ''), ts, cont: cmd.endsWith('\\') };
    if (!cur.cont) delete cur.cont;
  }
  flush();
  return out.map(e => { delete e.cont; return e; });
}

/** Parse fish history (YAML-ish: "- cmd: ...", "  when: <epoch>"). */
function parseFish(text) {
  const out = []; let cur = null;
  for (const raw of text.split('\n')) {
    const m = raw.match(/^- cmd: (.*)$/);
    if (m) { if (cur) out.push(cur); cur = { cmd: m[1].replace(/\\n/g, '\n').replace(/\\\\/g, '\\'), ts: null }; continue; }
    const w = raw.match(/^\s+when: (\d+)/);
    if (w && cur) cur.ts = parseInt(w[1], 10) * 1000;
  }
  if (cur) out.push(cur);
  return out;
}

function parseByName(file, text) {
  if (/zsh_history$/.test(file)) return parseZsh(text);
  if (/fish_history$/.test(file)) return parseFish(text);
  return parseBash(text);
}

/** Split the multi-file blob produced by FETCH_CMD into {file, text} chunks. */
function splitBlob(blob) {
  const parts = blob.split('').slice(1);
  return parts.map(p => { const nl = p.indexOf('\n'); return { file: p.slice(0, nl).trim(), text: p.slice(nl + 1) }; }).filter(p => p.file);
}

/**
 * Merge entries from several sources into unique commands ranked by recency and frequency.
 * Returns [{ cmd, count, last, src }], newest/most used first.
 */
function mergeRank(sources, { limit = 5000 } = {}) {
  const map = new Map();
  let order = 0;
  for (const { src, entries } of sources) {
    for (const e of entries) {
      const cmd = String(e.cmd).replace(/\s+$/, '');
      if (!cmd || cmd.length > 4000) continue;
      order++;
      const cur = map.get(cmd);
      if (cur) { cur.count++; cur.order = order; if (e.ts && (!cur.last || e.ts > cur.last)) cur.last = e.ts; if (!cur.src.includes(src)) cur.src.push(src); }
      else map.set(cmd, { cmd, count: 1, order, last: e.ts || null, src: [src] });
    }
  }
  const list = [...map.values()];
  list.sort((a, b) => (b.last || 0) - (a.last || 0) || b.order - a.order);
  return list.slice(0, limit).map(x => ({ cmd: x.cmd, count: x.count, last: x.last, src: x.src.join(',') }));
}

class HistoryStore {
  constructor(dir) { this.dir = dir; this.extra = null; this.pins = null; fs.mkdirSync(dir, { recursive: true }); }
  _load(name) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch (_) { return {}; } }
  _save(name, obj) { fs.writeFileSync(path.join(this.dir, name), JSON.stringify(obj)); }
  /** Commands run from the app before the shell flushed them to disk. */
  note(hostKey, cmd) {
    if (!this.extra) this.extra = this._load('history-extra.json');
    const list = (this.extra[hostKey] = this.extra[hostKey] || []);
    list.push({ cmd, ts: Date.now() });
    if (list.length > 500) list.splice(0, list.length - 500);
    this._save('history-extra.json', this.extra);
  }
  extras(hostKey) { if (!this.extra) this.extra = this._load('history-extra.json'); return this.extra[hostKey] || []; }
  getPins(hostKey) { if (!this.pins) this.pins = this._load('history-pins.json'); return this.pins[hostKey] || []; }
  setPins(hostKey, list) { if (!this.pins) this.pins = this._load('history-pins.json'); this.pins[hostKey] = [...new Set(list.map(String))]; this._save('history-pins.json', this.pins); return this.pins[hostKey]; }

  /** Fetch + parse + merge history for a live SSH session. */
  async fetch(session, hostKey) {
    const r = await session.exec(FETCH_CMD, { timeout: 20000, maxOutput: 16 * 1024 * 1024 });
    const sources = splitBlob(r.stdout).map(({ file, text }) => ({ src: path.posix.basename(file).replace(/^\./, '').replace(/_history$/, ''), entries: parseByName(file, text) }));
    sources.push({ src: 'terhui', entries: this.extras(hostKey) });
    return { entries: mergeRank(sources), files: sources.map(s => s.src), pins: this.getPins(hostKey) };
  }
}

module.exports = { HistoryStore, parseBash, parseZsh, parseFish, splitBlob, mergeRank, FETCH_CMD };
