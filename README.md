# tsshx

SSH-only terminal emulator with an encrypted credential vault, a built-in SFTP/FTP file manager
and a remote directory index for instant `cd`. Built on Electron, [xterm.js](https://xtermjs.org),
[ssh2](https://github.com/mscdex/ssh2) and [basic-ftp](https://github.com/patrickjuchli/basic-ftp).

```
npm install        # deps; postinstall rebuilds node-pty / cpu-features for Electron
npm start          # run
npm test           # backend tests under Electron's Node (in-process SSH server)
npm run dist:linux # AppImage + deb   (dist:win → nsis + portable, dist:mac → dmg)
```

## Features

**Terminal**
- xterm.js with WebGL renderer (DOM fallback), 24-bit colour, Unicode 11 wide chars / emoji, 10k+ scrollback.
- Tabs, search (Ctrl+Shift+F), clickable URLs, copy/paste (Ctrl+Shift+C / Ctrl+Shift+V, middle/right click).
- Reconnect on `Enter` after a dropped session, `Ctrl+Scroll` / `Ctrl +`/`-` zoom.
- Split panes inside a tab: `Ctrl+Shift+5` right, `Ctrl+Shift+6` down, `Ctrl+Shift+D` auto (macOS: `Cmd+D` right, `Cmd+Shift+D` down),
  `Ctrl/Cmd+Shift+arrows` move focus between panes (`Alt+arrows` too on Windows/Linux), `Ctrl+Shift+Enter` maximise/restore, `Ctrl+Shift+W` closes the pane. Mouse: split/maximise/close buttons in the
  pane header, drag a pane by its header onto the edge of another pane to re-dock it or onto the tab bar to make it a tab,
  drag a tab from the tab bar onto the edge of a pane to dock that whole tab beside it, drag tabs to reorder, drag dividers to resize. Each pane is its own SSH session.
- Appearance: 12 built-in colour schemes, import of xterm / Windows Terminal JSON schemes,
  wallpaper (any image) with dim/blur/fit, terminal opacity, padding, font, cursor; the UI is tinted from the scheme.
- Window: OS frame with Window Controls Overlay (tabs live in the title bar, native caption buttons, Win11 snap layouts and
  rounded corners; `hiddenInset` on macOS), caption colours follow the theme, optional Mica/Acrylic backdrop on Windows 11.
  Settings → General → Window frame switches back to a plain native title bar.

**Local terminals**
- Section "Local" in the sidebar: auto-detected shells (Windows: PowerShell 7, Windows PowerShell, cmd, every WSL distro,
  Git Bash; macOS/Linux: login shell, zsh, bash, fish), editable profiles (command, args, start dir, colour). node-pty
  (ConPTY on Windows). Local tabs get the same splits, history palette (bash/zsh/fish/PSReadLine files), directory index and
  file panel. Shell integration for local shells is injected through the environment (PROMPT_COMMAND for bash,
  WSLENV for WSL, a private ZDOTDIR for zsh), so nothing is typed into the shell. WSL tabs browse the distro's own file
  system through `\\wsl.localhost\<Distro>\` with paths mapped both ways (`/mnt/c` ↔ `C:\`).

**Credential vault**
- `vault.json` in the user-data dir, AES-256-GCM, key from master password via scrypt (N=2^15).
- Per host: name, group, colour, host/port, user, password **or** private key (pasted or file) + passphrase **or** ssh-agent,
  start dir, index root, notes. FTP hosts (plain / explicit TLS / implicit TLS) live in the same list.
- Import `~/.ssh/config` (Settings → Security), export/import JSON, change master password, auto-lock timer, quick connect `user@host:port`,
  Recent list in the sidebar (saved hosts, ad-hoc targets with "save as host", local shells).
- Host keys: trust-on-first-use with SHA256 fingerprint prompt, loud warning when a key changes; keyboard-interactive auth supported.

**File manager (Ctrl+Shift+E / F11)**
- Two panes, each can be Local, SFTP (same SSH connection as the tab, no second login) or FTP.
- Copy between any two panes (F5) incl. recursive directories, background transfer queue with progress and cancel,
  mkdir (F7), new file, rename (F6), delete (F8), chmod, hidden files, type-to-filter, sort, drag & drop
  (between panes and from the OS), built-in text editor (Ctrl+S), `cd` the terminal to the current folder,
  "follow terminal" mirrors the cwd of whichever pane is active (OSC 7 from shell integration), across panes and tabs.

**Directory index (Ctrl+P)**
- Builds a list of all directories (optionally files) on the host with one `find` over the SSH session
  (FTP: recursive walk), gzipped on disk per host. Fuzzy search (multi-term, subsequence, basename boost),
  `Enter` → `cd` in the terminal, `Ctrl+Enter` → open in the file panel. Rebuild any time, cancel, custom root.

**Status bar**: cwd of the active pane, host resources of the active tab refreshed every 5 s (CPU %, memory, root disk,
load average, uptime) via one `/proc` read over SSH (sysctl/vm_stat on macOS hosts), `os`/`statfs` locally, inside the distro for WSL.

**Shell history (Ctrl+Shift+R)**
- Reads `.bash_history`, `.zsh_history` (extended format, multi-line) and fish history of the host over the SSH session,
  merges them with commands run from the palette, ranks by recency and frequency. Search, `Enter` inserts the command on
  the prompt (replacing half-typed input), `Ctrl+Enter` runs it, `Ctrl+B` pins per host, `Ctrl+C` copies.
- Shell integration (on by default, Settings → General): right after login the app types one hidden bootstrap line into
  bash/zsh so history is flushed after every command and the cwd is reported via OSC 7 (used by "follow terminal").

## Shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+P | Jump to indexed directory |
| Ctrl+Shift+R | Shell history |
| Ctrl+Shift+E / F11 | Toggle file manager |
| Ctrl+Shift+F | Search in terminal |
| Ctrl+Shift+T | Focus quick connect |
| Ctrl+Shift+N | Duplicate current session |
| Ctrl+Shift+5 / 6 / D, Cmd+D / Cmd+Shift+D (macOS) | Split pane right / down / auto |
| Ctrl/Cmd+Shift+arrows (Alt+arrows on Win/Linux), Ctrl+Shift+Enter | Move between panes, maximise pane |
| Ctrl+Shift+W, Cmd+W (macOS) | Close pane / tab (Ctrl+W too outside the terminal, or inside if enabled in Settings) |
| Ctrl+Tab / Ctrl+Shift+Tab, Alt+1..9 | Switch tabs |
| Ctrl+Shift+H | Toggle host sidebar |
| Ctrl+Shift+L | Lock vault |
| Ctrl+, | Settings |
| File panes: F2 refresh, F4 edit, F5 copy, F6 rename, F7 mkdir, F8 delete, Tab switch pane, Ctrl+L path | |

## Layout

```
src/main/      Electron main: vault.js, ssh-manager.js, fs-backends.js (local/sftp/ftp + transfers), indexer.js, main.js (IPC)
src/preload/   contextBridge API (sandboxed renderer, no Node access)
src/renderer/  UI: app.js, terminal.js (xterm), hosts.js, files.js, jump.js, themes.js, i18n.js (en/ru), ui.js
test/          node:test suite + in-process SSH server (ssh2 server + node-pty + OpenSSH sftp-server)
```

Data lives in Electron's user-data directory (`~/.config/tsshx` on Linux): `vault.json`, `known_hosts.json`,
`settings.json`, `index/*.json.gz`, `themes/*.json`. Set `TSSHX_USER_DATA=/path` to relocate it.
