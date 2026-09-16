'use strict';
// Uniform file-system interface over local disk, SFTP (ssh2) and FTP (basic-ftp),
// plus a transfer manager for (recursive) copies between any two of them.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const posix = path.posix;
const EventEmitter = require('events');

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, S_IFREG = 0o100000;

function modeToString(mode, type) {
  const t = type === 'd' ? 'd' : type === 'l' ? 'l' : '-';
  const bits = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += (mode & (1 << (8 - i))) ? bits[i] : '-';
  if (mode & 0o4000) s = s.slice(0, 2) + (s[2] === 'x' ? 's' : 'S') + s.slice(3);
  if (mode & 0o2000) s = s.slice(0, 5) + (s[5] === 'x' ? 's' : 'S') + s.slice(6);
  if (mode & 0o1000) s = s.slice(0, 8) + (s[8] === 'x' ? 't' : 'T');
  return t + s;
}

function typeFromMode(mode) {
  const f = mode & S_IFMT;
  if (f === S_IFDIR) return 'd';
  if (f === S_IFLNK) return 'l';
  if (f === S_IFREG) return 'f';
  return 'o';
}

/** Entry: { name, path, type:'d'|'f'|'l'|'o', size, mtime(ms), mode, modeStr, owner, group, linkTarget?, targetType? } */

// ---------------- Local ----------------
class LocalFS {
  constructor() { this.kind = 'local'; this.sep = path.sep; }
  join(a, b) { return path.join(a, b); }
  dirname(p) { return path.dirname(p); }
  basename(p) { return path.basename(p); }
  async home() { return os.homedir(); }
  async realpath(p) { return fsp.realpath(p); }
  async list(dir) {
    const names = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const d of names) {
      const full = path.join(dir, d.name);
      let st = null, lst = null;
      try { lst = await fsp.lstat(full); } catch (_) { continue; }
      const type = lst.isDirectory() ? 'd' : lst.isSymbolicLink() ? 'l' : lst.isFile() ? 'f' : 'o';
      const e = { name: d.name, path: full, type, size: lst.size, mtime: lst.mtimeMs, mode: lst.mode & 0o7777, modeStr: modeToString(lst.mode, type), owner: String(lst.uid), group: String(lst.gid) };
      if (type === 'l') {
        try { e.linkTarget = await fsp.readlink(full); st = await fsp.stat(full); e.targetType = st.isDirectory() ? 'd' : 'f'; e.size = st.size; } catch (_) { e.targetType = 'x'; }
      }
      out.push(e);
    }
    return out;
  }
  async stat(p) {
    const st = await fsp.stat(p);
    const type = st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o';
    return { name: path.basename(p), path: p, type, size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o7777, modeStr: modeToString(st.mode, type) };
  }
  async mkdir(p) { await fsp.mkdir(p, { recursive: true }); }
  async rename(a, b) { await fsp.rename(a, b); }
  async unlink(p) { await fsp.unlink(p); }
  async rmdir(p) { await fsp.rm(p, { recursive: true, force: true }); }
  async chmod(p, mode) { await fsp.chmod(p, mode); }
  async readFile(p, limit = 2 * 1024 * 1024) {
    const fh = await fsp.open(p, 'r');
    try { const st = await fh.stat(); const n = Math.min(st.size, limit); const buf = Buffer.alloc(n); await fh.read(buf, 0, n, 0); return { data: buf, truncated: st.size > limit, size: st.size }; }
    finally { await fh.close(); }
  }
  async writeFile(p, data) { await fsp.writeFile(p, data); }
  async downloadFile(remote, local, onBytes) { await copyLocal(remote, local, onBytes); }
  async uploadFile(local, remote, onBytes) { await copyLocal(local, remote, onBytes); }
}

function copyLocal(src, dst, onBytes) {
  return new Promise((resolve, reject) => {
    const r = fs.createReadStream(src), w = fs.createWriteStream(dst);
    r.on('data', c => onBytes && onBytes(c.length));
    r.on('error', reject); w.on('error', reject); w.on('finish', resolve);
    r.pipe(w);
  });
}

// ---------------- SFTP ----------------
class SftpFS {
  constructor(session) { this.kind = 'sftp'; this.session = session; this.sep = '/'; }
  join(a, b) { return posix.join(a, b); }
  dirname(p) { return posix.dirname(p); }
  basename(p) { return posix.basename(p); }
  async _s() { return this.session.sftp(); }
  _p(fn) { return new Promise((res, rej) => fn((err, v) => err ? rej(err) : res(v))); }
  async home() { const s = await this._s(); return this._p(cb => s.realpath('.', cb)); }
  async realpath(p) { const s = await this._s(); return this._p(cb => s.realpath(p, cb)); }
  async list(dir) {
    const s = await this._s();
    const items = await this._p(cb => s.readdir(dir, cb));
    const out = [];
    const links = [];
    for (const it of items) {
      const a = it.attrs || {};
      const type = typeFromMode(a.mode || 0);
      const ln = (it.longname || '').split(/\s+/);
      const e = { name: it.filename, path: posix.join(dir, it.filename), type, size: a.size || 0, mtime: (a.mtime || 0) * 1000, mode: (a.mode || 0) & 0o7777, modeStr: modeToString(a.mode || 0, type), owner: ln[2] || String(a.uid ?? ''), group: ln[3] || String(a.gid ?? '') };
      if (type === 'l') links.push(e);
      out.push(e);
    }
    // Resolve symlink targets with limited concurrency
    const queue = links.slice();
    const worker = async () => {
      while (queue.length) {
        const e = queue.shift();
        try { e.linkTarget = await this._p(cb => s.readlink(e.path, cb)); } catch (_) {}
        try { const st = await this._p(cb => s.stat(e.path, cb)); e.targetType = typeFromMode(st.mode) === 'd' ? 'd' : 'f'; e.size = st.size; } catch (_) { e.targetType = 'x'; }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }
  async stat(p) {
    const s = await this._s();
    const st = await this._p(cb => s.stat(p, cb));
    const type = typeFromMode(st.mode);
    return { name: posix.basename(p), path: p, type, size: st.size, mtime: st.mtime * 1000, mode: st.mode & 0o7777, modeStr: modeToString(st.mode, type) };
  }
  async mkdir(p) {
    const s = await this._s();
    try { await this._p(cb => s.mkdir(p, cb)); }
    catch (err) {
      // create parents if needed
      const parent = posix.dirname(p);
      if (parent !== p) {
        try { await this.stat(parent); } catch (_) { await this.mkdir(parent); return this._p(cb => s.mkdir(p, cb)); }
      }
      try { const st = await this.stat(p); if (st.type === 'd') return; } catch (_) {}
      throw err;
    }
  }
  async rename(a, b) { const s = await this._s(); await this._p(cb => s.rename(a, b, cb)); }
  async unlink(p) { const s = await this._s(); await this._p(cb => s.unlink(p, cb)); }
  async rmdir(p) {
    // recursive
    const s = await this._s();
    const items = await this.list(p);
    for (const it of items) {
      if (it.type === 'd') await this.rmdir(it.path); else await this.unlink(it.path);
    }
    await this._p(cb => s.rmdir(p, cb));
  }
  async chmod(p, mode) { const s = await this._s(); await this._p(cb => s.chmod(p, mode, cb)); }
  async readFile(p, limit = 2 * 1024 * 1024) {
    const s = await this._s();
    const st = await this._p(cb => s.stat(p, cb));
    const n = Math.min(st.size, limit);
    const fd = await this._p(cb => s.open(p, 'r', cb));
    try {
      const buf = Buffer.alloc(n); let off = 0;
      while (off < n) {
        const chunk = Math.min(32768, n - off);
        const got = await new Promise((res, rej) => s.read(fd, buf, off, chunk, off, (err, bytes) => err ? rej(err) : res(bytes)));
        if (!got) break; off += got;
      }
      return { data: buf.subarray(0, off), truncated: st.size > limit, size: st.size };
    } finally { await this._p(cb => s.close(fd, cb)); }
  }
  async writeFile(p, data) { const s = await this._s(); await this._p(cb => s.writeFile(p, data, cb)); }
  async downloadFile(remote, local, onBytes) {
    const s = await this._s();
    try {
      await this._p(cb => s.fastGet(remote, local, { concurrency: 16, chunkSize: 32768, step: (total, nb) => onBytes && onBytes(nb) }, cb));
    } catch (err) {
      // fallback: plain stream
      await new Promise((res, rej) => {
        const r = s.createReadStream(remote), w = fs.createWriteStream(local);
        r.on('data', c => onBytes && onBytes(c.length)); r.on('error', rej); w.on('error', rej); w.on('finish', res); r.pipe(w);
      });
    }
  }
  async uploadFile(local, remote, onBytes) {
    const s = await this._s();
    try {
      await this._p(cb => s.fastPut(local, remote, { concurrency: 16, chunkSize: 32768, step: (total, nb) => onBytes && onBytes(nb) }, cb));
    } catch (err) {
      await new Promise((res, rej) => {
        const r = fs.createReadStream(local), w = s.createWriteStream(remote);
        r.on('data', c => onBytes && onBytes(c.length)); r.on('error', rej); w.on('error', rej); w.on('close', res); r.pipe(w);
      });
    }
  }
}

// ---------------- FTP ----------------
class FtpFS {
  constructor(entry) {
    this.kind = 'ftp'; this.entry = entry; this.sep = '/';
    this.client = null; this._chain = Promise.resolve(); this.closed = false;
  }
  join(a, b) { return posix.join(a, b); }
  dirname(p) { return posix.dirname(p); }
  basename(p) { return posix.basename(p); }
  _run(fn) { // serialize all operations on the single control connection
    const p = this._chain.then(fn, fn);
    this._chain = p.catch(() => {});
    return p;
  }
  async connect() {
    const { Client } = require('basic-ftp');
    const c = new Client(30000);
    const e = this.entry;
    await c.access({
      host: e.host, port: e.port || 21, user: e.username || 'anonymous', password: e.password || 'anonymous@',
      secure: e.ftpSecure === 'implicit' ? 'implicit' : e.ftpSecure === 'explicit',
      secureOptions: { rejectUnauthorized: false },
    });
    this.client = c;
    return this;
  }
  close() { this.closed = true; if (this.client) this.client.close(); }
  async home() { return this._run(() => this.client.pwd()); }
  async realpath(p) { return posix.normalize(p); }
  async list(dir) {
    return this._run(async () => {
      const items = await this.client.list(dir);
      return items.map(it => {
        const type = it.type === 2 ? 'd' : it.type === 3 ? 'l' : it.type === 1 ? 'f' : 'o';
        let mode = 0;
        if (it.permissions) mode = (it.permissions.user << 6) | (it.permissions.group << 3) | it.permissions.world;
        const mtime = it.modifiedAt ? it.modifiedAt.getTime() : (it.rawModifiedAt ? Date.parse(it.rawModifiedAt) || 0 : 0);
        const e = { name: it.name, path: posix.join(dir, it.name), type, size: it.size || 0, mtime, mode, modeStr: it.permissions ? modeToString(mode, type) : '', owner: it.user || '', group: it.group || '' };
        if (type === 'l') { e.linkTarget = it.link || ''; e.targetType = 'f'; }
        return e;
      });
    });
  }
  async stat(p) {
    const parent = posix.dirname(p), name = posix.basename(p);
    if (parent === p) return { name: '/', path: '/', type: 'd', size: 0, mtime: 0, mode: 0o755, modeStr: 'drwxr-xr-x' };
    const items = await this.list(parent);
    const it = items.find(x => x.name === name);
    if (!it) { const err = new Error('No such file: ' + p); err.code = 'ENOENT'; throw err; }
    return it;
  }
  async mkdir(p) { return this._run(() => this.client.ensureDir(p).then(() => this.client.cd('/'))); }
  async rename(a, b) { return this._run(() => this.client.rename(a, b)); }
  async unlink(p) { return this._run(() => this.client.remove(p)); }
  async rmdir(p) { return this._run(() => this.client.removeDir(p)); }
  async chmod(p, mode) { return this._run(() => this.client.send(`SITE CHMOD ${mode.toString(8)} ${p}`)); }
  async readFile(p, limit = 2 * 1024 * 1024) {
    const tmp = path.join(os.tmpdir(), 'terhui-' + Date.now() + '.tmp');
    try { await this.downloadFile(p, tmp); const r = await new LocalFS().readFile(tmp, limit); return r; }
    finally { fs.rm(tmp, { force: true }, () => {}); }
  }
  async writeFile(p, data) {
    const tmp = path.join(os.tmpdir(), 'terhui-' + Date.now() + '.tmp');
    await fsp.writeFile(tmp, data);
    try { await this.uploadFile(tmp, p); } finally { fs.rm(tmp, { force: true }, () => {}); }
  }
  async downloadFile(remote, local, onBytes) {
    return this._run(async () => {
      let last = 0;
      this.client.trackProgress(info => { if (onBytes) { onBytes(info.bytes - last); last = info.bytes; } });
      try { await this.client.downloadTo(local, remote); } finally { this.client.trackProgress(); }
    });
  }
  async uploadFile(local, remote, onBytes) {
    return this._run(async () => {
      let last = 0;
      this.client.trackProgress(info => { if (onBytes) { onBytes(info.bytes - last); last = info.bytes; } });
      try { await this.client.uploadFrom(local, remote); } finally { this.client.trackProgress(); }
    });
  }
}

// ---------------- Transfers ----------------
class TransferManager extends EventEmitter {
  constructor() { super(); this.tasks = new Map(); this.nextId = 1; }

  list() { return [...this.tasks.values()].map(t => this._view(t)); }
  _view(t) {
    return { id: t.id, srcLabel: t.srcLabel, dstLabel: t.dstLabel, srcPath: t.srcPath, dstPath: t.dstPath, status: t.status, error: t.error || null,
      bytesDone: t.bytesDone, bytesTotal: t.bytesTotal, filesDone: t.filesDone, filesTotal: t.filesTotal, current: t.current, startedAt: t.startedAt, finishedAt: t.finishedAt };
  }
  _emit(t) { this.emit('progress', this._view(t)); }
  cancel(id) { const t = this.tasks.get(id); if (t) t.cancelled = true; }
  clearFinished() { for (const [id, t] of this.tasks) if (t.status !== 'running' && t.status !== 'queued') this.tasks.delete(id); }

  /**
   * Copy srcPath (file or directory) from srcFS to dstPath on dstFS (dstPath = full destination path incl. name).
   */
  start({ srcFS, srcPath, dstFS, dstPath, srcLabel, dstLabel }) {
    const t = { id: this.nextId++, srcFS, dstFS, srcPath, dstPath, srcLabel, dstLabel, status: 'queued', bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0, current: '', cancelled: false, startedAt: Date.now(), finishedAt: null };
    this.tasks.set(t.id, t);
    this._emit(t);
    (async () => {
      t.status = 'running';
      try {
        const files = []; // {src, dst, size}
        const dirs = [];
        await this._enumerate(t, srcFS, srcPath, dstFS, dstPath, files, dirs);
        t.filesTotal = files.length; t.bytesTotal = files.reduce((a, f) => a + f.size, 0); this._emit(t);
        for (const d of dirs) { if (t.cancelled) throw cancelledErr(); await dstFS.mkdir(d); }
        let lastEmit = 0;
        for (const f of files) {
          if (t.cancelled) throw cancelledErr();
          t.current = f.src;
          await this._copyFile(srcFS, f.src, dstFS, f.dst, (n) => {
            t.bytesDone += n; const now = Date.now();
            if (now - lastEmit > 150) { lastEmit = now; this._emit(t); }
          });
          t.filesDone++; this._emit(t);
        }
        t.status = 'done';
      } catch (err) {
        t.status = t.cancelled ? 'cancelled' : 'error'; t.error = err.message;
      }
      t.current = ''; t.finishedAt = Date.now(); this._emit(t);
    })();
    return t.id;
  }

  async _enumerate(t, srcFS, src, dstFS, dst, files, dirs) {
    if (t.cancelled) throw cancelledErr();
    const st = await srcFS.stat(src);
    if (st.type === 'd') {
      dirs.push(dst);
      const items = await srcFS.list(src);
      for (const it of items) {
        const type = it.type === 'l' ? (it.targetType === 'd' ? 'd' : 'f') : it.type;
        if (type === 'd') await this._enumerate(t, srcFS, it.path, dstFS, dstFS.join(dst, it.name), files, dirs);
        else if (type === 'f') files.push({ src: it.path, dst: dstFS.join(dst, it.name), size: it.size });
      }
    } else {
      files.push({ src, dst, size: st.size });
    }
  }

  async _copyFile(srcFS, src, dstFS, dst, onBytes) {
    if (srcFS.kind === 'local') return dstFS.uploadFile(src, dst, onBytes);
    if (dstFS.kind === 'local') return srcFS.downloadFile(src, dst, onBytes);
    // remote → remote via temp file
    const tmp = path.join(os.tmpdir(), 'terhui-xfer-' + process.pid + '-' + Date.now());
    try { await srcFS.downloadFile(src, tmp, onBytes); await dstFS.uploadFile(tmp, dst, null); }
    finally { fs.rm(tmp, { force: true }, () => {}); }
  }
}

function cancelledErr() { const e = new Error('Cancelled'); e.code = 'CANCELLED'; return e; }

module.exports = { LocalFS, SftpFS, FtpFS, TransferManager, modeToString, typeFromMode };
