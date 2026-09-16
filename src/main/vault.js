'use strict';
// Encrypted credential vault.
// File format: { version, kdf:{name,salt,N,r,p,keyLen}, iv, tag, data } — all binary fields base64.
// Payload is AES-256-GCM(JSON({hosts:[...]})), key = scrypt(masterPassword, salt).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KDF = { name: 'scrypt', N: 1 << 15, r: 8, p: 1, keyLen: 32 };
const KEEP = '__KEEP_SECRET__'; // sentinel: editor sends this when a secret field was not changed

class VaultLockedError extends Error {
  constructor() { super('Vault is locked'); this.code = 'VAULT_LOCKED'; }
}

class Vault {
  constructor(filePath) {
    this.filePath = filePath;
    this.key = null;      // Buffer when unlocked
    this.kdf = null;
    this.hosts = [];
  }

  exists() { return fs.existsSync(this.filePath); }
  isUnlocked() { return this.key !== null; }

  static deriveKey(password, kdf) {
    return crypto.scryptSync(Buffer.from(password, 'utf8'), Buffer.from(kdf.salt, 'base64'), kdf.keyLen, {
      N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024,
    });
  }

  create(password) {
    if (this.exists()) throw new Error('Vault already exists');
    if (typeof password !== 'string' || password.length === 0) throw new Error('Empty master password');
    this.kdf = { ...KDF, salt: crypto.randomBytes(16).toString('base64') };
    this.key = Vault.deriveKey(password, this.kdf);
    this.hosts = [];
    this._save();
  }

  unlock(password) {
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (raw.version !== 1) throw new Error('Unsupported vault version ' + raw.version);
    const key = Vault.deriveKey(password, raw.kdf);
    let plain;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
      plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
    } catch (e) {
      const err = new Error('Wrong master password'); err.code = 'BAD_PASSWORD'; throw err;
    }
    const payload = JSON.parse(plain.toString('utf8'));
    this.kdf = raw.kdf;
    this.key = key;
    this.hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
    return this.hosts.length;
  }

  lock() {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.hosts = [];
  }

  changeMaster(oldPassword, newPassword) {
    this._requireUnlocked();
    const probe = Vault.deriveKey(oldPassword, this.kdf);
    if (!crypto.timingSafeEqual(probe, this.key)) { const e = new Error('Wrong master password'); e.code = 'BAD_PASSWORD'; throw e; }
    if (!newPassword) throw new Error('Empty master password');
    this.kdf = { ...KDF, salt: crypto.randomBytes(16).toString('base64') };
    this.key = Vault.deriveKey(newPassword, this.kdf);
    this._save();
  }

  list() {
    this._requireUnlocked();
    return this.hosts.map(h => Vault.publicView(h));
  }

  get(id) {
    this._requireUnlocked();
    const h = this.hosts.find(x => x.id === id);
    return h ? { ...h } : null;
  }

  upsert(entry) {
    this._requireUnlocked();
    const now = Date.now();
    const clean = Vault.normalize(entry);
    const idx = this.hosts.findIndex(x => x.id === clean.id);
    if (idx >= 0) {
      const prev = this.hosts[idx];
      for (const f of ['password', 'passphrase', 'privateKey']) {
        if (clean[f] === KEEP) clean[f] = prev[f] || '';
      }
      this.hosts[idx] = { ...prev, ...clean, updatedAt: now };
    } else {
      for (const f of ['password', 'passphrase', 'privateKey']) if (clean[f] === KEEP) clean[f] = '';
      this.hosts.push({ ...clean, createdAt: now, updatedAt: now });
    }
    this._save();
    return Vault.publicView(this.hosts.find(x => x.id === clean.id));
  }

  remove(id) {
    this._requireUnlocked();
    const before = this.hosts.length;
    this.hosts = this.hosts.filter(x => x.id !== id);
    if (this.hosts.length !== before) this._save();
    return before !== this.hosts.length;
  }

  exportPlain() {
    this._requireUnlocked();
    return JSON.parse(JSON.stringify(this.hosts));
  }

  importHosts(list, { replace = false } = {}) {
    this._requireUnlocked();
    if (!Array.isArray(list)) throw new Error('Expected array');
    const now = Date.now();
    if (replace) this.hosts = [];
    let added = 0, updated = 0;
    for (const raw of list) {
      const clean = Vault.normalize(raw);
      for (const f of ['password', 'passphrase', 'privateKey']) if (clean[f] === KEEP) clean[f] = '';
      const idx = this.hosts.findIndex(x => x.id === clean.id);
      if (idx >= 0) { this.hosts[idx] = { ...this.hosts[idx], ...clean, updatedAt: now }; updated++; }
      else { this.hosts.push({ ...clean, createdAt: now, updatedAt: now }); added++; }
    }
    this._save();
    return { added, updated };
  }

  static get KEEP() { return KEEP; }

  static normalize(e) {
    const str = v => (v === undefined || v === null) ? '' : String(v);
    const protocol = e.protocol === 'ftp' ? 'ftp' : 'ssh';
    const port = parseInt(e.port, 10);
    return {
      id: str(e.id) || crypto.randomUUID(),
      name: str(e.name).trim(),
      protocol,
      host: str(e.host).trim(),
      port: Number.isFinite(port) && port > 0 && port < 65536 ? port : (protocol === 'ftp' ? 21 : 22),
      username: str(e.username),
      password: str(e.password),
      privateKey: str(e.privateKey),
      privateKeyPath: str(e.privateKeyPath).trim(),
      passphrase: str(e.passphrase),
      useAgent: !!e.useAgent,
      group: str(e.group).trim(),
      color: str(e.color).trim(),
      notes: str(e.notes),
      ftpSecure: (e.ftpSecure === true || e.ftpSecure === 'explicit') ? 'explicit' : (e.ftpSecure === 'implicit' ? 'implicit' : 'none'),
      indexRoot: str(e.indexRoot).trim(),
      startDir: str(e.startDir).trim(),
      localDir: str(e.localDir).trim(),
    };
  }

  // What the renderer is allowed to see (no secrets, only flags that they exist).
  static publicView(h) {
    if (!h) return null;
    const { password, privateKey, passphrase, ...rest } = h;
    return { ...rest, hasPassword: !!password, hasPrivateKey: !!privateKey, hasPassphrase: !!passphrase };
  }

  _requireUnlocked() { if (!this.key) throw new VaultLockedError(); }

  _save() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ hosts: this.hosts }), 'utf8')), cipher.final()]);
    const out = {
      version: 1, kdf: this.kdf,
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}

// Parse ~/.ssh/config into host entries (without secrets).
function parseSshConfig(text) {
  const out = [];
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s*[=\s]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === 'host') {
      cur = null;
      const names = val.split(/\s+/).filter(n => !/[*?!]/.test(n));
      if (names.length) { cur = { name: names[0], host: names[0], protocol: 'ssh', port: 22, username: '', privateKeyPath: '', useAgent: true }; out.push(cur); }
      continue;
    }
    if (!cur) continue;
    if (key === 'hostname') cur.host = val;
    else if (key === 'user') cur.username = val;
    else if (key === 'port') cur.port = parseInt(val, 10) || 22;
    else if (key === 'identityfile') cur.privateKeyPath = val.replace(/^~/, os.homedir());
  }
  return out;
}

module.exports = { Vault, VaultLockedError, parseSshConfig };
