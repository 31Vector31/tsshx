'use strict';
// Local terminals (PowerShell / cmd / WSL / zsh / bash …) on top of node-pty, plus per-platform profile detection.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const EventEmitter = require('events');

let pty = null;
function loadPty() { if (!pty) pty = require('node-pty'); return pty; }

const exists = (p) => { try { fs.accessSync(p); return true; } catch (_) { return false; } };
const which = (cmd) => {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) for (const ext of exts) { const f = path.join(dir, cmd + ext); if (exists(f)) return f; }
  return null;
};

/** Profile: { id, name, command, args:[], cwd, env:{}, kind:'posix'|'pwsh'|'cmd', color, icon } */
function detectProfiles() {
  const out = [];
  const add = (p) => { if (!out.some(x => x.command === p.command && JSON.stringify(x.args || []) === JSON.stringify(p.args || []))) out.push({ args: [], cwd: '', env: {}, color: '', ...p, id: p.id || 'local-' + (out.length + 1) }); };
  if (process.platform === 'win32') {
    const pwsh = which('pwsh'); if (pwsh) add({ name: 'PowerShell 7', command: pwsh, args: ['-NoLogo'], kind: 'pwsh' });
    const wps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); if (exists(wps)) add({ name: 'Windows PowerShell', command: wps, args: ['-NoLogo'], kind: 'pwsh' });
    const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'); if (exists(cmd)) add({ name: 'Command Prompt', command: cmd, args: [], kind: 'cmd' });
    try {
      const raw = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le', windowsHide: true, timeout: 5000 });
      for (const line of raw.split(/\r?\n/)) { const d = line.replace(/\0/g, '').trim(); if (d) add({ name: 'WSL: ' + d, command: 'wsl.exe', args: ['-d', d, '--cd', '~'], kind: 'posix', wsl: d }); }
    } catch (_) {}
    for (const gb of [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')]) if (exists(gb)) { add({ name: 'Git Bash', command: gb, args: ['--login', '-i'], kind: 'posix' }); break; }
  } else {
    const login = process.env.SHELL || '/bin/sh';
    add({ name: path.basename(login) + ' (login shell)', command: login, args: ['-l'], kind: 'posix' });
    let shells = [];
    try { shells = fs.readFileSync('/etc/shells', 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#') && exists(s)); } catch (_) {}
    for (const name of ['zsh', 'bash', 'fish']) { if (path.basename(login) === name) continue; const f = shells.find(s => path.basename(s) === name) || which(name); if (f) add({ name, command: f, args: ['-l'], kind: 'posix' }); }
    if (process.platform === 'darwin' && which('pwsh')) add({ name: 'PowerShell', command: which('pwsh'), args: ['-NoLogo'], kind: 'pwsh' });
  }
  return out;
}

const OSC7 = 'printf "\\033]7;file://%s%s\\007" "$HOSTNAME" "$PWD"';

/** zsh cannot take hooks from the environment; a private ZDOTDIR sources the user's files and then adds ours. */
function ensureZdotdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const restore = 'export ZDOTDIR="${TERHUI_USER_ZDOTDIR:-$HOME}"';
  fs.writeFileSync(path.join(dir, '.zshenv'), `_terhui_zd="$ZDOTDIR"; ${restore}; [ -f "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"; export ZDOTDIR="$_terhui_zd"\n`);
  fs.writeFileSync(path.join(dir, '.zprofile'), `_terhui_zd="$ZDOTDIR"; ${restore}; [ -f "$ZDOTDIR/.zprofile" ] && . "$ZDOTDIR/.zprofile"; export ZDOTDIR="$_terhui_zd"\n`);
  fs.writeFileSync(path.join(dir, '.zshrc'), `${restore}; [ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"\nsetopt INC_APPEND_HISTORY\n_terhui_precmd() { printf "\\033]7;file://%s%s\\007" "$HOST" "$PWD"; }\nprecmd_functions+=(_terhui_precmd)\n`);
  return dir;
}

let seq = 1;
class LocalShellManager extends EventEmitter {
  constructor(userData) { super(); this.sessions = new Map(); this.userData = userData; }

  /** Shell integration for local shells goes through the environment: nothing is typed, so ConPTY cannot echo it. */
  integrationEnv(profile, env) {
    if (profile.kind !== 'posix') return {};
    const out = {};
    const base = path.basename(profile.command).toLowerCase();
    if (profile.wsl || base === 'bash' || base === 'sh' || base.endsWith('bash.exe')) {
      out.PROMPT_COMMAND = 'history -a;' + OSC7;
      if (profile.wsl) out.WSLENV = (env.WSLENV ? env.WSLENV + ':' : '') + 'PROMPT_COMMAND';   // share it with the distro
    }
    if (base === 'zsh') { out.TERHUI_USER_ZDOTDIR = env.ZDOTDIR || ''; out.ZDOTDIR = ensureZdotdir(path.join(this.userData, 'zsh')); }
    return out;
  }

  spawn(profile, cols, rows) {
    const p = loadPty();
    const id = 'L' + (seq++);
    const env = { ...process.env, ...(profile.env || {}), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'terhui', LANG: process.env.LANG || 'C.UTF-8' };
    let args = profile.args || [];
    if (profile.integration !== false) {
      Object.assign(env, this.integrationEnv(profile, env));
      // cwd reporting (OSC 7) for Windows shells: cmd through its PROMPT variable, PowerShell by wrapping the prompt function
      if (profile.kind === 'cmd') env.PROMPT = '$e]7;file://localhost/$p$e\\' + (env.PROMPT || '$p$g');
      if (profile.kind === 'pwsh' && !args.some(a => /^-(c|command|f|file|noexit)$/i.test(a))) {
        const script = `$global:__terhuiPrompt = $function:prompt; function global:prompt { [Console]::Write("$([char]27)]7;file://localhost/$($PWD.ProviderPath -replace '\\\\','/')$([char]7)"); & $global:__terhuiPrompt }`;
        args = [...args, '-NoExit', '-Command', script];
      }
    }
    const cwd = (profile.cwd && exists(profile.cwd)) ? profile.cwd : os.homedir();
    const proc = p.spawn(profile.command, args, { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd, env, useConpty: true });
    const s = { id, proc, profile, closed: false };
    this.sessions.set(id, s);
    proc.onData((d) => this.emit('data', id, Buffer.from(d, 'utf8')));
    proc.onExit(({ exitCode, signal }) => { s.closed = true; this.sessions.delete(id); this.emit('exit', id, { exitCode, signal }); });
    return s;
  }
  write(id, data) { const s = this.sessions.get(id); if (s && !s.closed) s.proc.write(data); }
  resize(id, cols, rows) { const s = this.sessions.get(id); if (s && !s.closed && cols > 0 && rows > 0) { try { s.proc.resize(cols, rows); } catch (_) {} } }
  kill(id) { const s = this.sessions.get(id); if (s && !s.closed) { try { s.proc.kill(); } catch (_) {} } }
  closeAll() { for (const id of [...this.sessions.keys()]) this.kill(id); }
}

/** Local shell history files (for the history palette) */
function localHistoryFiles() {
  const home = os.homedir(); const list = [];
  const push = (f, kind) => { if (exists(f)) list.push({ file: f, kind }); };
  push(path.join(home, '.bash_history'), 'bash'); push(path.join(home, '.zsh_history'), 'zsh'); push(path.join(home, '.local/share/fish/fish_history'), 'fish');
  if (process.platform === 'win32') push(path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'), 'pwsh');
  else push(path.join(home, '.local/share/powershell/PSReadLine/ConsoleHost_history.txt'), 'pwsh');
  return list;
}

module.exports = { LocalShellManager, detectProfiles, localHistoryFiles };
