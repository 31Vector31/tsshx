'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startTestServer } = require('./helpers/ssh-server');
const { Vault, parseSshConfig } = require('../src/main/vault');
const { SessionManager, KnownHosts, describeHostKey } = require('../src/main/ssh-manager');
const { LocalFS, SftpFS, TransferManager } = require('../src/main/fs-backends');
const { Indexer, searchEntries } = require('../src/main/indexer');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terhui-test-'));

test('vault: create/unlock/upsert/secrets kept', () => {
  const v = new Vault(path.join(tmp, 'vault.json'));
  assert.equal(v.exists(), false);
  v.create('master');
  const h = v.upsert({ name: 'srv', host: '10.0.0.1', username: 'root', password: 'pw', port: '2222' });
  assert.equal(h.hasPassword, true); assert.equal(h.password, undefined); assert.equal(h.port, 2222);
  v.upsert({ id: h.id, name: 'srv2', host: '10.0.0.1', username: 'root', password: Vault.KEEP });
  assert.equal(v.get(h.id).password, 'pw');
  v.lock();
  assert.throws(() => v.list(), /locked/);
  assert.throws(() => v.unlock('wrong'), { code: 'BAD_PASSWORD' });
  assert.equal(v.unlock('master'), 1);
  assert.equal(v.list()[0].name, 'srv2');
  v.changeMaster('master', 'new');
  v.lock(); v.unlock('new');
  assert.equal(v.get(h.id).password, 'pw');
  assert.equal(v.remove(h.id), true);
  assert.equal(v.list().length, 0);
});

test('vault: ssh config import', () => {
  const list = parseSshConfig('Host prod\n  HostName 1.2.3.4\n  User admin\n  Port 2200\nHost *\n  ServerAliveInterval 30\n');
  assert.deepEqual(list.map(x => [x.name, x.host, x.username, x.port]), [['prod', '1.2.3.4', 'admin', 2200]]);
});

test('indexer: fuzzy search ranking', () => {
  const entries = ['/var/log', '/var/lib/docker/overlay2', '/home/user/projects/webapp/src', '/etc/nginx/sites-enabled', '/home/user/projects/webapp', '/opt/vl'];
  const lower = entries.map(e => e.toLowerCase());
  const r = searchEntries(entries, lower, 'webapp', 10);
  assert.equal(r[0].path, '/home/user/projects/webapp');
  const r2 = searchEntries(entries, lower, 'ngx', 10);
  assert.equal(r2[0].path, '/etc/nginx/sites-enabled');
  const r3 = searchEntries(entries, lower, 'var log', 10);
  assert.equal(r3[0].path, '/var/log');
  assert.equal(searchEntries(entries, lower, 'zzz', 10).length, 0);
});

test('ssh: connect, shell, exec, sftp, transfers, indexer, host key TOFU', async (t) => {
  const srv = await startTestServer({ user: 'test', password: 'secret' });
  t.after(() => srv.close());
  const kh = new KnownHosts(path.join(tmp, 'known_hosts.json'));
  const prompts = [];
  const mgr = new SessionManager({ knownHosts: kh, prompter: { hostKey: async (info) => { prompts.push(info); return true; } } });
  const entry = { host: '127.0.0.1', port: srv.port, username: 'test', password: 'secret' };
  const s = await mgr.connect(entry);
  assert.equal(s.status, 'connected');
  assert.equal(prompts.length, 1); assert.equal(prompts[0].keyType, 'ssh-ed25519'); assert.equal(prompts[0].changed, false);
  assert.ok(kh.get('127.0.0.1', srv.port));

  // exec
  const r = await s.exec('echo -n "héllo ✓ 🚀"; exit 3');
  assert.equal(r.stdout, 'héllo ✓ 🚀'); assert.equal(r.code, 3);

  // shell
  const chunks = [];
  s.on('data', d => chunks.push(d));
  await s.openShell(100, 30);
  s.write('printf "\\e[38;2;255;0;0mRED\\e[0m ЖЁЛТЫЙ\\n"; stty size\n');
  await new Promise(res => setTimeout(res, 800));
  const out = Buffer.concat(chunks).toString('utf8');
  assert.ok(out.includes('\x1b[38;2;255;0;0mRED'), 'truecolor passthrough');
  assert.ok(out.includes('ЖЁЛТЫЙ'), 'utf8 passthrough');
  assert.ok(out.includes('30 100'), 'pty size honoured: ' + out);
  s.resize(120, 40);
  chunks.length = 0;
  s.write('stty size\n');
  await new Promise(res => setTimeout(res, 500));
  assert.ok(Buffer.concat(chunks).toString().includes('40 120'), 'resize');

  // sftp
  if (!srv.sftpBin) { t.diagnostic('no sftp-server binary, skipping sftp checks'); s.close(); return; }
  const work = fs.mkdtempSync(path.join(tmp, 'work-'));
  fs.mkdirSync(path.join(work, 'src/deep'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src/a.txt'), 'A'.repeat(100000));
  fs.writeFileSync(path.join(work, 'src/deep/ünï çødé.txt'), 'юникод');
  const remote = new SftpFS(s); const local = new LocalFS();
  const home = await remote.home(); assert.equal(home, os.homedir());  // sftp-server started in $HOME
  const listing = await remote.list(work); assert.equal(listing[0].name, 'src'); assert.equal(listing[0].type, 'd');
  const tm = new TransferManager();
  const done = (id) => new Promise(res => tm.on('progress', v => { if (v.id === id && (v.status === 'done' || v.status === 'error')) res(v); }));
  // upload dir local → sftp
  const id1 = tm.start({ srcFS: local, srcPath: path.join(work, 'src'), dstFS: remote, dstPath: path.join(work, 'up'), srcLabel: 'local', dstLabel: 'remote' });
  const v1 = await done(id1);
  assert.equal(v1.status, 'done', v1.error); assert.equal(v1.filesDone, 2); assert.equal(v1.bytesDone, 100000 + Buffer.byteLength('юникод'));
  assert.equal(fs.readFileSync(path.join(work, 'up/deep/ünï çødé.txt'), 'utf8'), 'юникод');
  // download dir sftp → local
  const id2 = tm.start({ srcFS: remote, srcPath: path.join(work, 'up'), dstFS: local, dstPath: path.join(work, 'down') });
  const v2 = await done(id2); assert.equal(v2.status, 'done', v2.error);
  assert.equal(fs.readFileSync(path.join(work, 'down/a.txt'), 'utf8').length, 100000);
  // misc ops
  await remote.mkdir(path.join(work, 'x/y/z'));
  await remote.rename(path.join(work, 'x/y/z'), path.join(work, 'x/y/w'));
  assert.equal((await remote.stat(path.join(work, 'x/y/w'))).type, 'd');
  await remote.writeFile(path.join(work, 'x/y/w/f.txt'), 'data');
  assert.equal((await remote.readFile(path.join(work, 'x/y/w/f.txt'))).data.toString(), 'data');
  await remote.chmod(path.join(work, 'x/y/w/f.txt'), 0o600);
  assert.equal((await remote.stat(path.join(work, 'x/y/w/f.txt'))).mode, 0o600);
  await remote.rmdir(path.join(work, 'x'));
  assert.ok(!fs.existsSync(path.join(work, 'x')));

  // indexer
  const ix = new Indexer(path.join(tmp, 'index'));
  const info = await ix.buildSsh('h1', s, { root: work });
  assert.ok(info.exists); assert.ok(info.count >= 4, 'count ' + info.count);
  const found = ix.search('h1', 'deep');
  assert.ok(found.length && found[0].path.endsWith('/deep'), JSON.stringify(found));
  const info2 = await ix.buildSsh('h1', s, { root: work, includeFiles: true });
  assert.ok(ix.search('h1', 'çødé').some(x => x.path.endsWith('ünï çødé.txt')));
  const ix2 = new Indexer(path.join(tmp, 'index'));  // reload from disk
  assert.equal(ix2.info('h1').count, info2.count);

  // host key change detection
  s.close();
  await new Promise(res => setTimeout(res, 100));
  kh.set('127.0.0.1', srv.port, 'ssh-ed25519', 'SHA256:bogus');
  const p2 = [];
  const mgr2 = new SessionManager({ knownHosts: kh, prompter: { hostKey: async (i) => { p2.push(i); return false; } } });
  await assert.rejects(mgr2.connect(entry));
  assert.equal(p2[0].changed, true);
});

test('ssh: keyboard-interactive with stored password, wrong password rejects', async (t) => {
  const srv = await startTestServer({ user: 'u', password: 'p', kbd: true });
  t.after(() => srv.close());
  const kh = new KnownHosts(path.join(tmp, 'kh2.json'));
  const mgr = new SessionManager({ knownHosts: kh, prompter: { hostKey: async () => true } });
  const s = await mgr.connect({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' });
  assert.equal(s.status, 'connected'); s.close();
  await assert.rejects(mgr.connect({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'wrong' }), /authentication/i);
});

test('ssh: public key auth', async (t) => {
  const { execSync } = require('child_process');
  const kf = path.join(tmp, 'id_ed25519');
  execSync(`ssh-keygen -q -t ed25519 -N "pp" -f ${kf}`);
  const { utils } = require('ssh2');
  const pub = utils.parseKey(fs.readFileSync(kf + '.pub'));
  const srv = await startTestServer({ user: 'k', password: 'x', pubKeys: [pub] });
  t.after(() => srv.close());
  const mgr = new SessionManager({ knownHosts: new KnownHosts(path.join(tmp, 'kh3.json')), prompter: { hostKey: async () => true } });
  const s = await mgr.connect({ host: '127.0.0.1', port: srv.port, username: 'k', privateKeyPath: kf, passphrase: 'pp' });
  assert.equal(s.status, 'connected'); s.close();
  const s2 = await mgr.connect({ host: '127.0.0.1', port: srv.port, username: 'k', privateKey: fs.readFileSync(kf, 'utf8'), passphrase: 'pp' });
  assert.equal(s2.status, 'connected'); s2.close();
});
