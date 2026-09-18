'use strict';
// Quick unlock (KeePassXC-style): after one password unlock the vault key is stored encrypted by the OS
// (Electron safeStorage → DPAPI / Keychain / libsecret) and released again only after a presence check:
// Touch ID on macOS, Windows Hello on Windows. Linux keyrings have no biometric gate → not offered.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { safeStorage, systemPreferences } = require('electron');

const FILE = 'quick-unlock.bin';

// Windows Hello via WinRT UserConsentVerifier (Windows PowerShell 5.1 has the WinRT projection).
const PS_PRELUDE = `[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }`;

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 120000, encoding: 'utf8' }, (err, out, errOut) => err ? reject(new Error((errOut || err.message).trim())) : resolve(String(out).trim()));
  });
}

class QuickUnlock {
  constructor(userData, log) { this.file = path.join(userData, FILE); this.log = log || (() => {}); this._method = undefined; }

  /** 'touchid' | 'hello' | null — cached after the first check. */
  async method() {
    if (this._method !== undefined) return this._method;
    let m = null;
    try {
      if (!safeStorage.isEncryptionAvailable()) m = null;
      else if (process.platform === 'darwin') m = systemPreferences.canPromptTouchID() ? 'touchid' : null;
      else if (process.platform === 'win32') {
        const out = await runPowerShell(`${PS_PRELUDE}\n(Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])).ToString()`);
        m = out === 'Available' ? 'hello' : null;
        if (!m) this.log('windows hello unavailable:', out);
      }
    } catch (err) { this.log('quick unlock probe failed', err.message); m = null; }
    this._method = m;
    return m;
  }
  enabled() { return fs.existsSync(this.file); }

  async enable(key) {
    if (!(await this.method())) throw new Error('Quick unlock is not available on this system');
    const blob = safeStorage.encryptString(Buffer.from(key).toString('base64'));
    fs.writeFileSync(this.file, blob, { mode: 0o600 });
  }
  disable() { try { fs.unlinkSync(this.file); } catch (_) {} }

  /** Presence check, then the key. Throws on cancel / failure / missing file. */
  async unlock(reason) {
    const m = await this.method();
    if (!m || !this.enabled()) throw new Error('Quick unlock is not set up');
    if (m === 'touchid') await systemPreferences.promptTouchID(reason || 'unlock the vault');
    else if (m === 'hello') {
      // The Windows Security dialog is created by the PowerShell process, which has no foreground rights, so it
      // opens behind our window. Find it (class "Credential Dialog Xaml Host") and pull it to the front while
      // the verification is pending (AttachThreadInput trick).
      const script = `${PS_PRELUDE}
Add-Type -Namespace T -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@
$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${(reason || 'Unlock the vault').replace(/'/g, "''")}')
$task = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]).Invoke($null, @($op))
$raised = $false
for ($i = 0; $i -lt 100 -and -not $task.IsCompleted; $i++) {
  if (-not $raised) {
    $hw = [T.W]::FindWindow('Credential Dialog Xaml Host', $null)
    if ($hw -ne [IntPtr]::Zero) {
      $fg = [T.W]::GetForegroundWindow(); $ft = [T.W]::GetWindowThreadProcessId($fg, [IntPtr]::Zero); $me = [T.W]::GetCurrentThreadId()
      [T.W]::AttachThreadInput($ft, $me, $true) | Out-Null
      [T.W]::BringWindowToTop($hw) | Out-Null; [T.W]::SetForegroundWindow($hw) | Out-Null
      [T.W]::AttachThreadInput($ft, $me, $false) | Out-Null
      $raised = $true
    }
  }
  Start-Sleep -Milliseconds 50
}
$task.Wait(); $task.Result.ToString()`;
      const out = await runPowerShell(script);
      if (out !== 'Verified') { const e = new Error(out === 'Canceled' ? 'Cancelled' : 'Windows Hello: ' + out); e.code = out === 'Canceled' ? 'CANCELLED' : 'DENIED'; throw e; }
    }
    return Buffer.from(safeStorage.decryptString(fs.readFileSync(this.file)), 'base64');
  }
}

module.exports = { QuickUnlock };
