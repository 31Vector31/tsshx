'use strict';
// Terminal tab: xterm.js instance bound to one SSH session.
window.TerminalTab = (() => {
  // Terminal background becomes translucent when a wallpaper is set (or opacity < 1) so the image shows through.
  const needsTransparency = (s) => !!s.bgImage || (s.termOpacity != null && s.termOpacity < 1);
  const themeFor = (s) => {
    const base = Themes.get(s.theme);
    if (!needsTransparency(s)) return { ...base };
    const alpha = s.bgImage ? Math.max(0, Math.min(1, s.termOpacity == null ? 0.85 : s.termOpacity)) : Math.max(0, Math.min(1, s.termOpacity));
    return { ...base, background: Themes.withAlpha(base.background, alpha) };
  };

  let seq = 1;

  class TerminalTab {
    /**
     * @param {object} o { hostId, entry (public view or adhoc entry), settings, container, callbacks:{onTitle,onStatus,onCwd,onClosed} }
     */
    constructor(o) {
      this.id = 'tab' + (seq++);
      this.hostId = o.hostId || null;
      this.entry = o.entry;                 // { name, host, port, username, ... }
      this.settings = o.settings;
      this.cb = o.callbacks || {};
      this.sessionId = null;
      this.status = 'idle';
      this.cwd = null; this.remoteHome = null;
      this.title = o.entry.name || `${o.entry.username || ''}@${o.entry.host}`;
      this.wrap = UI.h('div', { class: 'term-wrap', style: { padding: (o.settings.termPadding == null ? 10 : o.settings.termPadding) + 'px' } });
      if (o.container) o.container.append(this.wrap);
      this.group = null;
      this._buildTerm();
    }

    _buildTerm() {
      const s = this.settings;
      const term = new Terminal({
        allowProposedApi: true,
        fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight || 1.1,
        theme: themeFor(s),
        scrollback: s.scrollback || 10000,
        cursorStyle: s.cursorStyle || 'block', cursorBlink: !!s.cursorBlink,
        allowTransparency: needsTransparency(s), macOptionIsMeta: true, drawBoldTextInBrightColors: true, minimumContrastRatio: 1,
        rightClickSelectsWord: false, windowsMode: false, convertEol: false, scrollOnUserInput: true,
        windowOptions: { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true },
        // "*" so every printable Unicode scalar goes straight through; wide/emoji handled by unicode11
      });
      this.term = term;
      this.fit = new FitAddon.FitAddon(); term.loadAddon(this.fit);
      this.search = new SearchAddon.SearchAddon(); term.loadAddon(this.search);
      this.unicode = new Unicode11Addon.Unicode11Addon(); term.loadAddon(this.unicode); term.unicode.activeVersion = '11';
      term.loadAddon(new WebLinksAddon.WebLinksAddon((ev, uri) => { if (ev.ctrlKey || ev.metaKey || true) window.api.shell.openExternal(uri); }));
      term.open(this.wrap);
      this._loadRenderer();
      // OSC 7 (cwd) and title tracking → file panel "follow terminal"
      term.parser.registerOscHandler(7, (data) => { try { const u = new URL(data); if (u.protocol === 'file:') this._setCwd(decodeURIComponent(u.pathname)); } catch (_) {} return true; });
      term.onTitleChange((title) => {
        // Common default prompts set the title to "user@host: /path" or "user@host:~/path"
        const m = title.match(/^[^\s:@]+@[^\s:]+:\s*(.+)$/);
        if (m) { let p = m[1].trim(); if (p === '~' || p.startsWith('~/')) { if (this.remoteHome) p = this.remoteHome + p.slice(1); else return; } if (p.startsWith('/')) this._setCwd(p); }
        this.cb.onTitle && this.cb.onTitle(this, title);
      });
      term.onData((d) => { if (this.sessionId && this.status === 'connected') window.api.ssh.write(this.sessionId, d); else if (this.status === 'closed' && d === '\r') this.reconnect(); });
      term.onBinary((d) => { if (this.sessionId) window.api.ssh.write(this.sessionId, d); });
      term.onResize(({ cols, rows }) => { if (this.sessionId) window.api.ssh.resize(this.sessionId, cols, rows); this.cb.onResize && this.cb.onResize(this, cols, rows); });
      term.onSelectionChange(() => { if (this.settings.copyOnSelect && term.hasSelection()) window.api.clipboard.write(term.getSelection()); });
      term.attachCustomKeyEventHandler((e) => this._keyHandler(e));
      this.wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); if (this.settings.rightClickPaste) this.paste(); });
      this.wrap.addEventListener('mouseup', (e) => { if (e.button === 1) { e.preventDefault(); this.paste(); } });
      this.wrap.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); this.cb.onZoom && this.cb.onZoom(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
      this.wrap.addEventListener('mousedown', () => this.cb.onFocus && this.cb.onFocus(this));
      this.wrap.addEventListener('focusin', () => this.cb.onFocus && this.cb.onFocus(this));
      this._ro = new ResizeObserver(() => this.fitNow());
      this._ro.observe(this.wrap);
    }

    _loadRenderer() {
      if (this.settings.renderer !== 'webgl') return;
      try {
        const gl = new WebglAddon.WebglAddon();
        gl.onContextLoss(() => { try { gl.dispose(); } catch (_) {} this.webgl = null; });
        this.term.loadAddon(gl); this.webgl = gl;
      } catch (err) { console.warn('webgl renderer unavailable, using DOM renderer', err); this.webgl = null; }
    }

    _keyHandler(e) {
      if (e.type !== 'keydown') return true;
      const ctrlShift = (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey;
      if (ctrlShift && (e.code === 'KeyC')) { if (this.term.hasSelection()) { this.copy(); e.preventDefault(); return false; } return true; }
      if (ctrlShift && (e.code === 'KeyV')) { this.paste(); e.preventDefault(); return false; }
      if (ctrlShift && e.code === 'Insert') { this.paste(); return false; }
      if (e.ctrlKey && e.code === 'Insert') { this.copy(); return false; }
      if (e.shiftKey && e.code === 'Insert') { this.paste(); return false; }
      // let the app handle global shortcuts
      if ((e.ctrlKey || e.metaKey) && (ctrlShift || ['KeyP', 'Tab', 'PageUp', 'PageDown', 'Equal', 'Minus', 'Digit0'].includes(e.code))) return false;
      if (e.altKey && /^Digit[1-9]$/.test(e.code)) return false;
      if (e.altKey && e.shiftKey && (e.code === 'Equal' || e.code === 'Minus')) return false;
      if (e.altKey && !e.shiftKey && !e.ctrlKey && /^Arrow/.test(e.code)) return false;
      return true;
    }

    copy() { if (this.term.hasSelection()) { window.api.clipboard.write(this.term.getSelection()); this.term.clearSelection(); } }
    async paste() {
      const text = await window.api.clipboard.read();
      if (text) this.term.paste(text);
    }

    fitNow() {
      if (this.wrap.hidden || !this.wrap.isConnected || this.wrap.offsetWidth === 0) return;
      try { this.fit.fit(); } catch (_) {}
    }

    show() { this.wrap.hidden = false; requestAnimationFrame(() => { this.fitNow(); this.term.focus(); }); }
    hide() { this.wrap.hidden = true; }
    focus() { this.term.focus(); }

    applySettings(s) {
      this.settings = s;
      const t = this.term;
      t.options.fontFamily = s.fontFamily; t.options.fontSize = s.fontSize; t.options.lineHeight = s.lineHeight || 1.1;
      if (t.options.allowTransparency !== needsTransparency(s)) t.options.allowTransparency = needsTransparency(s);
      t.options.theme = themeFor(s); t.options.scrollback = s.scrollback; t.options.cursorStyle = s.cursorStyle; t.options.cursorBlink = !!s.cursorBlink;
      this.wrap.style.padding = (s.termPadding == null ? 10 : s.termPadding) + 'px';
      if ((s.renderer === 'webgl') !== !!this.webgl) { if (this.webgl) { this.webgl.dispose(); this.webgl = null; } else this._loadRenderer(); }
      this.fitNow();
    }

    _setStatus(st, detail) { this.status = st; this.cb.onStatus && this.cb.onStatus(this, st, detail); }
    _setCwd(p) { if (p !== this.cwd) { this.cwd = p; this.cb.onCwd && this.cb.onCwd(this, p); } }

    async connect() {
      this.fitNow();
      this._setStatus('connecting');
      this.term.writeln(`\x1b[90m${t('ssh.connecting', { h: `${this.entry.username ? this.entry.username + '@' : ''}${this.entry.host}:${this.entry.port || 22}` })}\x1b[0m`);
      try {
        const r = await window.api.ssh.connect({ hostId: this.hostId, entry: this.hostId ? undefined : this.entry, cols: this.term.cols, rows: this.term.rows });
        this.sessionId = r.sessionId;
        this.entry = { ...this.entry, username: r.username };
        this._setStatus('connected');
        this._startIntegration();
        this.term.focus();
        window.api.ssh.exec(this.sessionId, 'printf %s "$HOME"').then(x => { if (x && x.stdout) this.remoteHome = x.stdout.trim(); }).catch(() => {});
      } catch (err) {
        const msg = (err.message || String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        this.term.writeln(`\x1b[31m${t('ssh.error', { m: msg })}\x1b[0m`);
        this.term.writeln(`\x1b[90m${t('ssh.reconnect')}\x1b[0m`);
        this._setStatus('closed', msg);
      }
    }

    // ---- shell integration ----
    // One bootstrap line is typed into the remote shell right after the prompt appears. It makes bash/zsh
    // append history after every command (live history palette) and print the cwd via OSC 7 after every
    // prompt (file panel "follow terminal"). Its echo is cut out of the output stream so nothing shows.
    _startIntegration() {
      if (this.settings.shellIntegration === false || !this.sessionId) return;
      const tag = 'terhui-si';
      const dir = String(this.entry.startDir || '').trim();
      const cd = dir ? ` cd '${dir.replace(/'/g, "'\\''")}';` : '';
      const osc7 = 'printf "\\033]7;file://%s%s\\007" "$HOSTNAME" "$PWD"';
      const line = ` [ -n "$BASH" ] && { PROMPT_COMMAND='history -a;${osc7}'"\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; case "$(HISTTIMEFORMAT= history 1)" in *${tag}*) history -d $HISTCMD;; esac; }; [ -n "$ZSH_VERSION" ] && { setopt INC_APPEND_HISTORY; precmd(){ ${osc7.replace('$HOSTNAME', '$HOST')}; }; };${cd} #${tag}`;
      this.si = { phase: 'wait', line, tagBytes: new TextEncoder().encode(tag), buf: [], bufLen: 0, timer: setTimeout(() => this._siSend(), 2500) };
    }
    _siSend() {
      const si = this.si; if (!si || si.phase !== 'wait') return;
      clearTimeout(si.timer); si.phase = 'filter';
      window.api.ssh.write(this.sessionId, si.line + '\r');
      si.timer = setTimeout(() => this._siFlush(), 4000);
    }
    _siFlush() { const si = this.si; if (!si) return; clearTimeout(si.timer); this.si = null; for (const c of si.buf) this.term.write(c); }
    static _concat(chunks, len) { const out = new Uint8Array(len); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; }
    static _indexOf(hay, needle, from = 0) {
      outer: for (let i = from; i <= hay.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return i; }
      return -1;
    }

    onData(data) {
      const si = this.si;
      if (!si) return this.term.write(data);
      if (si.phase === 'wait') {
        this.term.write(data);
        // The prompt is most likely on screen when output ends with a prompt-like symbol and a space.
        const tail = new TextDecoder().decode(data.subarray(Math.max(0, data.length - 96))).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
        if (/[$#%>❯»→›]\s$/.test(tail)) this._siSend();
        return;
      }
      si.buf.push(data); si.bufLen += data.length;
      const all = TerminalTab._concat(si.buf, si.bufLen);
      const idx = TerminalTab._indexOf(all, si.tagBytes);
      const nl = idx < 0 ? -1 : all.indexOf(0x0a, idx);
      if (nl < 0) { si.buf = [all]; if (si.bufLen > 65536) this._siFlush(); return; }
      let start = all.lastIndexOf(0x0a, idx); start = start < 0 ? 0 : start + 1;   // beginning of the prompt line that echoed us
      clearTimeout(si.timer); this.si = null;
      if (start > 0) this.term.write(all.subarray(0, start));
      if (nl + 1 < all.length) this.term.write(all.subarray(nl + 1));
    }

    onClosed(reason) {
      this.sessionId = null;
      this.term.writeln(`\r\n\x1b[33m${t('ssh.closed')}\x1b[0m \x1b[90m(${reason || ''})\x1b[0m`);
      this.term.writeln(`\x1b[90m${t('ssh.reconnect')}\x1b[0m`);
      this._setStatus('closed', reason);
      this.cb.onClosed && this.cb.onClosed(this);
    }

    async reconnect() { if (this.status === 'connected' || this.status === 'connecting') return; this.term.reset(); await this.connect(); }

    /** Send a `cd` to the interactive shell. */
    cd(path) {
      if (!this.sessionId) return;
      const q = "'" + String(path).replace(/'/g, "'\\''") + "'";
      window.api.ssh.write(this.sessionId, `\x15cd ${q}\n`); // ^U clears any half-typed command first
      this._setCwd(path);
      this.term.focus();
    }

    /** Put text on the shell's command line (replacing any half-typed input); run=true also presses Enter. */
    insert(text, run) {
      if (!this.sessionId) return;
      window.api.ssh.write(this.sessionId, '\x15');
      this.term.paste(text.replace(/\r?\n$/, ''));
      if (run) window.api.ssh.write(this.sessionId, '\r');
      this.term.focus();
    }

    async close() {
      if (this.sessionId) { try { await window.api.ssh.close(this.sessionId); } catch (_) {} }
      this._ro.disconnect();
      try { this.term.dispose(); } catch (_) {}
      this.wrap.remove();
    }
  }
  return TerminalTab;
})();
