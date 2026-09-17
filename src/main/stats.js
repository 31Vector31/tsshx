'use strict';
// Host resource summary for the status bar (htop-style): cpu %, memory, swap, disk, load average, uptime.
// Remote: one POSIX sh script over the SSH session (or inside a WSL distro). Local: Node os/fs APIs.

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

// Linux: /proc; Darwin/BSD fallback with sysctl + vm_stat. Sections are tagged with @X markers.
const SCRIPT = `u=$(uname -s 2>/dev/null); echo "@OS $u"; if [ -r /proc/stat ]; then echo @L; cat /proc/loadavg; echo @S; head -1 /proc/stat; echo @M; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo; echo @U; cat /proc/uptime; echo @N; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN; else echo @L; sysctl -n vm.loadavg 2>/dev/null | tr -d '{}'; echo @N; sysctl -n hw.ncpu 2>/dev/null; echo @MS; sysctl -n hw.memsize 2>/dev/null; echo @VM; vm_stat 2>/dev/null; echo @UP; sysctl -n kern.boottime 2>/dev/null; date +%s; fi; echo @D; df -kP / 2>/dev/null | tail -1`;

const prevCpu = new Map(); // key -> { total, idle }

function cpuPercent(key, total, idle) {
  const p = prevCpu.get(key); prevCpu.set(key, { total, idle });
  if (!p || total <= p.total) return null;
  const dt = total - p.total, di = idle - p.idle;
  return Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
}

function parseRemote(key, out) {
  const sec = {}; let cur = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^@(\w+)(?:\s(.*))?$/);
    if (m) { cur = m[1]; sec[cur] = m[2] ? [m[2]] : []; continue; }
    if (cur) sec[cur].push(line);
  }
  const r = { os: (sec.OS || [''])[0].trim() || null, cpu: null, cores: null, load: null, memTotal: null, memUsed: null, swapTotal: null, swapUsed: null, diskTotal: null, diskUsed: null, uptime: null };
  if (sec.L && sec.L[0]) { const f = sec.L[0].trim().split(/\s+/); r.load = f.slice(0, 3).map(Number); }
  if (sec.N && sec.N[0]) r.cores = parseInt(sec.N[0], 10) || null;
  if (sec.S && sec.S[0]) { const f = sec.S[0].trim().split(/\s+/).slice(1).map(Number); const idle = (f[3] || 0) + (f[4] || 0); const total = f.reduce((a, b) => a + b, 0); r.cpu = cpuPercent(key, total, idle); }
  if (sec.M) {
    const kv = {}; for (const l of sec.M) { const m = l.match(/^(\w+):\s+(\d+)/); if (m) kv[m[1]] = parseInt(m[2], 10) * 1024; }
    if (kv.MemTotal) { r.memTotal = kv.MemTotal; const avail = kv.MemAvailable != null ? kv.MemAvailable : (kv.MemFree || 0) + (kv.Buffers || 0) + (kv.Cached || 0); r.memUsed = kv.MemTotal - avail; }
    if (kv.SwapTotal) { r.swapTotal = kv.SwapTotal; r.swapUsed = kv.SwapTotal - (kv.SwapFree || 0); }
  }
  if (sec.U && sec.U[0]) r.uptime = parseFloat(sec.U[0]);
  if (sec.MS && sec.MS[0]) r.memTotal = parseInt(sec.MS[0], 10) || null;
  if (sec.VM && r.memTotal) {
    let page = 4096, active = 0, wired = 0, compressed = 0;
    for (const l of sec.VM) { let m; if ((m = l.match(/page size of (\d+)/))) page = +m[1]; else if ((m = l.match(/^Pages active:\s+(\d+)/))) active = +m[1]; else if ((m = l.match(/^Pages wired down:\s+(\d+)/))) wired = +m[1]; else if ((m = l.match(/^Pages occupied by compressor:\s+(\d+)/))) compressed = +m[1]; }
    r.memUsed = (active + wired + compressed) * page;
  }
  if (sec.UP && sec.UP.length >= 2) { const m = sec.UP[0].match(/sec = (\d+)/); const now = parseInt(sec.UP[1], 10); if (m && now) r.uptime = now - parseInt(m[1], 10); }
  if (sec.D && sec.D[0]) { const f = sec.D[0].trim().split(/\s+/); if (f.length >= 5) { r.diskTotal = parseInt(f[1], 10) * 1024; r.diskUsed = parseInt(f[2], 10) * 1024; } }
  return r;
}

async function remoteStats(session, key) {
  const out = await session.exec(SCRIPT, { timeout: 10000 });
  return parseRemote(key, out.stdout || '');
}

function wslStats(distro, key) {
  const b64 = Buffer.from(SCRIPT, 'utf8').toString('base64');
  return new Promise((resolve, reject) => execFile('wsl.exe', ['-d', distro, '--', 'sh', '-c', `echo ${b64} | base64 -d | sh`], { encoding: 'utf8', windowsHide: true, timeout: 10000 }, (err, out) => (err && !out) ? reject(err) : resolve(parseRemote(key, out || ''))));
}

async function localStats(key) {
  const cpus = os.cpus();
  let total = 0, idle = 0; for (const c of cpus) { for (const k of Object.keys(c.times)) total += c.times[k]; idle += c.times.idle; }
  const r = { os: process.platform, cpu: cpuPercent(key, total, idle), cores: cpus.length, load: process.platform === 'win32' ? null : os.loadavg(), memTotal: os.totalmem(), memUsed: os.totalmem() - os.freemem(), swapTotal: null, swapUsed: null, diskTotal: null, diskUsed: null, uptime: os.uptime() };
  try { const st = await fs.promises.statfs(os.homedir()); r.diskTotal = st.blocks * st.bsize; r.diskUsed = (st.blocks - st.bfree) * st.bsize; } catch (_) {}
  return r;
}

module.exports = { remoteStats, wslStats, localStats, parseRemote, SCRIPT };
