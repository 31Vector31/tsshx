'use strict';
// Application wiring: vault flow, tabs, shortcuts, prompts, settings/appearance.
window.App = (() => {
  const { $, $$, h } = UI;
  const app = { tabs: [], activeId: null, settings: null, home: '', platform: 'linux', info: null };
  let lockTimer = null;
  const wallpaperCache = new Map(); // path -> data url

  // ---------- helpers ----------
  app.activeTab = () => app.tabs.find(x => x.id === app.activeId) || null;
  app.sessionsForHost = (hostId) => app.tabs.filter(x => x.hostId === hostId && x.status === 'connected');
  app.focusTerminal = () => { const tb = app.activeTab(); if (tb && !UI.modalOpen) tb.focus(); };
  app.fitActive = () => { requestAnimationFrame(() => { const tb = app.activeTab(); if (tb) tb.fitNow(); }); };
  app.tabBySession = (sid) => app.tabs.find(x => x.sessionId === sid);

  // ---------- tabs ----------
  app.openTerminal = async ({ hostId, entry }) => {
    const tab = new TerminalTab({ hostId, entry, settings: app.settings, container: $('#terminals'), callbacks: {
      onStatus: (tb, st) => { renderTabs(); updateStatus(); Files.onSessionsChanged(); Hosts.render(); if (st === 'connected' && Files.visible() && Files.panes[1].fsId === 'local' && Files.panes[1].path === '') Files.openFor({ sessionId: tb.sessionId }); },
      onTitle: (tb, title) => { if (tb === app.activeTab()) window.api.window.setTitle(`${title} — terhui`); },
      onCwd: (tb, p) => Files.onCwd(tb, p),
      onResize: () => updateStatus(),
      onZoom: (d) => app.zoom(d),
    } });
    app.tabs.push(tab);
    activateTab(tab.id);
    await tab.connect();
    return tab;
  };
  function activateTab(id) {
    app.activeId = id;
    for (const tb of app.tabs) tb.id === id ? tb.show() : tb.hide();
    $('#welcome').hidden = app.tabs.length > 0;
    renderTabs(); updateStatus(); app.updateIndexStatus();
    const tb = app.activeTab(); if (tb) window.api.window.setTitle(`${tb.title} — terhui`);
  }
  app.activateTab = activateTab;
  async function closeTab(id, force) {
    const tb = app.tabs.find(x => x.id === id); if (!tb) return;
    if (!force && tb.status === 'connected' && app.settings.confirmClose) { if (!await UI.confirm(t('tab.close.confirm'))) return; }
    const idx = app.tabs.indexOf(tb);
    app.tabs.splice(idx, 1);
    await tb.close();
    if (app.activeId === id) { const next = app.tabs[Math.min(idx, app.tabs.length - 1)]; activateTab(next ? next.id : null); }
    else renderTabs();
    Files.onSessionsChanged(); Hosts.render();
    if (!app.tabs.length) window.api.window.setTitle('terhui');
  }
  app.closeTab = closeTab;
  function renderTabs() {
    const box = $('#tabs'); box.innerHTML = '';
    for (const tb of app.tabs) {
      const hh = tb.hostId ? Hosts.byId(tb.hostId) : null;
      const el = h('div', { class: 'tab' + (tb.id === app.activeId ? ' active' : ''), dataset: { id: tb.id }, title: `${tb.entry.username || ''}@${tb.entry.host}:${tb.entry.port || 22}`, onClick: () => activateTab(tb.id), onAuxclick: (e) => { if (e.button === 1) closeTab(tb.id); } },
        h('span', { class: 'dot ' + tb.status, style: hh && hh.color && tb.status === 'connected' ? { background: hh.color } : undefined }),
        h('span', { class: 'title' }, tb.title),
        h('span', { class: 'close', onClick: (e) => { e.stopPropagation(); closeTab(tb.id); } }, '✕'));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); UI.ctxmenu(e.clientX, e.clientY, [
        { label: t('tab.duplicate'), onClick: () => app.openTerminal({ hostId: tb.hostId, entry: tb.entry }) },
        { label: t('menu.files'), onClick: () => tb.sessionId && Files.openFor({ sessionId: tb.sessionId }), disabled: !tb.sessionId },
        { label: t('tab.reconnect'), onClick: () => tb.reconnect(), disabled: tb.status === 'connected' },
        '-', { label: t('close'), kbd: 'Ctrl+Shift+W', onClick: () => closeTab(tb.id) }]); });
      box.append(el);
    }
  }
  function updateStatus() {
    const tb = app.activeTab();
    $('#st-session').textContent = tb ? `${tb.status === 'connected' ? '●' : '○'} ${tb.entry.username || ''}@${tb.entry.host}:${tb.entry.port || 22}` : '';
    $('#st-size').textContent = tb ? `${tb.term.cols}×${tb.term.rows}` : '';
  }
  app.updateIndexStatus = async () => {
    const tb = app.activeTab(); if (!tb) { $('#st-index').textContent = ''; return; }
    try { const info = await window.api.index.info(Jump.indexKey(tb)); $('#st-index').textContent = info.exists ? t('st.index', { n: info.count }) : t('st.noindex'); } catch (_) { $('#st-index').textContent = ''; }
  };
  app.zoom = (d) => { const fs = Math.max(6, Math.min(40, app.settings.fontSize + d)); applySettings({ fontSize: fs }); };

  // ---------- files / index helpers (used by Hosts menu) ----------
  app.openFiles = (o) => Files.openFor(o);
  app.openFilesForHost = async (hostId) => {
    let tb = app.sessionsForHost(hostId)[0];
    if (!tb) { tb = await app.openTerminal({ hostId, entry: Hosts.byId(hostId) }); }
    if (tb.sessionId) Files.openFor({ sessionId: tb.sessionId });
  };
  app.buildIndexForHost = async (hostId) => {
    let tb = app.sessionsForHost(hostId)[0];
    if (!tb) tb = await app.openTerminal({ hostId, entry: Hosts.byId(hostId) });
    if (!tb.sessionId) return;
    activateTab(tb.id);
    Jump.open();
  };

  // ---------- prompts from main ----------
  window.api.on('prompt', ({ id, kind, payload }) => {
    const answer = (v) => window.api.answerPrompt(id, v);
    if (kind === 'hostkey') {
      const body = h('div', null,
        h('p', { class: payload.changed ? 'err' : '' }, t(payload.changed ? 'hostkey.changed' : 'hostkey.new', { h: payload.host, p: payload.port })),
        h('div', { class: 'kv' }, h('b', null, 'Type'), h('span', null, payload.keyType), h('b', null, 'SHA256'), h('span', { class: 'fp' }, payload.fingerprint),
          payload.previous ? h('b', null, t('hostkey.prev')) : null, payload.previous ? h('span', { class: 'fp' }, payload.previous) : null));
      UI.modal({ title: t('hostkey.title'), body, closeOnBack: false, buttons: [{ label: t('hostkey.reject'), value: false }, { label: t('hostkey.accept'), value: true, primary: !payload.changed, cls: payload.changed ? 'danger' : '' }] }).promise.then(v => answer(v === true));
    } else if (kind === 'kbd') {
      const inputs = payload.prompts.map(p => h('input', { type: p.echo ? 'text' : 'password', style: { width: '100%' } }));
      const body = h('div', null, payload.instructions ? h('p', null, payload.instructions) : null, ...payload.prompts.map((p, i) => h('div', { style: { marginBottom: '8px' } }, h('div', { class: 'hint' }, p.prompt), inputs[i])));
      UI.modal({ title: payload.name || t('kbd.title'), body, closeOnBack: false, buttons: [{ label: t('cancel'), value: null }, { label: t('ok'), primary: true, onClick: () => inputs.map(i => i.value) }] }).promise.then(v => answer(Array.isArray(v) ? v : null));
    } else if (kind === 'password') {
      UI.prompt(t('password.title', { u: payload.username, h: payload.host }), { password: true }).then(v => answer(v));
    } else answer(null);
  });

  // ---------- ssh events ----------
  window.api.on('ssh:data', ({ sessionId, data }) => { const tb = app.tabBySession(sessionId); if (tb) tb.onData(data); });
  window.api.on('ssh:closed', ({ sessionId, reason }) => { const tb = app.tabBySession(sessionId); if (tb) tb.onClosed(reason); });
  window.api.on('ssh:shell-closed', ({ sessionId }) => { const tb = app.tabBySession(sessionId); if (tb && tb.sessionId) window.api.ssh.close(sessionId); });
  window.api.on('ssh:banner', ({ sessionId, msg }) => { const tb = app.tabBySession(sessionId); if (tb) tb.term.write(msg.replace(/\r?\n/g, '\r\n')); });
  window.api.on('ssh:error', ({ message }) => UI.toast(message, 'error'));
  window.api.on('index:progress', (p) => { const tb = app.activeTab(); if (tb && Jump.indexKey(tb) === p.hostId) $('#st-index').textContent = p.done ? t('st.index', { n: p.count }) : t('jump.building', { n: p.count }); });

  // ---------- appearance ----------
  async function applyAppearance() {
    const s = app.settings;
    const theme = Themes.get(s.theme);
    const dark = Themes.isDark(theme);
    document.body.className = dark ? 'theme-dark' : 'theme-light';
    const root = document.documentElement;
    if (s.chromeFromTheme !== false) for (const [k, v] of Object.entries(Themes.chromeVars(theme))) root.style.setProperty(k, v);
    else for (const k of Object.keys(Themes.chromeVars(theme))) root.style.removeProperty(k);
    root.style.setProperty('--mono', s.fontFamily);
    // wallpaper
    const wp = $('#wallpaper'); const center = $('#center');
    if (s.bgImage) {
      try {
        let url = wallpaperCache.get(s.bgImage);
        if (!url) { url = await window.api.wallpaper.read(s.bgImage); wallpaperCache.set(s.bgImage, url); }
        wp.style.backgroundImage = `url("${url}")`;
        const fit = s.bgFit || 'cover';
        wp.style.backgroundSize = fit === 'tile' ? 'auto' : fit === 'center' ? 'auto' : fit;
        wp.style.backgroundRepeat = fit === 'tile' ? 'repeat' : 'no-repeat';
        wp.style.filter = s.bgBlur ? `blur(${s.bgBlur}px)` : '';
        wp.style.transform = s.bgBlur ? `scale(${1 + s.bgBlur / 200})` : '';
        const dim = Math.max(0, Math.min(1, s.bgDim == null ? 0.5 : s.bgDim));
        root.style.setProperty('--wp-dim', dark ? `rgba(0,0,0,${dim})` : `rgba(255,255,255,${dim})`);
        center.classList.add('has-wallpaper');
      } catch (err) { UI.errToast(err); center.classList.remove('has-wallpaper'); wp.style.backgroundImage = ''; }
    } else { center.classList.remove('has-wallpaper'); wp.style.backgroundImage = ''; wp.style.filter = ''; wp.style.transform = ''; }
  }

  function applySettings(patch, { persist = true } = {}) {
    app.settings = { ...app.settings, ...patch };
    if (persist) window.api.settings.set(patch);
    I18N.setLocale(app.settings.locale);
    applyAppearance();
    for (const tb of app.tabs) tb.applySettings(app.settings);
    resetLockTimer();
  }
  app.applySettings = applySettings;

  // ---------- settings dialog ----------
  function openSettings() {
    const snapshot = { ...app.settings };
    const s = () => app.settings;
    const f = {};
    let dirty = {};
    const live = (patch) => { Object.assign(dirty, patch); applySettings(patch, { persist: false }); };
    const sel = (name, opts, onChange) => { f[name] = h('select', { onChange: () => (onChange || (() => live({ [name]: f[name].value })))() }, ...opts.map(([v, l]) => h('option', { value: v }, l))); f[name].value = String(s()[name]); return f[name]; };
    const num = (name, min, max, step = 1) => { f[name] = h('input', { type: 'number', value: s()[name], min, max, step, style: { width: '100px' }, onChange: () => live({ [name]: +f[name].value }) }); return f[name]; };
    const chk = (name, onChange) => { const lbl = h('label', { class: 'row', style: { justifyContent: 'flex-start' } }); f[name] = h('input', { type: 'checkbox', onChange: () => (onChange || (() => live({ [name]: f[name].checked })))() }); f[name].checked = !!s()[name]; lbl.append(f[name]); return lbl; };
    const range = (name, min, max, step, fmt) => { const out = h('output'); f[name] = h('input', { type: 'range', min, max, step, value: s()[name], onInput: () => { out.value = fmt(+f[name].value); live({ [name]: +f[name].value }); } }); out.value = fmt(+s()[name]); return h('div', { class: 'range-row' }, f[name], out); };
    const text = (name, attrs = {}) => { f[name] = h('input', { type: 'text', value: s()[name], spellcheck: 'false', onChange: () => live({ [name]: f[name].value.trim() || snapshot[name] }), ...attrs }); return f[name]; };
    const L = (k) => h('label', null, t(k));

    // --- Appearance: theme swatches
    const swatches = h('div', { class: 'swatches' });
    const renderSwatches = () => {
      swatches.innerHTML = '';
      for (const [name, th] of Object.entries(Themes.all)) {
        const sw = h('div', { class: 'swatch' + (name === s().theme ? ' active' : ''), style: { background: th.background, color: th.foreground }, onClick: () => { live({ theme: name }); renderSwatches(); }, title: name },
          h('div', { class: 'sw-name' }, name),
          h('div', { class: 'sw-colors' }, ...['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].map(c => h('span', { style: { background: th[c] || th.foreground } }))));
        if (!Themes.builtin[name]) sw.append(h('button', { class: 'mini', style: { alignSelf: 'flex-end' }, onClick: async (e) => { e.stopPropagation(); Themes.setCustom(await window.api.themes.delete(name)); if (s().theme === name) live({ theme: 'Midnight' }); renderSwatches(); } }, t('settings.themes.delete')));
        swatches.append(sw);
      }
    };
    renderSwatches();
    const btnImportTheme = h('button', { onClick: async () => { try { Themes.setCustom(await window.api.themes.import()); renderSwatches(); } catch (e) { UI.errToast(e); } } }, t('settings.themes.import'));

    // --- wallpaper
    const wpPreview = h('div', { class: 'wp-preview' });
    const wpPath = h('div', { class: 'hint', style: { gridColumn: 'auto', wordBreak: 'break-all' } });
    const refreshWp = async () => { const p = s().bgImage; wpPath.textContent = p || '—'; if (p) { try { wpPreview.style.backgroundImage = `url("${wallpaperCache.get(p) || await window.api.wallpaper.read(p)}")`; } catch (_) { wpPreview.style.backgroundImage = ''; } } else wpPreview.style.backgroundImage = ''; };
    refreshWp();
    const wpButtons = h('div', { class: 'row' },
      h('button', { onClick: async () => { const p = await window.api.wallpaper.pick(); if (p) { live({ bgImage: p }); refreshWp(); } } }, t('settings.wallpaper.pick')),
      h('button', { onClick: () => { live({ bgImage: '' }); refreshWp(); } }, t('settings.wallpaper.clear')));

    const pct = (v) => Math.round(v * 100) + '%';
    const appearance = h('div', { class: 'form' },
      h('div', { class: 'full' }, swatches), h('div', { class: 'full row' }, btnImportTheme, h('span', { class: 'hint' }, t('settings.themes.hint'))),
      L('settings.chromeFromTheme'), chk('chromeFromTheme'),
      L('settings.font'), text('fontFamily'),
      L('settings.fontSize'), h('div', { class: 'row' }, num('fontSize', 6, 40), L('settings.lineHeight'), num('lineHeight', 0.8, 2, 0.05)),
      L('settings.cursor'), h('div', { class: 'row' }, sel('cursorStyle', [['block', 'block'], ['underline', 'underline'], ['bar', 'bar']]), L('settings.blink'), chk('cursorBlink')),
      L('settings.padding'), range('termPadding', 0, 60, 1, v => v + 'px'),
      h('div', { class: 'full' }, h('div', { class: 'fieldset' }, h('legend', null, t('settings.wallpaper')),
        h('div', { class: 'form' },
          h('div', { class: 'full' }, wpPreview), h('div', { class: 'full' }, wpButtons), h('div', { class: 'full' }, wpPath),
          L('settings.wallpaper.fit'), sel('bgFit', [['cover', 'cover'], ['contain', 'contain'], ['center', 'center'], ['tile', 'tile']]),
          L('settings.dim'), range('bgDim', 0, 1, 0.05, pct),
          L('settings.blur'), range('bgBlur', 0, 30, 1, v => v + 'px'),
          L('settings.termOpacity'), range('termOpacity', 0, 1, 0.05, pct)))),
    );

    // --- General
    const general = h('div', { class: 'form' },
      L('settings.locale'), sel('locale', [['en', 'English'], ['ru', 'Русский']]),
      L('settings.renderer'), sel('renderer', [['webgl', 'WebGL (fast)'], ['dom', 'DOM (compatible)']]),
      L('settings.scrollback'), num('scrollback', 100, 1000000),
      L('settings.copyOnSelect'), chk('copyOnSelect'),
      L('settings.rightClickPaste'), chk('rightClickPaste'),
      L('settings.confirmClose'), chk('confirmClose'),
      L('host.localDir'), text('localDir'),
    );

    // --- Security
    const knownBox = h('div', { class: 'kv', style: { maxHeight: '160px', overflow: 'auto' } });
    window.api.knownHosts.list().then(map => { for (const [k, v] of Object.entries(map)) knownBox.append(h('b', null, k), h('span', null, h('span', { class: 'fp' }, v.keyType + ' ' + v.fingerprint), ' ', h('button', { class: 'mini', onClick: async (e) => { const m = k.match(/^\[(.*)\]:(\d+)$/); await window.api.knownHosts.remove(m[1], +m[2]); e.target.parentElement.previousSibling.remove(); e.target.parentElement.remove(); } }, t('settings.forget')))); if (!Object.keys(map).length) knownBox.append(h('span', { class: 'hint' }, '—')); });
    const security = h('div', { class: 'form' },
      L('settings.autoLock'), num('autoLockMinutes', 0, 1440),
      L('settings.knownHosts'), knownBox,
      h('label', null, ''), h('div', { class: 'row' },
        h('button', { onClick: () => changeMaster() }, t('vault.changeMaster')),
        h('button', { onClick: async () => { try { await window.api.hosts.exportFile(); } catch (e) { UI.errToast(e); } } }, t('hosts.export')),
        h('button', { onClick: async () => { try { const r = await window.api.hosts.importFile(); if (r) { UI.toast(t('hosts.imported', { n: r.added + r.updated }), 'ok'); Hosts.refresh(); } } catch (e) { UI.errToast(e); } } }, t('hosts.import'))),
      h('div', { class: 'hint full' }, t('settings.securityHint')),
    );

    const pages = { appearance, general, security };
    const tabsRow = h('div', { class: 'tabs-row' });
    const body = h('div', { class: 'settings-body' }, tabsRow);
    let cur = null;
    const showPage = (k) => { if (cur) cur.remove(); cur = pages[k]; body.append(cur); $$('button', tabsRow).forEach(b => b.classList.toggle('active', b.dataset.k === k)); };
    for (const k of Object.keys(pages)) tabsRow.append(h('button', { dataset: { k }, onClick: () => showPage(k) }, t('settings.' + k)));
    showPage('appearance');

    UI.modal({ title: t('settings.title'), body, width: '760px', closeOnBack: false, buttons: [
      { label: t('settings.reset'), onClick: () => { applySettings({ theme: 'Midnight', bgImage: '', bgDim: 0.55, bgBlur: 0, bgFit: 'cover', termOpacity: 0.85, termPadding: 10, chromeFromTheme: true, fontSize: 14, lineHeight: 1.15 }); return UI.KEEP_OPEN; } },
      { label: t('cancel'), onClick: () => { const revert = {}; for (const k of Object.keys(dirty)) revert[k] = snapshot[k]; applySettings(revert, { persist: false }); return null; } },
      { label: t('apply'), primary: true, onClick: () => { window.api.settings.set({ ...dirty }); dirty = {}; return true; } },
    ] });
  }

  // ---------- vault ----------
  async function vaultFlow() {
    const st = await window.api.vault.status();
    if (st.unlocked) return true;
    const create = !st.exists;
    return new Promise((resolve) => {
      const pw = h('input', { type: 'password', autofocus: true, style: { width: '100%' }, placeholder: t('vault.master') });
      const pw2 = create ? h('input', { type: 'password', style: { width: '100%', marginTop: '6px' }, placeholder: t('vault.master2') }) : null;
      const err = h('div', { class: 'err', style: { minHeight: '18px', marginTop: '6px' } });
      const body = h('div', { class: 'vault-screen' }, h('div', { class: 'logo' }, 'terhui'), create ? h('p', null, t('vault.create.text')) : null, pw, pw2, err);
      const ctl = UI.modal({ title: t(create ? 'vault.create.title' : 'vault.unlock.title'), body, closeOnBack: false, width: '420px', buttons: [{ label: t(create ? 'vault.create' : 'vault.unlock'), primary: true, onClick: async () => {
        try {
          if (create) { if (pw.value !== pw2.value) { err.textContent = t('vault.mismatch'); return UI.KEEP_OPEN; } if (!pw.value) return UI.KEEP_OPEN; await window.api.vault.create(pw.value); }
          else await window.api.vault.unlock(pw.value);
          return true;
        } catch (e) { err.textContent = /BAD_PASSWORD|Wrong master/.test(e.message) ? t('vault.bad') : e.message; pw.select(); return UI.KEEP_OPEN; }
      } }], onKey: (e) => { if (e.key === 'Escape') { e.stopPropagation(); return true; } return false; } });
      ctl.promise.then(v => resolve(v === true));
    });
  }
  async function lock() {
    for (const tb of app.tabs.slice()) await closeTab(tb.id, true);
    await window.api.vault.lock();
    await startUnlocked();
  }
  async function startUnlocked() {
    while (!(await vaultFlow())) { /* keep asking */ }
    await Hosts.refresh();
    resetLockTimer();
  }
  function changeMaster() {
    const o = h('input', { type: 'password', style: { width: '100%' }, placeholder: t('vault.old'), autofocus: true });
    const n = h('input', { type: 'password', style: { width: '100%', marginTop: '6px' }, placeholder: t('vault.new') });
    const n2 = h('input', { type: 'password', style: { width: '100%', marginTop: '6px' }, placeholder: t('vault.master2') });
    UI.modal({ title: t('vault.changeMaster'), body: h('div', null, o, n, n2), buttons: [{ label: t('cancel'), value: null }, { label: t('ok'), primary: true, onClick: async () => {
      if (n.value !== n2.value) { UI.toast(t('vault.mismatch'), 'warn'); return UI.KEEP_OPEN; }
      try { await window.api.vault.changeMaster(o.value, n.value); UI.toast(t('saved'), 'ok'); return true; } catch (e) { UI.toast(/BAD_PASSWORD|Wrong/.test(e.message) ? t('vault.bad') : e.message, 'error'); return UI.KEEP_OPEN; }
    } }] });
  }
  function resetLockTimer() {
    clearTimeout(lockTimer); lockTimer = null;
    const m = app.settings.autoLockMinutes | 0;
    if (m > 0) lockTimer = setTimeout(() => lock(), m * 60000);
  }
  ['mousemove', 'keydown', 'mousedown'].forEach(ev => document.addEventListener(ev, () => { if (lockTimer) resetLockTimer(); }, { passive: true }));

  // ---------- keyboard shortcuts ----------
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const inModal = UI.modalOpen;
    if (ctrl && e.shiftKey && !e.altKey) {
      switch (e.code) {
        case 'KeyE': e.preventDefault(); Files.toggle(); return;
        case 'KeyH': e.preventDefault(); toggleSidebar(); return;
        case 'KeyF': e.preventDefault(); openSearch(); return;
        case 'KeyT': e.preventDefault(); if (!inModal) { $('#quick-connect').focus(); } return;
        case 'KeyW': e.preventDefault(); if (app.activeId) closeTab(app.activeId); return;
        case 'KeyN': e.preventDefault(); { const tb = app.activeTab(); if (tb) app.openTerminal({ hostId: tb.hostId, entry: tb.entry }); } return;
        case 'KeyR': return; // reload (menu)
        case 'Tab': e.preventDefault(); cycleTab(-1); return;
        case 'PageUp': e.preventDefault(); cycleTab(-1); return;
        case 'PageDown': e.preventDefault(); cycleTab(1); return;
        case 'KeyL': e.preventDefault(); lock(); return;
        case 'Comma': e.preventDefault(); openSettings(); return;
      }
    } else if (ctrl && !e.altKey) {
      switch (e.code) {
        case 'KeyP': e.preventDefault(); if (!inModal || $('.jump-modal')) Jump.open(); return;
        case 'Tab': e.preventDefault(); cycleTab(1); return;
        case 'PageDown': e.preventDefault(); cycleTab(1); return;
        case 'PageUp': e.preventDefault(); cycleTab(-1); return;
        case 'Equal': case 'NumpadAdd': e.preventDefault(); app.zoom(1); return;
        case 'Minus': case 'NumpadSubtract': e.preventDefault(); app.zoom(-1); return;
        case 'Digit0': e.preventDefault(); applySettings({ fontSize: 14 }); return;
        case 'Comma': e.preventDefault(); openSettings(); return;
      }
    } else if (e.altKey && !ctrl && /^Digit[1-9]$/.test(e.code)) {
      const i = +e.code.slice(5) - 1; if (app.tabs[i]) { e.preventDefault(); activateTab(app.tabs[i].id); }
    } else if (e.code === 'F11' && !inModal) { e.preventDefault(); Files.toggle(); }
  }, true);
  function cycleTab(d) { if (!app.tabs.length) return; const i = app.tabs.findIndex(x => x.id === app.activeId); const n = (i + d + app.tabs.length) % app.tabs.length; activateTab(app.tabs[n].id); }

  // ---------- search bar ----------
  function openSearch() {
    const tb = app.activeTab(); if (!tb) return;
    const bar = $('#search-bar'); bar.hidden = false; const inp = $('#search-input'); inp.focus(); inp.select();
  }
  function closeSearch() { $('#search-bar').hidden = true; const tb = app.activeTab(); if (tb) { tb.search.clearDecorations(); tb.focus(); } }
  const searchOpts = () => ({ incremental: true, decorations: { matchOverviewRuler: '#e5c07b', activeMatchColorOverviewRuler: '#e06c75', matchBackground: 'rgba(229,192,123,0.35)', activeMatchBackground: 'rgba(224,108,117,0.55)' } });
  $('#search-input').addEventListener('input', () => { const tb = app.activeTab(); if (tb) tb.search.findNext($('#search-input').value, searchOpts()); });
  $('#search-input').addEventListener('keydown', (e) => { const tb = app.activeTab(); if (!tb) return; if (e.key === 'Enter') { e.shiftKey ? tb.search.findPrevious($('#search-input').value, searchOpts()) : tb.search.findNext($('#search-input').value, searchOpts()); } if (e.key === 'Escape') closeSearch(); });
  $('#search-next').addEventListener('click', () => { const tb = app.activeTab(); if (tb) tb.search.findNext($('#search-input').value, searchOpts()); });
  $('#search-prev').addEventListener('click', () => { const tb = app.activeTab(); if (tb) tb.search.findPrevious($('#search-input').value, searchOpts()); });
  $('#search-close').addEventListener('click', closeSearch);

  // ---------- layout ----------
  function toggleSidebar() { $('#sidebar').classList.toggle('collapsed'); $('#sidebar-resizer').hidden = $('#sidebar').classList.contains('collapsed'); app.fitActive(); }
  function resizer(handle, target, dir, key) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); const startX = e.clientX; const startW = target.getBoundingClientRect().width;
      const move = (ev) => { const w = startW + (ev.clientX - startX) * dir; target.style.width = w + 'px'; app.fitActive(); };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); window.api.settings.set({ [key]: target.getBoundingClientRect().width }); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  // ---------- init ----------
  async function init() {
    app.settings = await window.api.settings.get();
    app.info = await window.api.app.info(); app.home = app.info.home; app.platform = app.info.platform;
    try { Themes.setCustom(await window.api.themes.list()); } catch (_) {}
    I18N.setLocale(app.settings.locale);
    await applyAppearance();
    $('#sidebar').style.width = (app.settings.sidebarWidth || 240) + 'px';
    $('#files').style.width = (app.settings.filePanelWidth || 520) + 'px';
    resizer($('#sidebar-resizer'), $('#sidebar'), 1, 'sidebarWidth');
    resizer($('#files-resizer'), $('#files'), -1, 'filePanelWidth');
    Hosts.init(app); Files.init(app); Jump.init(app);
    $('#btn-sidebar').addEventListener('click', toggleSidebar);
    $('#btn-newtab').addEventListener('click', () => { const sel = Hosts.selectedId; if (sel) Hosts.connectSelected(); else $('#quick-connect').focus(); });
    $('#btn-jump').addEventListener('click', () => Jump.open());
    $('#btn-files').addEventListener('click', () => Files.toggle());
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-lock').addEventListener('click', lock);
    window.addEventListener('resize', () => app.fitActive());
    await startUnlocked();
    if (app.settings.filePanelOpen) Files.show();
    app.ready = true;
  }
  init().catch(err => { console.error(err); UI.toast(String(err), 'error', 10000); });

  app.openSettings = openSettings; app.lock = lock; app.toggleSidebar = toggleSidebar;
  return app;
})();
