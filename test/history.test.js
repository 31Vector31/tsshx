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
