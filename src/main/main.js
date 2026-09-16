'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault, parseSshConfig } = require('./vault');
const { SessionManager, KnownHosts } = require('./ssh-manager');
const { LocalFS, SftpFS, FtpFS, TransferManager } = require('./fs-backends');
const { Indexer } = require('./indexer');

if (process.env.TERHUI_USER_DATA) app.setPath('userData', process.env.TERHUI_USER_DATA);
app.setName('terhui');

const DEFAULT_SETTINGS = {
  locale: 'en', fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Mono", "DejaVu Sans Mono", "Noto Sans Mono", "Noto Color Emoji", monospace',
  fontSize: 14, lineHeight: 1.15, theme: 'Midnight', scrollback: 10000, cursorStyle: 'bar', cursorBlink: true,
  renderer: 'webgl', copyOnSelect: false, rightClickPaste: true, bell: 'none', sidebarWidth: 240, filePanelWidth: 520, filePanelOpen: false,
  localDir: os.homedir(), confirmClose: true, autoLockMinutes: 0, unicodeVersion: '11', ligatures: false,
  // appearance
  bgImage: '', bgDim: 0.55, bgBlur: 0, bgFit: 'cover', termOpacity: 0.85, termPadding: 10, chromeFromTheme: true,
};
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];

let win = null;
let vault, knownHosts, sessions, transfers, indexer, settings;
const localFS = new LocalFS();
const ftpConns = new Map();  // fsId -> FtpFS
const pending = new Map();   // prompt id -> resolve
let promptSeq = 1;

// ---------- settings ----------
function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch (_) { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// ---------- renderer prompts ----------
function askRenderer(kind, payload) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(null);
    const id = promptSeq++;
    pending.set(id, resolve);
    win.webContents.send('prompt', { id, kind, payload });
  });
}
ipcMain.on('prompt:answer', (_e, { id, value }) => {
  const r = pending.get(id);
  if (r) { pending.delete(id); r(value); }
});

const prompter = {
  hostKey: (info) => askRenderer('hostkey', info).then(v => v === true),
  keyboardInteractive: (info) => askRenderer('kbd', info),
  password: (info) => askRenderer('password', info),
};

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

// ---------- FS resolution ----------
function resolveFS(fsId) {
  if (fsId === 'local') return localFS;
  if (fsId.startsWith('sftp:')) return new SftpFS(sessions.require(fsId.slice(5)));
  if (fsId.startsWith('ftp:')) { const f = ftpConns.get(fsId); if (!f) throw new Error('FTP not connected'); return f; }
  throw new Error('Unknown fs ' + fsId);
}

function serializeError(err) {
  const e = new Error(err && err.message ? err.message : String(err));
  if (err && err.code) e.code = err.code;
  return e;
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { return await fn(...args); }
    catch (err) { throw serializeError(err); }
  });
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 860, minWidth: 700, minHeight: 400,
    backgroundColor: '#0e1116', title: 'terhui', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (settings.confirmClose && sessions.sessions.size > 0 && !app.__quitting) {
      const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Close', 'Cancel'], defaultId: 1, cancelId: 1, message: `Close terhui? ${sessions.sessions.size} active session(s) will be disconnected.` });
      if (r === 1) { e.preventDefault(); return; }
    }
    app.__quitting = true;
  });

  const menu = Menu.buildFromTemplate([
    { label: 'terhui', submenu: [
      { label: 'Toggle DevTools', accelerator: 'F12', click: () => win.webContents.toggleDevTools() },
      { label: 'Reload UI', accelerator: 'CmdOrCtrl+Shift+R', click: () => win.reload() },
      { type: 'separator' }, { role: 'quit' } ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]);
  Menu.setApplicationMenu(menu);

  // Debug helpers (used by automated checks): TERHUI_AUTOSCRIPT=<js file>, TERHUI_SCREENSHOT=<png path>[:delayMs]
  win.webContents.on('did-finish-load', async () => {
    if (process.env.TERHUI_AUTOSCRIPT) {
      try { await win.webContents.executeJavaScript(fs.readFileSync(process.env.TERHUI_AUTOSCRIPT, 'utf8'), true); } catch (err) { console.error('autoscript error', err); }
    }
    if (process.env.TERHUI_SCREENSHOT) {
      const [file, delay] = process.env.TERHUI_SCREENSHOT.split(':');
      setTimeout(async () => {
        try { const img = await win.webContents.capturePage(); fs.writeFileSync(file, img.toPNG()); console.log('screenshot saved', file); } catch (err) { console.error(err); }
        if (process.env.TERHUI_EXIT_AFTER_SHOT) { app.__quitting = true; app.quit(); }
      }, parseInt(delay || '3000', 10));
    }
  });
}

// ---------- IPC ----------
function registerIpc() {
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, home: os.homedir(), userData: app.getPath('userData'), agent: !!process.env.SSH_AUTH_SOCK }));
  handle('settings:get', () => settings);
  handle('settings:set', (patch) => { settings = { ...settings, ...patch }; saveSettings(); return settings; });

  // vault
  handle('vault:status', () => ({ exists: vault.exists(), unlocked: vault.isUnlocked() }));
  handle('vault:create', (pw) => { vault.create(pw); return true; });
  handle('vault:unlock', (pw) => vault.unlock(pw));
  handle('vault:lock', () => { vault.lock(); return true; });
  handle('vault:changeMaster', (o, n) => { vault.changeMaster(o, n); return true; });

  // hosts
  handle('hosts:list', () => vault.list());
  handle('hosts:get', (id) => Vault.publicView(vault.get(id)));
  handle('hosts:save', (entry) => vault.upsert(entry));
  handle('hosts:remove', (id) => vault.remove(id));
  handle('hosts:importSshConfig', () => {
    const f = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(f)) return { added: 0, updated: 0 };
    const list = parseSshConfig(fs.readFileSync(f, 'utf8')).map(h => ({ ...h, group: 'ssh-config' }));
    const existing = vault.list();
    const fresh = list.filter(h => !existing.some(e => e.host === h.host && e.port === h.port && e.username === h.username));
    return vault.importHosts(fresh);
  });
  handle('hosts:exportFile', async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Export hosts (plain JSON, contains secrets!)', defaultPath: 'terhui-hosts.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return false;
    fs.writeFileSync(r.filePath, JSON.stringify(vault.exportPlain(), null, 2), { mode: 0o600 });
    return true;
  });
  handle('hosts:importFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import hosts JSON', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return vault.importHosts(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
  });
  handle('hosts:readKeyFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select private key', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], content: fs.readFileSync(r.filePaths[0], 'utf8') };
  });
  handle('knownhosts:list', () => knownHosts.all());
  handle('knownhosts:remove', (host, port) => { knownHosts.remove(host, port); return true; });

  // ssh
  handle('ssh:connect', async ({ hostId, entry, cols, rows }) => {
    const full = hostId ? vault.get(hostId) : Vault.normalize(entry || {});
    if (!full) throw new Error('Host not found');
    if (full.protocol !== 'ssh') throw new Error('Terminal is SSH-only; this host is ' + full.protocol);
    const s = await sessions.connect(full);
    const sid = s.id;
    s.on('data', (d) => send('ssh:data', { sessionId: sid, data: d }));
    s.on('status', (status, detail) => send('ssh:status', { sessionId: sid, status, detail }));
    s.on('close', (reason) => send('ssh:closed', { sessionId: sid, reason }));
    s.on('shell-close', (info) => send('ssh:shell-closed', { sessionId: sid, ...info }));
    s.on('banner', (msg) => send('ssh:banner', { sessionId: sid, msg }));
    s.on('error', (err) => send('ssh:error', { sessionId: sid, message: err.message }));
    await s.openShell(cols, rows);
    if (full.startDir) s.write(`cd ${shq(full.startDir)}\n`);
    return { sessionId: sid, hostId: full.id, host: full.host, username: s.entry.username };
  });
  ipcMain.on('ssh:write', (_e, { sessionId, data }) => { const s = sessions.get(sessionId); if (s) s.write(data); });
  ipcMain.on('ssh:resize', (_e, { sessionId, cols, rows }) => { const s = sessions.get(sessionId); if (s) s.resize(cols, rows); });
  handle('ssh:close', (sessionId) => { const s = sessions.get(sessionId); if (s) s.close(); return true; });
  handle('ssh:exec', (sessionId, cmd) => sessions.require(sessionId).exec(cmd, { timeout: 60000 }));

  // fs
  handle('fs:ftpConnect', async (hostId) => {
    const full = vault.get(hostId);
    if (!full) throw new Error('Host not found');
    const f = await new FtpFS(full).connect();
    const id = 'ftp:' + hostId + ':' + Date.now();
    ftpConns.set(id, f);
    return { fsId: id, home: await f.home() };
  });
  handle('fs:ftpClose', (fsId) => { const f = ftpConns.get(fsId); if (f) { f.close(); ftpConns.delete(fsId); } return true; });
  handle('fs:home', (fsId) => resolveFS(fsId).home());
  handle('fs:list', async (fsId, p) => { const f = resolveFS(fsId); const real = f.kind === 'ftp' ? p : await f.realpath(p); return { path: real, items: await f.list(real) }; });
  handle('fs:stat', (fsId, p) => resolveFS(fsId).stat(p));
  handle('fs:mkdir', (fsId, p) => resolveFS(fsId).mkdir(p));
  handle('fs:rename', (fsId, a, b) => resolveFS(fsId).rename(a, b));
  handle('fs:delete', async (fsId, p, isDir) => { const f = resolveFS(fsId); return isDir ? f.rmdir(p) : f.unlink(p); });
  handle('fs:chmod', (fsId, p, mode) => resolveFS(fsId).chmod(p, mode));
  handle('fs:readFile', async (fsId, p, limit) => { const r = await resolveFS(fsId).readFile(p, limit || 1024 * 1024); return { text: r.data.toString('utf8'), truncated: r.truncated, size: r.size, binary: isBinary(r.data) }; });
  handle('fs:writeFile', (fsId, p, text) => resolveFS(fsId).writeFile(p, Buffer.from(text, 'utf8')));
  handle('fs:openLocal', (p) => shell.openPath(p));
  handle('fs:showLocal', (p) => { shell.showItemInFolder(p); return true; });

  // transfers
  handle('xfer:start', ({ src, dst, srcLabel, dstLabel }) => transfers.start({ srcFS: resolveFS(src.fsId), srcPath: src.path, dstFS: resolveFS(dst.fsId), dstPath: dst.path, srcLabel, dstLabel }));
  handle('xfer:list', () => transfers.list());
  handle('xfer:cancel', (id) => { transfers.cancel(id); return true; });
  handle('xfer:clear', () => { transfers.clearFinished(); return transfers.list(); });

  // indexer
  handle('index:info', (hostId) => indexer.info(hostId));
  handle('index:build', async (hostId, { sessionId, fsId, root, includeFiles }) => {
    if (sessionId) return indexer.buildSsh(hostId, sessions.require(sessionId), { root: root || '/', includeFiles: !!includeFiles });
    return indexer.buildWalk(hostId, resolveFS(fsId), { root: root || '/', includeFiles: !!includeFiles });
  });
  handle('index:search', (hostId, q, limit) => indexer.search(hostId, q, { limit: limit || 100 }));
  handle('index:cancel', (hostId) => { indexer.cancel(hostId); return true; });
  handle('index:clear', (hostId) => { indexer.clear(hostId); return true; });

  // dialogs, clipboard, misc
  handle('dialog:open', async (opts) => { const r = await dialog.showOpenDialog(win, opts); return r.canceled ? null : r.filePaths; });
  handle('dialog:save', async (opts) => { const r = await dialog.showSaveDialog(win, opts); return r.canceled ? null : r.filePath; });
  handle('dialog:confirm', async ({ message, detail, buttons }) => {
    const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: (buttons || ['OK', 'Cancel']).length - 1 });
    return r.response;
  });
  // appearance: custom themes + wallpaper
  const themesDir = () => path.join(app.getPath('userData'), 'themes');
  const listThemes = () => {
    const out = {};
    try { for (const f of fs.readdirSync(themesDir())) { if (!f.endsWith('.json')) continue; try { const j = JSON.parse(fs.readFileSync(path.join(themesDir(), f), 'utf8')); out[j.name || f.replace(/\.json$/, '')] = j; } catch (_) {} } } catch (_) {}
    return out;
  };
  handle('themes:list', () => listThemes());
  handle('themes:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import colour scheme (xterm / Windows Terminal JSON)', properties: ['openFile', 'multiSelections'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return listThemes();
    fs.mkdirSync(themesDir(), { recursive: true });
    for (const f of r.filePaths) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const items = Array.isArray(j) ? j : (Array.isArray(j.schemes) ? j.schemes : [j]);   // support a whole Windows Terminal settings.json too
      for (const it of items) { const name = it.name || path.basename(f, '.json'); fs.writeFileSync(path.join(themesDir(), name.replace(/[^\w .-]+/g, '_') + '.json'), JSON.stringify({ ...it, name }, null, 2)); }
    }
    return listThemes();
  });
  handle('themes:save', (name, theme) => { fs.mkdirSync(themesDir(), { recursive: true }); fs.writeFileSync(path.join(themesDir(), name.replace(/[^\w .-]+/g, '_') + '.json'), JSON.stringify({ ...theme, name }, null, 2)); return listThemes(); });
  handle('themes:delete', (name) => { try { fs.unlinkSync(path.join(themesDir(), name.replace(/[^\w .-]+/g, '_') + '.json')); } catch (_) {} return listThemes(); });
  handle('wallpaper:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose wallpaper', properties: ['openFile'], filters: [{ name: 'Images', extensions: IMAGE_EXT }] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('wallpaper:read', (p) => {
    if (!p) return null;
    const st = fs.statSync(p);
    if (st.size > 40 * 1024 * 1024) throw new Error('Image too large (max 40 MB)');
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' }[ext] || 'application/octet-stream';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  });
  handle('clipboard:read', () => clipboard.readText());
  handle('clipboard:write', (t) => { clipboard.writeText(String(t)); return true; });
  handle('shell:openExternal', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
  handle('window:setTitle', (t) => { if (win) win.setTitle(t); return true; });
  handle('theme:native', () => nativeTheme.shouldUseDarkColors);
}

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function isBinary(buf) { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return true; } return false; }

// ---------- lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    const ud = app.getPath('userData');
    settings = loadSettings();
    vault = new Vault(path.join(ud, 'vault.json'));
    knownHosts = new KnownHosts(path.join(ud, 'known_hosts.json'));
    sessions = new SessionManager({ knownHosts, prompter });
    transfers = new TransferManager();
    transfers.on('progress', (v) => send('xfer:progress', v));
    indexer = new Indexer(path.join(ud, 'index'));
    indexer.on('progress', (p) => send('index:progress', p));
    registerIpc();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', () => { app.__quitting = true; try { sessions && sessions.closeAll(); for (const f of ftpConns.values()) f.close(); } catch (_) {} });
}
