'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseBash, parseZsh, parseFish, splitBlob, mergeRank } = require('../src/main/history');

test('history: bash with timestamps', () => {
  const r = parseBash('#1700000000\nls -la\n#1700000100\ngit status\nplain\n');
  assert.deepEqual(r, [{ cmd: 'ls -la', ts: 1700000000000 }, { cmd: 'git status', ts: 1700000100000 }, { cmd: 'plain', ts: null }]);
});

test('history: zsh extended + multiline', () => {
  const r = parseZsh(': 1700000000:0;echo one\n: 1700000001:0;for i in 1 2; do\\\n  echo $i\\\ndone\nplain cmd\n');
  assert.equal(r.length, 3);
  assert.equal(r[0].cmd, 'echo one'); assert.equal(r[0].ts, 1700000000000);
  assert.equal(r[1].cmd, 'for i in 1 2; do\n  echo $i\ndone');
  assert.equal(r[2].cmd, 'plain cmd');
});

test('history: fish', () => {
  const r = parseFish('- cmd: ls\n  when: 1700000000\n- cmd: echo hi\\nthere\n  when: 1700000005\n  paths:\n    - x\n');
  assert.deepEqual(r, [{ cmd: 'ls', ts: 1700000000000 }, { cmd: 'echo hi\nthere', ts: 1700000005000 }]);
});

test('history: split blob + merge ranking', () => {
  const blob = '/home/u/.bash_history\nls\ngit status\nls\n\n/home/u/.zsh_history\n: 1700000000:0;ls\n: 1700000009:0;vim x\n';
  const parts = splitBlob(blob);
  assert.deepEqual(parts.map(p => p.file), ['/home/u/.bash_history', '/home/u/.zsh_history']);
  const merged = mergeRank([{ src: 'bash', entries: parseBash(parts[0].text) }, { src: 'zsh', entries: parseZsh(parts[1].text) }]);
  assert.equal(merged[0].cmd, 'vim x');            // newest timestamp first
  const ls = merged.find(x => x.cmd === 'ls');
  assert.equal(ls.count, 3); assert.equal(ls.src, 'bash,zsh');
});

test('stats: parse remote linux script output with cpu delta', () => {
  const { parseRemote } = require('../src/main/stats');
  const out1 = '@OS Linux\n@L\n0.42 0.38 0.35 1/512 1234\n@S\ncpu 1000 0 500 8000 100 0 0 0 0 0\n@M\nMemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 1000000 kB\nSwapFree: 900000 kB\n@U\n93784.5 300000\n@N\n4\n@D\n/dev/sda1 100000000 68000000 32000000 68% /\n';
  const r1 = parseRemote('k', out1);
  assert.equal(r1.cpu, null); assert.deepEqual(r1.load, [0.42, 0.38, 0.35]); assert.equal(r1.cores, 4); assert.equal(r1.memTotal, 8000000 * 1024); assert.equal(r1.memUsed, 4000000 * 1024); assert.equal(r1.swapUsed, 100000 * 1024);
  assert.equal(r1.uptime, 93784.5); assert.equal(r1.diskTotal, 100000000 * 1024); assert.equal(r1.diskUsed, 68000000 * 1024);
  const r2 = parseRemote('k', out1.replace('cpu 1000 0 500 8000 100 0 0 0 0 0', 'cpu 1300 0 600 8500 100 0 0 0 0 0'));
  assert.equal(r2.cpu, 44);   // delta total 900, idle delta 500 → 1 - 500/900
});
