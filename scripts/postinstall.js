// Rebuild native modules for Electron only where needed.
// node-pty ships N-API prebuilds for Windows/macOS (loaded from prebuilds/<platform>-<arch>), so it must NOT be
// compiled there (that needs MSVC with Spectre-mitigated libs). On Linux there are no prebuilds → rebuild.
// cpu-features (optional ssh2 helper) is rebuilt everywhere; failure is not fatal.
const fs = require('fs');
const path = require('path');
const electronVersion = require('electron/package.json').version;
const root = path.join(__dirname, '..');
const ptyPrebuilt = fs.existsSync(path.join(root, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`));
const only = ['cpu-features', ...(ptyPrebuilt ? [] : ['node-pty'])];
(async () => {
  const { rebuild } = require('@electron/rebuild');
  for (const mod of only) {
    try { await rebuild({ buildPath: root, electronVersion, arch: process.arch, onlyModules: [mod], force: true }); console.log(`rebuilt ${mod} for Electron ${electronVersion}`); }
    catch (err) { const fatal = mod === 'node-pty'; console.warn(`${fatal ? 'ERROR' : 'warning'}: could not rebuild ${mod}: ${err.message}`); if (fatal) process.exit(1); }
  }
  if (ptyPrebuilt) console.log('node-pty: using bundled prebuilt binaries');
})();
