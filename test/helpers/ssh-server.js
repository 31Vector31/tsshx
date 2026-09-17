'use strict';
// Minimal SSH server for tests: password auth, shell (node-pty), exec, sftp (OpenSSH sftp-server binary or fallback).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { Server, utils } = require('ssh2');

const SFTP_BIN_CANDIDATES = [
  '/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server',
  ...(() => { try { return fs.readdirSync('/snap').filter(n => /^core\d*$/.test(n)).flatMap(c => fs.readdirSync('/snap/' + c).map(v => `/snap/${c}/${v}/usr/lib/openssh/sftp-server`)); } catch (_) { return []; } })(),
];

function findSftpServer() { return SFTP_BIN_CANDIDATES.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } }) || null; }

function genHostKey(dir) {
  const f = path.join(dir, 'host_ed25519');
  if (!fs.existsSync(f)) execSync(`ssh-keygen -q -t ed25519 -N "" -f ${f}`);
  return fs.readFileSync(f);
}

function startTestServer({ user = 'test', password = 'secret', pubKeys = [], port = 0, kbd = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terhui-sshd-'));
  const hostKey = genHostKey(dir);
  const sftpBin = findSftpServer();
  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client); client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && !kbd) return (ctx.username === user && ctx.password === password) ? ctx.accept() : ctx.reject();
      if (ctx.method === 'keyboard-interactive' && kbd) {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => (answers[0] === password ? ctx.accept() : ctx.reject()));
      }
      if (ctx.method === 'publickey') {
        const k = pubKeys.find(pk => pk.type === ctx.key.algo && pk.getPublicSSH().equals(ctx.key.data));
        if (!k) return ctx.reject();
        if (ctx.signature && !k.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject();
        return ctx.accept();
      }
      ctx.reject(kbd ? ['keyboard-interactive', 'publickey'] : ['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        let ptyInfo = null; const env = {};
        session.on('pty', (acc, rej, info) => { ptyInfo = info; acc && acc(); });
        session.on('env', (acc, rej, info) => { env[info.key] = info.val; acc && acc(); });
        session.on('window-change', (acc, rej, info) => { if (session._pty) session._pty.resize(info.cols, info.rows); acc && acc(); });
        session.on('shell', (acc) => {
          const stream = acc();
          const pty = require('node-pty');
          const p = pty.spawn('/bin/bash', ['--norc', '--noprofile'], { name: ptyInfo ? ptyInfo.term : 'xterm', cols: ptyInfo ? ptyInfo.cols : 80, rows: ptyInfo ? ptyInfo.rows : 24, cwd: os.homedir(), env: { ...process.env, ...env, TERM: ptyInfo ? ptyInfo.term : 'xterm', PS1: '$ ', HISTFILE: path.join(dir, 'bash_history') } });
          session._pty = p;
          p.onData(d => stream.write(d));
          p.onExit(({ exitCode }) => { stream.exit(exitCode); stream.end(); });
          stream.on('data', d => p.write(d.toString()));
          stream.on('close', () => p.kill());
        });
        session.on('exec', (acc, rej, info) => {
          const stream = acc();
          const child = spawn('/bin/bash', ['-c', info.command], { env: { ...process.env, ...env } });
          child.stdout.on('data', d => stream.write(d));
          child.stderr.on('data', d => stream.stderr.write(d));
          stream.on('data', d => child.stdin.write(d));
          stream.on('end', () => child.stdin.end());
          stream.on('close', () => child.kill());
          child.on('close', (code) => { stream.exit(code == null ? 1 : code); stream.end(); });
        });
        session.on('subsystem', (acc, rej, info) => {
          if (info.name !== 'sftp' || !sftpBin) return rej();
          const stream = acc();
          const child = spawn(sftpBin, ['-e'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.homedir() });
          child.stdout.on('data', d => stream.write(d));
          stream.on('data', d => child.stdin.write(d));
          stream.on('close', () => child.kill());
          child.on('close', () => stream.end());
        });
      });
    });
    client.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, dir, hostKey, sftpBin, close: () => new Promise(r => { for (const c of clients) { try { c.end(); } catch (_) {} } server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); }); setTimeout(r, 1000); }) });
    });
  });
}

module.exports = { startTestServer, findSftpServer };
