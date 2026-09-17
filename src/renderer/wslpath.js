'use strict';
// Path mapping between a WSL distro's Linux paths and the Windows view of them (\\wsl.localhost\<Distro>\...).
(function (root) {
  const WslPath = {
    /** Linux path inside the distro → Windows UNC path usable by the local file backend. */
    toWindows(distro, linuxPath) {
      const p = String(linuxPath || '/');
      const m = p.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
      if (m) return m[1].toUpperCase() + ':' + (m[2] ? m[2].replace(/\//g, '\\') : '\\');
      return `\\\\wsl.localhost\\${distro}` + (p === '/' ? '\\' : p.replace(/\//g, '\\'));
    },
    /** Windows path → Linux path inside the distro (UNC of the same distro, or a drive letter → /mnt/x). Returns null if unrelated. */
    toLinux(distro, winPath) {
      const p = String(winPath || '');
      const m = p.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i);
      if (m) { if (m[1].toLowerCase() !== String(distro).toLowerCase()) return null; const rest = (m[2] || '\\').replace(/\\/g, '/'); return rest === '' ? '/' : rest; }
      const d = p.match(/^([a-zA-Z]):(\\.*)?$/);
      if (d) return '/mnt/' + d[1].toLowerCase() + (d[2] ? d[2].replace(/\\/g, '/') : '/');
      return null;
    },
    /** Root of the distro's file system as a Windows path. */
    rootOf(distro) { return `\\\\wsl.localhost\\${distro}\\`; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = WslPath;
  root.WslPath = WslPath;
})(typeof window !== 'undefined' ? window : globalThis);
