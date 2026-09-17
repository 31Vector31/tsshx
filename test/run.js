// Run the test suite with Electron's bundled Node so native modules (node-pty, cpu-features) built for Electron load.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const electron = require('electron');
const files = fs.readdirSync(path.join(__dirname)).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f));
const r = spawnSync(electron, ['--test', '--test-timeout=60000', ...files], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
process.exit(r.status == null ? 1 : r.status);
