'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu, nativeTheme, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault, parseSshConfig } = require('./vault');
const { SessionManager, KnownHosts } = require('./ssh-manager');
const { LocalFS, SftpFS, FtpFS, TransferManager } = require('./fs-backends');
const { Indexer } = require('./indexer');
const { HistoryStore } = require('./history');
const { LocalShellManager, detectProfiles, localHistoryFiles } = require('./local-shell');
const stats = require('./stats');
const { QuickUnlock } = require('./quick-unlock');

if (process.env.TERHUI_USER_DATA) app.setPath('userData', process.env.TERHUI_USER_DATA);
app.setName('terhui');

// ---------- diagnostics: nothing may fail silently ----------
const SAFE_MODE = process.argv.includes('--safe');
function logLine(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map(p => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(path.join(app.getPath('userData'), 'terhui.log'), line); } catch (_) {}
  if (process.env.TERHUI_DEBUG || SAFE_MODE) process.stderr.write(line);
}
function fatal(where, err) {
  logLine('FATAL', where, err);
  const msg = `${where}\n\n${err && err.stack ? err.stack : err}\n\nLog: ${path.join(app.getPath('userData'), 'terhui.log')}`;
  try { if (app.isReady()) dialog.showErrorBox('terhui: startup error', msg); else app.whenReady().then(() => dialog.showErrorBox('terhui: startup error', msg)); } catch (_) {}
}
process.on('uncaughtException', (err) => fatal('uncaughtException', err));
process.on('unhandledRejection', (err) => fatal('unhandledRejection', err));

const DEFAULT_SETTINGS = {
  locale: 'en', fontFamily: '"JetBrainsMono Nerd Font Mono", "CaskaydiaCove Nerd Font Mono", "CaskaydiaCove NF", "FiraCode Nerd Font Mono", "MesloLGS NF", "Hack Nerd Font Mono", "JetBrains Mono", "Cascadia Mono", "Fira Code", "DejaVu Sans Mono", "Noto Sans Mono", "Symbols Nerd Font Mono", "Noto Color Emoji", monospace',
  fontSize: 14, lineHeight: 1.15, theme: 'Midnight', scrollback: 10000, cursorStyle: 'bar', cursorBlink: true,
  renderer: 'webgl', copyOnSelect: false, rightClickPaste: true, bell: 'none', sidebarWidth: 240, filePanelWidth: 520, filePanelOpen: false,
  localDir: os.homedir(), confirmClose: true, autoLockMinutes: 0, unicodeVersion: '11', ligatures: false,
  // appearance
  bgImage: '', bgDim: 0.55, bgBlur: 0, bgFit: 'cover', termOpacity: 0.85, termPadding: 10, chromeFromTheme: true,
  // window chrome: 'integrated' = OS frame + Window Controls Overlay (tabs live in the title bar), 'native' = plain OS title bar
  windowFrame: 'integrated', winMaterial: 'none', chromeBg: '#202329', chromeFg: '#d4d7dd',
  shellIntegration: true, ctrlWClosesTab: false,
  localProfiles: null,   // null = not detected yet; [] = user removed all
  recent: [],            // last connections shown in the sidebar footer
};
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];

let win = null;
let vault, knownHosts, sessions, transfers, indexer, settings, history, shells, quick;
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
    const target = dlgWin();
    if (!target || target.isDestroyed()) return resolve(null);
    const id = promptSeq++;
    pending.set(id, resolve);
    target.webContents.send('prompt', { id, kind, payload });
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
function sendAll(channel, payload) { for (const w of windows) if (!w.isDestroyed()) w.webContents.send(channel, payload); }

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
    try { return await fn.call({ sender: event.sender }, ...args); }
    catch (err) { throw serializeError(err); }
  });
}

// ---------- windows & session ownership ----------
// Sessions (SSH, pty) live here in main; a tab can be torn off into its own window, so every session has an
// owning webContents that receives its data. Falls back to the main window when the owner is gone.
const owners = new Map();   // sessionId -> webContents
const windows = new Set();  // all BrowserWindows (main + detached)
const focusOrder = [];      // most recently focused first (to pick the topmost window under the cursor)
function trackWindow(w) { windows.add(w); focusOrder.unshift(w); w.on('focus', () => { const i = focusOrder.indexOf(w); if (i > 0) { focusOrder.splice(i, 1); focusOrder.unshift(w); } }); w.on('closed', () => { windows.delete(w); const i = focusOrder.indexOf(w); if (i >= 0) focusOrder.splice(i, 1); }); }
function sendSession(sessionId, channel, payload) {
  const wc = owners.get(sessionId);
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  else if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const dlgWin = () => BrowserWindow.getFocusedWindow() || win;
function sessionsOwnedBy(wc) { const out = []; for (const [id, w] of owners) if (w === wc) out.push(id); return out; }
function killSession(id) { const s = sessions.get(id); if (s) s.close(); else shells.kill(id); owners.delete(id); }

// ---------- window ----------
function frameOptions() {
  const integrated = settings.windowFrame !== 'native' && !SAFE_MODE;
  const material = !SAFE_MODE && process.platform === 'win32' && settings.winMaterial && settings.winMaterial !== 'none' ? settings.winMaterial : null;
  const frameOpts = {};
  if (integrated) {
    if (process.platform === 'darwin') { frameOpts.titleBarStyle = 'hiddenInset'; frameOpts.trafficLightPosition = { x: 12, y: 9 }; frameOpts.titleBarOverlay = true; }   // overlay=true exposes the traffic-light geometry to CSS env()
    else { frameOpts.titleBarStyle = 'hidden'; frameOpts.titleBarOverlay = { color: settings.chromeBg, symbolColor: settings.chromeFg, height: 32 }; }
  }
  if (material) { frameOpts.backgroundMaterial = material; }   // Windows 11 Mica / Acrylic; needs a transparent page background
  return { frameOpts, material };
}

/** A torn-off window: same renderer in "detached" mode (terminal tabs only), sessions are handed over via owners. */
function createDetachedWindow({ x, y, width, height }, payload) {
  const { frameOpts, material } = frameOptions();
  const w = new BrowserWindow({
    width: Math.max(500, width || 900), height: Math.max(300, height || 560), minWidth: 400, minHeight: 250, ...frameOpts,
    x: Number.isFinite(x) ? Math.round(x) : undefined, y: Number.isFinite(y) ? Math.round(y) : undefined,
    backgroundColor: material ? '#00000000' : settings.chromeBg, title: 'terhui', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  trackWindow(w);
  for (const p of payload.panes) if (p.sessionId) owners.set(p.sessionId, w.webContents);
  w.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { detached: '1' } });
  w.webContents.once('did-finish-load', async () => {
    w.webContents.send('detach:init', payload); setTimeout(() => { if (!w.isDestroyed() && !w.isVisible()) w.show(); }, 150);
    if (process.env.TERHUI_AUTOSCRIPT2) { try { if (process.env.TERHUI_PROBE) await w.webContents.executeJavaScript(fs.readFileSync(process.env.TERHUI_PROBE, 'utf8'), true); } catch (_) {} try { await w.webContents.executeJavaScript(fs.readFileSync(process.env.TERHUI_AUTOSCRIPT2, 'utf8'), true); } catch (err) { console.error('autoscript2 error', err); } }   // test hook
    if (process.env.TERHUI_SCREENSHOT2) { const [file, delay] = process.env.TERHUI_SCREENSHOT2.split(':'); setTimeout(async () => { try { fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG()); } catch (_) {} }, Number(delay) || 3000); }
  });
  w.once('ready-to-show', () => w.show());
  w.on('enter-full-screen', () => w.webContents.send('window:fullscreen', true));
  w.on('leave-full-screen', () => w.webContents.send('window:fullscreen', false));
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  w.on('close', (e) => {
    if (app.__quitting) return;
    const mine = sessionsOwnedBy(w.webContents).filter(id => sessions.get(id) || shells.sessions.get(id));
    if (mine.length && settings.confirmClose) {
      const r = dialog.showMessageBoxSync(w, { type: 'question', buttons: ['Close', 'Cancel'], defaultId: 1, cancelId: 1, message: `Close this window? ${mine.length} session(s) will be disconnected.` });
      if (r === 1) { e.preventDefault(); return; }
    }
    for (const id of mine) killSession(id);
  });
  return w;
}

function createWindow() {
  const { frameOpts, material } = frameOptions();
  nativeTheme.themeSource = isDarkHex(settings.chromeBg) ? 'dark' : 'light';   // dark DWM title bar when the native frame is used
  win = new BrowserWindow({
    width: 1400, height: 860, minWidth: 700, minHeight: 400, ...frameOpts,
    backgroundColor: material ? '#00000000' : settings.chromeBg, title: 'terhui', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  trackWindow(win);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  // Show as soon as anything is ready. On some Windows setups 'ready-to-show' never fires for a
  // titleBarOverlay window, so 'did-finish-load' and a hard timer are fallbacks — never stay hidden.
  const reveal = (why) => { if (win && !win.isDestroyed() && !win.isVisible()) { logLine('show window:', why); win.show(); } };
  win.once('ready-to-show', () => reveal('ready-to-show'));
  win.webContents.once('did-finish-load', () => setTimeout(() => reveal('did-finish-load'), 200));
  setTimeout(() => reveal('timeout'), 4000);
  win.webContents.on('did-fail-load', (_e, code, desc, url) => fatal('Page failed to load', new Error(`${code} ${desc} ${url}`)));
  win.webContents.on('preload-error', (_e, p, err) => fatal('Preload error in ' + p, err));
  win.webContents.on('render-process-gone', (_e, d) => fatal('Renderer process gone', new Error(JSON.stringify(d))));
  win.webContents.on('console-message', (ev, ...legacy) => {   // Electron ≥ 32 passes an event object; older versions positional args
    const level = ev && ev.level !== undefined ? ev.level : legacy[0]; const message = ev && ev.message !== undefined ? ev.message : legacy[1];
    const line = ev && ev.lineNumber !== undefined ? ev.lineNumber : legacy[2]; const source = ev && ev.sourceId !== undefined ? ev.sourceId : legacy[3];
    const bad = typeof level === 'number' ? level >= 2 : (level === 'warning' || level === 'error');
    if (bad || process.env.TERHUI_DEBUG) logLine('renderer', level === 'error' || level === 3 ? 'ERROR' : 'warn', message, `${source}:${line}`);
  });
  logLine('window created', { platform: process.platform, electron: process.versions.electron, frame: frameOpts, safe: SAFE_MODE, userData: app.getPath('userData') });
  win.on('closed', () => { win = null; });
  win.on('enter-full-screen', () => send('window:fullscreen', true));
  win.on('leave-full-screen', () => send('window:fullscreen', false));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (settings.confirmClose && sessions.sessions.size > 0 && !app.__quitting) {
      const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Close', 'Cancel'], defaultId: 1, cancelId: 1, message: `Close terhui? ${sessions.sessions.size + shells.sessions.size} active session(s) will be disconnected.` });
      if (r === 1) { e.preventDefault(); return; }
    }
    app.__quitting = true;
  });

  const menu = Menu.buildFromTemplate([
    { label: 'terhui', submenu: [
      { label: 'Toggle DevTools', accelerator: 'F12', click: () => win.webContents.toggleDevTools() },
      { label: 'Reload UI', accelerator: 'CmdOrCtrl+Alt+R', click: () => win.reload() },
      { type: 'separator' }, { role: 'quit' } ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]);
  Menu.setApplicationMenu(menu);

  // Debug helpers (used by automated checks): TERHUI_AUTOSCRIPT=<js file>, TERHUI_SCREENSHOT=<png path>[:delayMs]
  win.webContents.on('did-finish-load', async () => {
    if (process.env.TERHUI_AUTOSCRIPT) {
      try { if (process.env.TERHUI_PROBE) await win.webContents.executeJavaScript(fs.readFileSync(process.env.TERHUI_PROBE, 'utf8'), true); } catch (_) {}
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
  handle('vault:changeMaster', async (o, n) => { vault.changeMaster(o, n); if (quick.enabled()) { try { await quick.enable(vault.exportKey()); } catch (_) { quick.disable(); } } return true; });
  // quick unlock (Touch ID / Windows Hello)
  handle('quick:status', async () => ({ method: await quick.method(), enabled: quick.enabled() }));
  handle('quick:enable', async () => { await quick.enable(vault.exportKey()); return true; });
  handle('quick:disable', () => { quick.disable(); return true; });
  handle('quick:unlock', async () => {
    const key = await quick.unlock('Unlock the terhui vault');
    try { return vault.unlockWithKey(key); }
    catch (err) { if (err.code === 'BAD_KEY') quick.disable(); throw err; }
    finally { key.fill(0); }
  });

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
    const r = await dialog.showSaveDialog(dlgWin(), { title: 'Export hosts (plain JSON, contains secrets!)', defaultPath: 'terhui-hosts.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return false;
    fs.writeFileSync(r.filePath, JSON.stringify(vault.exportPlain(), null, 2), { mode: 0o600 });
    return true;
  });
  handle('hosts:importFile', async () => {
    const r = await dialog.showOpenDialog(dlgWin(), { title: 'Import hosts JSON', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return vault.importHosts(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
  });
  handle('hosts:readKeyFile', async () => {
    const r = await dialog.showOpenDialog(dlgWin(), { title: 'Select private key', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], content: fs.readFileSync(r.filePaths[0], 'utf8') };
  });
  // cached per-host data (directory index, app-side history, pins, remembered host key) — for hosts that were reinstalled
  handle('cache:clear', ({ hostKey, index, history: hist, knownHost: hk }) => {
    if (index) indexer.clear(hostKey);
    if (hist) history.clearHost(hostKey);
    if (hk && hk.host) knownHosts.remove(hk.host, hk.port || 22);
    return true;
  });
  handle('cache:clearAll', () => { indexer.clearAll(); history.clearHost(null); return true; });
  handle('knownhosts:list', () => knownHosts.all());
  handle('knownhosts:remove', (host, port) => { knownHosts.remove(host, port); return true; });

  // ssh
  handle('ssh:connect', async function ({ hostId, entry, cols, rows }) {
    const full = hostId ? vault.get(hostId) : Vault.normalize(entry || {});
    if (!full) throw new Error('Host not found');
    if (full.protocol !== 'ssh') throw new Error('Terminal is SSH-only; this host is ' + full.protocol);
    const s = await sessions.connect(full);
    const sid = s.id;
    owners.set(sid, this.sender);
    s.on('data', (d) => sendSession(sid, 'ssh:data', { sessionId: sid, data: d }));
    s.on('status', (status, detail) => sendSession(sid, 'ssh:status', { sessionId: sid, status, detail }));
    s.on('close', (reason) => { sendSession(sid, 'ssh:closed', { sessionId: sid, reason }); owners.delete(sid); });
    s.on('shell-close', (info) => sendSession(sid, 'ssh:shell-closed', { sessionId: sid, ...info }));
    s.on('banner', (msg) => sendSession(sid, 'ssh:banner', { sessionId: sid, msg }));
    s.on('error', (err) => sendSession(sid, 'ssh:error', { sessionId: sid, message: err.message }));
    await s.openShell(cols, rows);
    if (full.startDir && settings.shellIntegration === false) s.write(`cd ${shq(full.startDir)}\n`);   // otherwise the renderer's shell bootstrap does it
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
  // local terminals
  handle('profiles:list', () => {
    if (!Array.isArray(settings.localProfiles)) { settings.localProfiles = detectProfiles(); saveSettings(); }
    let changed = false;   // migrate WSL profiles saved before `--cd ~` / `wsl` existed
    for (const p of settings.localProfiles) { if (/wsl\.exe$/i.test(p.command)) { const i = (p.args || []).indexOf('-d'); if (!p.wsl && i >= 0) { p.wsl = p.args[i + 1]; changed = true; } if (!(p.args || []).includes('--cd')) { p.args = [...(p.args || []), '--cd', '~']; changed = true; } } }
    if (changed) saveSettings();
    return settings.localProfiles;
  });
  handle('profiles:detect', () => detectProfiles());
  // WSL control: terminate one distro (it restarts on next launch) or shut the whole WSL VM down
  handle('wsl:restart', (distro) => new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('WSL is only available on Windows'));
    const { execFile } = require('child_process');
    const args = distro ? ['--terminate', distro] : ['--shutdown'];
    execFile('wsl.exe', args, { windowsHide: true, timeout: 30000, encoding: 'utf16le' }, (err, out, errOut) => err ? reject(new Error(String(errOut || out || err.message).replace(/\0/g, '').trim())) : resolve(true));
  }));
  handle('profiles:save', (list) => { settings.localProfiles = Array.isArray(list) ? list : []; saveSettings(); return settings.localProfiles; });
  handle('pty:spawn', function ({ profile, cols, rows }) {
    const s = shells.spawn(profile, cols, rows);
    owners.set(s.id, this.sender);
    return { sessionId: s.id, home: os.homedir(), hostname: os.hostname() };
  });
  ipcMain.on('pty:write', (_e, { sessionId, data }) => shells.write(sessionId, data));
  ipcMain.on('pty:resize', (_e, { sessionId, cols, rows }) => shells.resize(sessionId, cols, rows));
  handle('pty:close', (sessionId) => { shells.kill(sessionId); return true; });
  handle('history:fetchLocal', async (hostKey, opts = {}) => {
    const { parseBash, parseZsh, parseFish, mergeRank, splitBlob, FETCH_CMD } = require('./history');
    const sources = [];
    if (opts.wsl) {
      // history lives inside the distro: run the same collector script there
      const { execFile } = require('child_process');
      // wsl.exe re-joins the argument list into one command line for the Linux side, so quotes inside the
      // collector script would be mangled: ship it base64-encoded and decode it in the distro.
      const b64 = Buffer.from(FETCH_CMD, 'utf8').toString('base64');
      const stdout = await new Promise((resolve, reject) => execFile('wsl.exe', ['-d', opts.wsl, '--', 'sh', '-c', `echo ${b64} | base64 -d | sh`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 20000 }, (err, out, stderr) => { if (err && !out) { logLine('wsl history failed', err.message, stderr || ''); return reject(err); } resolve(out || ''); }));
      for (const { file, text } of splitBlob(stdout)) { const kind = /zsh_history$/.test(file) ? 'zsh' : /fish_history$/.test(file) ? 'fish' : 'bash'; sources.push({ src: kind, entries: kind === 'zsh' ? parseZsh(text) : kind === 'fish' ? parseFish(text) : parseBash(text) }); }
      sources.push({ src: 'terhui', entries: history.extras(hostKey) });
      return { entries: mergeRank(sources), files: sources.map(s => s.src), pins: history.getPins(hostKey) };
    }
    const wanted = opts.kind === 'pwsh' ? new Set(['pwsh']) : opts.kind === 'cmd' ? new Set() : new Set(['bash', 'zsh', 'fish']);
    for (const { file, kind } of localHistoryFiles()) {
      if (!wanted.has(kind)) continue;
      let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      const lines = text.split('\n'); if (lines.length > 8000) text = lines.slice(-8000).join('\n');
      sources.push({ src: kind, entries: kind === 'zsh' ? parseZsh(text) : kind === 'fish' ? parseFish(text) : parseBash(text) });
    }
    sources.push({ src: 'terhui', entries: history.extras(hostKey) });
    return { entries: mergeRank(sources), files: sources.map(s => s.src), pins: history.getPins(hostKey) };
  });

  // host resource stats for the status bar
  handle('stats:get', ({ sessionId, local, wsl, key }) => local ? (wsl ? stats.wslStats(wsl, key) : stats.localStats(key)) : stats.remoteStats(sessions.require(sessionId), key));

  // shell history
  handle('history:fetch', (sessionId, hostKey) => history.fetch(sessions.require(sessionId), hostKey));
  handle('history:note', (hostKey, cmd) => { history.note(hostKey, cmd); return true; });
  handle('history:pins', (hostKey, list) => (Array.isArray(list) ? history.setPins(hostKey, list) : history.getPins(hostKey)));

  handle('index:info', (hostId) => indexer.info(hostId));
  handle('index:build', async (hostId, { sessionId, fsId, root, includeFiles }) => {
    if (sessionId) return indexer.buildSsh(hostId, sessions.require(sessionId), { root: root || '/', includeFiles: !!includeFiles });
    if (fsId === 'local') return indexer.buildWalk(hostId, localFS, { root: root || os.homedir(), includeFiles: !!includeFiles, maxEntries: 500000, maxDepth: 20 });
    return indexer.buildWalk(hostId, resolveFS(fsId), { root: root || '/', includeFiles: !!includeFiles });
  });
  handle('index:search', (hostId, q, limit) => indexer.search(hostId, q, { limit: limit || 100 }));
  handle('index:cancel', (hostId) => { indexer.cancel(hostId); return true; });
  handle('index:clear', (hostId) => { indexer.clear(hostId); return true; });

  // dialogs, clipboard, misc
  handle('dialog:open', async (opts) => { const r = await dialog.showOpenDialog(dlgWin(), opts); return r.canceled ? null : r.filePaths; });
  handle('dialog:save', async (opts) => { const r = await dialog.showSaveDialog(dlgWin(), opts); return r.canceled ? null : r.filePath; });
  handle('dialog:confirm', async ({ message, detail, buttons }) => {
    const r = await dialog.showMessageBox(dlgWin(), { type: 'question', message, detail, buttons: buttons || ['OK', 'Cancel'], defaultId: 0, cancelId: (buttons || ['OK', 'Cancel']).length - 1 });
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
    const r = await dialog.showOpenDialog(dlgWin(), { title: 'Import colour scheme (xterm / Windows Terminal JSON)', properties: ['openFile', 'multiSelections'], filters: [{ name: 'JSON', extensions: ['json'] }] });
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
    const r = await dialog.showOpenDialog(dlgWin(), { title: 'Choose wallpaper', properties: ['openFile'], filters: [{ name: 'Images', extensions: IMAGE_EXT }] });
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
  handle('window:setTitle', function (t) { const w = BrowserWindow.fromWebContents(this.sender); if (w) w.setTitle(t); return true; });
  // tear-off windows
  handle('window:detach', function ({ payload, x, y, width, height }) { createDetachedWindow({ x, y, width, height }, payload); return true; });
  handle('window:list', function () {   // other windows a tab can be moved to
    const me = BrowserWindow.fromWebContents(this.sender);
    return [...windows].filter(w => w !== me && !w.isDestroyed()).map(w => ({ id: w === win ? 'main' : w.id, main: w === win, title: w.getTitle().replace(/ — terhui$/, '') }));
  });
  handle('window:sendTab', function ({ target, payload, dock }) {   // hand a tab (its panes + sessions) to another window
    const w = target === 'main' ? win : BrowserWindow.fromId(Number(target));
    if (!w || w.isDestroyed()) throw new Error('Target window is gone');
    for (const p of payload.panes) if (p.sessionId) owners.set(p.sessionId, w.webContents);
    w.webContents.send('detach:init', { ...payload, dock: dock || null }); w.focus(); return true;
  });
  // Tab / pane drag (JetBrains style, no HTML5 drag-and-drop): the renderer tracks the pointer, main draws a
  // ghost window that follows the cursor across the screen, finds the window under the cursor and forwards
  // the position to it as hover events; on release the window under the cursor decides what to do with the drop.
  let drag = null;   // { id, kind, source: webContents, hoverWin, ghost, timer }
  const pending = new Map();   // reqId -> resolve
  const ask = (wc, channel, msg, timeout) => new Promise((resolve) => { const reqId = String(Date.now()) + Math.random(); pending.set(reqId, resolve); if (!wc.isDestroyed()) wc.send(channel, { ...msg, reqId }); setTimeout(() => { if (pending.delete(reqId)) resolve(null); }, timeout); });
  const covers = (w, pt) => { if (w.isDestroyed() || !w.isVisible() || w.isMinimized()) return false; const b = w.getContentBounds(); return pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height; };
  // Which window is under the cursor. Electron cannot read the stacking order, so the focused window wins: a
  // drag starts with a click, which raises its window, and otherwise the most recently focused one is on top.
  const windowAt = (pt) => {
    const src = drag && drag.source && !drag.source.isDestroyed() ? BrowserWindow.fromWebContents(drag.source) : null;
    if (src && src.isFocused() && covers(src, pt)) return src;
    for (const w of [...focusOrder, ...windows]) if (covers(w, pt)) return w;
    return null;
  };
  const dragStop = () => { if (!drag) return; clearInterval(drag.timer); if (drag.ghost && !drag.ghost.isDestroyed()) drag.ghost.destroy(); if (drag.hoverWin && !drag.hoverWin.isDestroyed()) drag.hoverWin.webContents.send('drag:leave', {}); drag = null; };
  const makeGhost = ({ title, color }, pt) => {
    const width = Math.min(260, 44 + Math.round(String(title || '').length * 7.2));
    const g = new BrowserWindow({ width, height: 30, x: pt.x + 14, y: pt.y + 10, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, movable: false, minimizable: false, maximizable: false, hasShadow: false, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    g.setIgnoreMouseEvents(true); g.setAlwaysOnTop(true, 'pop-up-menu');
    g.loadFile(path.join(__dirname, '../renderer/ghost.html'), { query: { title: String(title || ''), color: String(color || ''), bg: settings.chromeBg, fg: settings.chromeFg } });
    g.webContents.once('did-finish-load', () => { if (!g.isDestroyed() && drag && drag.ghost === g) g.showInactive(); });
    return g;
  };
  handle('drag:begin', function ({ id, kind, title, color }) {
    dragStop();
    const pt = screen.getCursorScreenPoint();
    drag = { id, kind, source: this.sender, hoverWin: null, ghost: null, timer: null };
    try { drag.ghost = makeGhost({ title, color }, pt); } catch (err) { logLine('ghost window failed', err.message); }
    drag.timer = setInterval(() => {
      if (!drag) return;
      const p = screen.getCursorScreenPoint();
      if (drag.ghost && !drag.ghost.isDestroyed()) drag.ghost.setPosition(p.x + 14, p.y + 10);
      const w = windowAt(p);
      if (w !== drag.hoverWin) { if (drag.hoverWin && !drag.hoverWin.isDestroyed()) drag.hoverWin.webContents.send('drag:leave', {}); drag.hoverWin = w; }
      if (w && w.webContents !== drag.source) { const b = w.getContentBounds(); w.webContents.send('drag:hover', { id, kind, x: p.x - b.x, y: p.y - b.y }); }   // the source window tracks its own pointer
    }, 16);
    return true;
  });
  handle('drag:cancel', function () { dragStop(); return true; });
  handle('drag:end', async function ({ id }) {
    if (!drag || drag.id !== id) return { none: true };
    const d = drag; const p = screen.getCursorScreenPoint(); const target = windowAt(p);
    clearInterval(d.timer); if (d.ghost && !d.ghost.isDestroyed()) d.ghost.destroy();
    if (!target) { drag = null; return { outside: true, x: p.x, y: p.y }; }
    if (target.webContents === d.source) { drag = null; return { self: true }; }
    const b = target.getContentBounds();
    const res = await ask(target.webContents, 'drag:drop', { id, kind: d.kind, x: p.x - b.x, y: p.y - b.y }, 2000);   // { accepted, dock }
    if (!res || !res.accepted) { drag = null; return { claimed: false }; }
    const payload = await ask(d.source, 'drag:export', { id }, 3000);
    drag = null;
    if (!payload || target.isDestroyed()) return { claimed: false };
    for (const pp of payload.panes) if (pp.sessionId) owners.set(pp.sessionId, target.webContents);
    target.webContents.send('detach:init', { ...payload, dock: res.dock || null }); target.focus();
    return { claimed: true };
  });
  handle('drag:reply', function ({ reqId, result }) { const r = pending.get(reqId); if (r) { pending.delete(reqId); r(result); } return true; });
  handle('window:own', function (sessionIds) { for (const id of sessionIds || []) owners.set(id, this.sender); return true; });
  handle('window:closeSelf', function () { const w = BrowserWindow.fromWebContents(this.sender); if (w && w !== win) setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 50); return true; });
  handle('window:info', function () { return { detached: BrowserWindow.fromWebContents(this.sender) !== win, platform: process.platform, frame: settings.windowFrame !== 'native' ? 'integrated' : 'native', material: process.platform === 'win32' ? (settings.winMaterial || 'none') : 'none', maximized: !!(win && win.isMaximized()) }; });
  // Keep the OS caption buttons / native title bar in the app's colours.
  handle('window:chrome', ({ bg, fg }) => {
    settings.chromeBg = bg; settings.chromeFg = fg; saveSettings();
    nativeTheme.themeSource = isDarkHex(bg) ? 'dark' : 'light';
    for (const w of windows) { if (w.isDestroyed()) continue; if (settings.windowFrame !== 'native' && process.platform !== 'darwin' && typeof w.setTitleBarOverlay === 'function') { try { w.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 32 }); } catch (_) {} } if (!(process.platform === 'win32' && settings.winMaterial && settings.winMaterial !== 'none')) w.setBackgroundColor(bg); }
    return true;
  });
  handle('app:relaunch', () => { app.__quitting = true; app.relaunch(); app.quit(); return true; });
  handle('theme:native', () => nativeTheme.shouldUseDarkColors);
}

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function isDarkHex(c) { const m = String(c || '').match(/^#([0-9a-f]{6})/i); if (!m) return true; const n = parseInt(m[1], 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) < 128; }
function isBinary(buf) { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return true; } return false; }

// ---------- lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { logLine('another instance is running, exiting'); app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (!win.isVisible()) win.show(); if (win.isMinimized()) win.restore(); win.focus(); } });
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
    history = new HistoryStore(ud);
    quick = new QuickUnlock(ud, logLine);
    shells = new LocalShellManager(ud);
    shells.on('data', (id, d) => sendSession(id, 'pty:data', { sessionId: id, data: d }));
    shells.on('exit', (id, info) => { sendSession(id, 'pty:exit', { sessionId: id, ...info }); owners.delete(id); });
    registerIpc();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(err => fatal('startup', err));
  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', () => { app.__quitting = true; try { shells && shells.closeAll(); sessions && sessions.closeAll(); for (const f of ftpConns.values()) f.close(); } catch (_) {} });
}
