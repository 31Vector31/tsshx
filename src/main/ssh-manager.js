'use strict';
// SSH session management on top of ssh2: connection, interactive shell, exec, SFTP, host-key verification.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { Client } = require('ssh2');

// ---------- known hosts (TOFU) ----------
class KnownHosts {
  constructor(filePath) {
    this.filePath = filePath;
    this.map = {};
    try { this.map = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {}; } catch (_) { this.map = {}; }
  }
  static keyOf(host, port) { return `[${host}]:${port}`; }
  get(host, port) { return this.map[KnownHosts.keyOf(host, port)] || null; }
  set(host, port, keyType, fingerprint) {
    this.map[KnownHosts.keyOf(host, port)] = { keyType, fingerprint, addedAt: Date.now() };
    this._save();
  }
  remove(host, port) { delete this.map[KnownHosts.keyOf(host, port)]; this._save(); }
  all() { return { ...this.map }; }
  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.map, null, 2), { mode: 0o600 });
  }
}

// Parse SSH public key blob → { type, fingerprint } (OpenSSH style "SHA256:base64-without-padding")
function describeHostKey(blob) {
  let type = 'unknown';
  try {
    const len = blob.readUInt32BE(0);
    type = blob.subarray(4, 4 + len).toString('ascii');
  } catch (_) { /* ignore */ }
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { type, fingerprint };
}

// ---------- session ----------
let nextSessionId = 1;

class SshSession extends EventEmitter {
  /**
   * @param entry full host entry (with secrets) from the vault
   * @param opts { knownHosts: KnownHosts, prompter: { hostKey(info)→Promise<bool>, keyboardInteractive(info)→Promise<string[]|null>, password(info)→Promise<string|null> } }
   */
  constructor(entry, opts) {
    super();
    this.id = String(nextSessionId++);
    this.entry = entry;
    this.knownHosts = opts.knownHosts;
    this.prompter = opts.prompter;
    this.client = null;
    this.shellStream = null;
    this._sftp = null;
    this._sftpPromise = null;
    this.status = 'idle';
    this.closed = false;
    this.passwordUsedForKbd = false;
  }

  _setStatus(s, detail) { this.status = s; this.emit('status', s, detail); }

  async _buildConfig() {
    const e = this.entry;
    const cfg = {
      host: e.host, port: e.port || 22, username: e.username || process.env.USER || 'root',
      readyTimeout: 25000, keepaliveInterval: 15000, keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (blob, verify) => { this._verifyHost(blob).then(ok => verify(ok), () => verify(false)); }, // must not return a value (ssh2 treats any return as the verdict)
    };
    let haveAuth = false;
    if (e.privateKey) { cfg.privateKey = e.privateKey; haveAuth = true; }
    else if (e.privateKeyPath) {
      cfg.privateKey = fs.readFileSync(e.privateKeyPath.replace(/^~/, require('os').homedir()));
      haveAuth = true;
    }
    if (cfg.privateKey && e.passphrase) cfg.passphrase = e.passphrase;
    if (e.useAgent && process.env.SSH_AUTH_SOCK) { cfg.agent = process.env.SSH_AUTH_SOCK; haveAuth = true; }
    if (e.password) { cfg.password = e.password; haveAuth = true; }
    if (!haveAuth && this.prompter && this.prompter.password) {
      const pw = await this.prompter.password({ host: e.host, port: cfg.port, username: cfg.username });
      if (pw === null || pw === undefined) { const err = new Error('Authentication cancelled'); err.code = 'CANCELLED'; throw err; }
      cfg.password = pw;
      this.entry = { ...e, password: pw };
    }
    return cfg;
  }

  async _verifyHost(blob) {
    const { type, fingerprint } = describeHostKey(blob);
    const e = this.entry; const port = e.port || 22;
    const known = this.knownHosts.get(e.host, port);
    if (known && known.fingerprint === fingerprint) return true;
    const info = { host: e.host, port, keyType: type, fingerprint, changed: !!known, previous: known ? known.fingerprint : null };
    let ok = false;
    if (this.prompter && this.prompter.hostKey) ok = await this.prompter.hostKey(info);
    if (ok) this.knownHosts.set(e.host, port, type, fingerprint);
    return !!ok;
  }

  connect() {
    return new Promise(async (resolve, reject) => {
      let cfg;
      try { cfg = await this._buildConfig(); } catch (err) { this._setStatus('error', err.message); return reject(err); }
      const client = new Client();
      this.client = client;
      this._setStatus('connecting');
      let settled = false;
      client.on('ready', () => { settled = true; this._setStatus('connected'); resolve(this); });
      client.on('error', (err) => {
        if (!settled) { settled = true; this._setStatus('error', err.message); reject(err); }
        else this.emit('error', err);
      });
      client.on('end', () => this._onClose('end'));
      client.on('close', () => this._onClose('close'));
      client.on('keyboard-interactive', async (name, instructions, lang, prompts, finish) => {
        // Auto-answer a single password prompt with the stored password (once).
        const stored = this.entry.password;
        if (stored && !this.passwordUsedForKbd && prompts.length === 1 && /pass/i.test(prompts[0].prompt)) {
          this.passwordUsedForKbd = true;
          return finish([stored]);
        }
        if (this.prompter && this.prompter.keyboardInteractive) {
          try {
            const answers = await this.prompter.keyboardInteractive({ name, instructions, prompts: prompts.map(p => ({ prompt: p.prompt, echo: !!p.echo })) });
            if (Array.isArray(answers)) return finish(answers);
          } catch (_) { /* fallthrough */ }
        }
        finish([]);
      });
      client.on('banner', (msg) => this.emit('banner', msg));
      try { client.connect(cfg); } catch (err) { settled = true; this._setStatus('error', err.message); reject(err); }
    });
  }

  _onClose(reason) {
    if (this.closed) return;
    this.closed = true;
    this._sftp = null;
    this._setStatus('closed', reason);
    this.emit('close', reason);
  }

  openShell(cols, rows) {
    return new Promise((resolve, reject) => {
      if (!this.client || this.closed) return reject(new Error('Not connected'));
      const win = { term: 'xterm-256color', cols: cols || 80, rows: rows || 24 };
      const opts = { env: { COLORTERM: 'truecolor', LANG: process.env.LANG || 'C.UTF-8' } };
      this.client.shell(win, opts, (err, stream) => {
        if (err) return reject(err);
        this.shellStream = stream;
        stream.on('data', (d) => this.emit('data', d));
        stream.stderr.on('data', (d) => this.emit('data', d));
        stream.on('close', (code, signal) => { this.shellStream = null; this.emit('shell-close', { code, signal }); });
        resolve(stream);
      });
    });
  }

  write(data) { if (this.shellStream && this.shellStream.writable) this.shellStream.write(data); }
  resize(cols, rows) { if (this.shellStream) this.shellStream.setWindow(rows, cols, 0, 0); }
  sendSignal(sig) { if (this.shellStream) try { this.shellStream.signal(sig); } catch (_) {} }

  /** Run a command, collect output. */
  exec(cmd, { maxOutput = 4 * 1024 * 1024, stdin = null, timeout = 0 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client || this.closed) return reject(new Error('Not connected'));
      this.client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        const out = [], errs = []; let outLen = 0, errLen = 0; let timer = null;
        if (timeout) timer = setTimeout(() => { try { stream.close(); } catch (_) {} reject(new Error('exec timeout')); }, timeout);
        stream.on('data', (d) => { if (outLen < maxOutput) { out.push(d); outLen += d.length; } });
        stream.stderr.on('data', (d) => { if (errLen < maxOutput) { errs.push(d); errLen += d.length; } });
        stream.on('close', (code, signal) => {
          if (timer) clearTimeout(timer);
          resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errs).toString('utf8') });
        });
        stream.on('error', reject);
        if (stdin !== null) stream.end(stdin);
      });
    });
  }

  /** Run a command and get the raw channel stream (for large streaming output). */
  execStream(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.client || this.closed) return reject(new Error('Not connected'));
      this.client.exec(cmd, (err, stream) => err ? reject(err) : resolve(stream));
    });
  }

  sftp() {
    if (this._sftp) return Promise.resolve(this._sftp);
    if (this._sftpPromise) return this._sftpPromise;
    this._sftpPromise = new Promise((resolve, reject) => {
      if (!this.client || this.closed) return reject(new Error('Not connected'));
      this.client.sftp((err, sftp) => {
        this._sftpPromise = null;
        if (err) return reject(err);
        this._sftp = sftp;
        sftp.on('close', () => { if (this._sftp === sftp) this._sftp = null; });
        sftp.on('error', () => { if (this._sftp === sftp) this._sftp = null; });
        resolve(sftp);
      });
    });
    return this._sftpPromise;
  }

  close() {
    if (this.shellStream) { try { this.shellStream.end(); } catch (_) {} }
    if (this.client) { try { this.client.end(); } catch (_) {} }
    setTimeout(() => this._onClose('closed-by-user'), 50);
  }
}

class SessionManager {
  constructor({ knownHosts, prompter }) {
    this.knownHosts = knownHosts;
    this.prompter = prompter;
    this.sessions = new Map();
  }
  async connect(entry, prompterOverride) {
    const s = new SshSession(entry, { knownHosts: this.knownHosts, prompter: prompterOverride || this.prompter });
    this.sessions.set(s.id, s);
    s.on('close', () => { setTimeout(() => this.sessions.delete(s.id), 1000); });
    try { await s.connect(); } catch (err) { this.sessions.delete(s.id); throw err; }
    return s;
  }
  get(id) { return this.sessions.get(String(id)) || null; }
  require(id) { const s = this.get(id); if (!s || s.closed) throw new Error('Session not connected'); return s; }
  closeAll() { for (const s of this.sessions.values()) s.close(); }
}

module.exports = { SessionManager, SshSession, KnownHosts, describeHostKey };
