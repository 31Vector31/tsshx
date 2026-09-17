'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../src/renderer/wslpath');

test('wsl path mapping', () => {
  assert.equal(W.toWindows('Ubuntu', '/home/u/proj'), '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj');
  assert.equal(W.toWindows('Ubuntu', '/'), '\\\\wsl.localhost\\Ubuntu\\');
  assert.equal(W.toWindows('Ubuntu', '/mnt/c/Users/x'), 'C:\\Users\\x');
  assert.equal(W.toLinux('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\u'), '/home/u');
  assert.equal(W.toLinux('Ubuntu', '\\\\wsl$\\ubuntu\\'), '/');
  assert.equal(W.toLinux('Ubuntu', '\\\\wsl.localhost\\Debian\\etc'), null);
  assert.equal(W.toLinux('Ubuntu', 'D:\\data\\x'), '/mnt/d/data/x');
  assert.equal(W.rootOf('Ubuntu-22.04'), '\\\\wsl.localhost\\Ubuntu-22.04\\');
});
