'use strict';
// Application wiring: vault flow, tabs, shortcuts, prompts, settings/appearance.
window.App = (() => {
  const { $, $$, h } = UI;
  const app = { tabs: [], activeId: null, settings: null, home: '', platform: 'linux', info: null, detached: new URLSearchParams(location.search).get('detached') === '1' };
  let lockTimer = null;
  const wallpaperCache = new Map(); // path -> data url

  // ---------- helpers ----------
  app.activeTab = () => app.tabs.find(x => x.id === app.activeId) || null;
  app.sessionsForHost = (hostId) => app.tabs.filter(x => x.hostId === hostId && x.status === 'connected');
  app.focusTerminal = () => { const tb = app.activeTab(); if (tb && !UI.modalOpen) tb.focus(); };
  app.fitActive = () => { requestAnimationFrame(() => { const tb = app.activeTab(); if (tb) tb.fitNow(); }); };
  app.tabBySession = (sid) => app.tabs.find(x => x.sessionId === sid);

  // ---------- tabs = groups of split panes ----------
  app.panes = () => app.tabs.flatMap(g => g.panes);
  app.tabBySession = (sid) => app.panes().find(x => x.sessionId === sid);
  app.sessionsForHost = (hostId) => app.panes().filter(x => x.hostId === hostId && x.status === 'connected');
  app.activeGroup = () => app.tabs.find(g => g.id === app.activeId) || null;
  app.activeTab = () => { const g = app.activeGroup(); return g ? (g.activePane || g.panes[0] || null) : null; };
  app.onPaneFocus = (pane) => { updateStatus(); app.updateIndexStatus(); renderTabs(); Files.syncToTab(pane); app.refreshStats(); };

  const paneCallbacks = {
    onStatus: (tb, st) => { if (st === 'connected' && !app.detached) Recent.add(tb); renderTabs(); updateStatus(); Files.onSessionsChanged(); Hosts.render(); if (st === 'connected' && tb === app.activeTab()) { Files.syncToTab(tb, true); app.refreshStats(); } if (st !== 'connected' && tb === app.activeTab()) app.refreshStats(); },
    onTitle: (tb, title) => { if (tb === app.activeTab()) window.api.window.setTitle(`${title} — terhui`); renderTabs(); },
    onCwd: (tb, p) => { console.debug('[cwd]', tb.id, tb.sessionId, p, 'active:', tb === app.activeTab()); Files.onCwd(tb, p); if (tb === app.activeTab()) updateStatus(); },
    onResize: (tb) => { if (tb === app.activeTab()) updateStatus(); },
    onZoom: (d) => app.zoom(d),
    onFocus: (tb) => { if (tb.group && tb.group.activePane !== tb) tb.group.focus(tb); },
  };

  /** Open a terminal: in a new tab, or as a split of pane `from` (dir 'h' | 'v'). Returns the pane. */
  app.openTerminal = async ({ hostId, entry, profile, from, dir, before }) => {
    if (profile && !entry) entry = { name: profile.name, host: 'local', username: '', local: true };
    const pane = new TerminalTab({ hostId, entry, profile, settings: app.settings, callbacks: paneCallbacks });
    let group = from ? from.group : null;
    if (!group) { group = new TabGroup(app); app.tabs.push(group); $('#terminals').append(group.wrap); }
    group.add(pane, from, dir, before);
    activateTab(group.id);
    renderTabs();
    await pane.connect();
    if (pane.status === 'connected' && !app.detached) Recent.add(pane);
    return pane;
  };
  app.split = (dir, from, before) => { from = from || app.activeTab(); if (!from) return; if (!dir) { const r = from.wrap.getBoundingClientRect(); dir = r.width > r.height * 1.5 ? 'h' : 'v'; } return app.openTerminal({ hostId: from.hostId, entry: from.entry, profile: from.profile, from, dir, before }); };
  const IS_MAC = navigator.platform.startsWith('Mac');
  const MOD = IS_MAC ? 'Cmd' : 'Ctrl';   // for shortcut hints
  app.dropGroup = (g) => { const idx = app.tabs.indexOf(g); if (idx < 0) return; app.tabs.splice(idx, 1); g.wrap.remove(); if (app.activeId === g.id) { const next = app.tabs[Math.min(idx, app.tabs.length - 1)]; activateTab(next ? next.id : null); } renderTabs(); };
  /** Move a pane out of its group into a new tab. */
  app.detachPane = (pane) => { const src = pane.group; if (!src || src.panes.length < 2) return; src.remove(pane); const g = new TabGroup(app); app.tabs.push(g); $('#terminals').append(g.wrap); g.add(pane); activateTab(g.id); };
  /** Move a whole tab (group) into a new window at screen position x,y — like dragging an editor tab out of an IDE. */
  app.detachGroup = async (g, x, y) => {
    if (!g || !g.panes.length) return;
    const payload = { panes: g.panes.map(p => p.toPayload()), tree: g.serializeTree() };
    const r = g.wrap.getBoundingClientRect();
    try { await window.api.window.detach({ payload, x, y, width: Math.round(Math.min(r.width + 20, 1000)), height: Math.round(Math.min(r.height + 90, 700)) }); }
    catch (e) { UI.errToast(e); return; }
    for (const p of g.panes) p.release();
    g.panes = []; app.dropGroup(g);
    if (app.detached && !app.tabs.length) window.api.window.closeSelf();
  };
  /** Serialize a tab for another window and drop it here (the sessions stay alive in main). */
  function exportGroup(g) {
    const payload = { panes: g.panes.map(p => p.toPayload()), tree: g.serializeTree() };
    for (const p of g.panes) p.release();
    g.panes = []; app.dropGroup(g);
    if (app.detached && !app.tabs.length) window.api.window.closeSelf();
    return payload;
  }
  /** Move a tab to an existing window ('main' or a window id from window.list). */
  app.moveGroupTo = async (g, target) => {
    const payload = { panes: g.panes.map(p => p.toPayload()), tree: g.serializeTree() };
    try { await window.api.window.sendTab({ target, payload }); } catch (e) { UI.errToast(e); return; }
    exportGroup(g);
  };
  app.attachToMain = (g) => app.moveGroupTo(g, 'main');
  // Cross-window drag: while a tab from another window is being dragged, our tab bar and pane edges accept it.
  app.remoteDrag = null;
  window.api.on('drag:state', (st) => { app.remoteDrag = st.active ? { id: st.id } : null; if (!st.active) { $('#tabs').classList.remove('drop'); document.querySelectorAll('.drop-hint').forEach(x => { x.hidden = true; }); } });
  window.api.on('drag:export', ({ id, reqId }) => { const g = app.tabs.find(x => x.dragId === id); window.api.window.dragExported({ reqId, payload: g ? exportGroup(g) : null }); });
  app.claimRemoteDrag = (dock) => { const rd = app.remoteDrag; if (!rd) return; app.remoteDrag = null; window.api.window.dragClaim({ id: rd.id, dock }).catch(UI.errToast); };
  /** Receive a tab from another window: rebuild the panes and take over their sessions. */
  window.api.on('detach:init', (payload) => {
    if (!app.ready) { const t = setInterval(() => { if (app.ready) { clearInterval(t); adoptPayload(payload); } }, 50); return; }   // the event can arrive before init() finished
    adoptPayload(payload);
  });
  function adoptPayload(payload) {
    const panes = payload.panes.map(p => { const pane = new TerminalTab({ hostId: p.hostId, entry: p.entry, profile: p.profile, settings: app.settings, callbacks: paneCallbacks }); pane.title = p.title; return pane; });
    const g = new TabGroup(app); app.tabs.push(g); $('#terminals').append(g.wrap);
    g.restore(payload.tree, panes);
    window.api.window.own(payload.panes.map(p => p.sessionId).filter(Boolean));
    panes.forEach((pane, i) => pane.adopt(payload.panes[i]));
    const at = payload.dock && TabGroup.paneById(payload.dock.paneId);
    if (at && at.group && at.group !== g) { TabGroup.dock(g, at, payload.dock.zone); activateTab(at.group.id); at.group.focus(panes[0]); }   // dropped on a pane edge → split beside it
    else activateTab(g.id);
    renderTabs(); updateStatus();
  }
  app.focusNeighbor = (direction) => { const g = app.activeGroup(); const p = app.activeTab(); if (!g || !p) return; const n = g.neighbor(p, direction); if (n) g.focus(n); };

  function activateTab(id) {
    console.debug('[tab] activate', id);
    app.activeId = id;
    for (const g of app.tabs) g.id === id ? g.show() : g.hide();
    $('#welcome').hidden = app.tabs.length > 0;
    renderTabs(); updateStatus(); app.updateIndexStatus();
    const g = app.activeGroup(); if (g) window.api.window.setTitle(`${g.title} — terhui`);
    Files.syncToTab(app.activeTab()); app.refreshStats();
  }
  app.activateTab = activateTab;

  /** Close one pane (asks if it is connected); closes the tab when it was the last pane. */
  async function closePane(pane, force) {
    const g = pane.group; if (!g) return;
    if (!force && pane.status === 'connected' && app.settings.confirmClose) { if (!await UI.confirm(t('tab.close.confirm'))) return; }
    const left = g.remove(pane);
    await pane.close();
    if (left === 0) {
      const idx = app.tabs.indexOf(g); app.tabs.splice(idx, 1); g.wrap.remove();
      if (app.activeId === g.id) { const next = app.tabs[Math.min(idx, app.tabs.length - 1)]; activateTab(next ? next.id : null); }
    }
    renderTabs(); updateStatus(); Files.onSessionsChanged(); Hosts.render();
    if (!app.tabs.length) { window.api.window.setTitle('terhui'); if (app.detached) window.api.window.closeSelf(); }
  }
  app.closePane = closePane;
  async function closeTab(id, force) {
    const g = app.tabs.find(x => x.id === id); if (!g) return;
    if (!force && app.settings.confirmClose && g.panes.some(p => p.status === 'connected')) { if (!await UI.confirm(t('tab.close.confirm'))) return; }
    for (const p of g.panes.slice()) await closePane(p, true);
  }
  app.closeTab = closeTab;

  function renderTabs() {
    const box = $('#tabs'); box.innerHTML = '';
    if (!box._dnd) {   // drop a pane on the tab bar → its own tab; drag tabs to reorder
      box._dnd = true;
      box.addEventListener('dragenter', (e) => { if (TabGroup.dragState || app.remoteDrag) e.preventDefault(); });
      box.addEventListener('dragover', (e) => { if (TabGroup.dragState || app.remoteDrag) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; box.classList.add('drop'); } });
      box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drop'); });
      box.addEventListener('drop', (e) => {
        box.classList.remove('drop');
        const ds = TabGroup.dragState;
        if (!ds && app.remoteDrag) { e.preventDefault(); app.claimRemoteDrag(null); return; }   // a tab from another window
        if (!ds) return;
        e.preventDefault(); TabGroup.endDrag();
        if (ds.kind === 'pane') { const p = TabGroup.paneById(ds.id); if (p) app.detachPane(p); return; }
        const gid = ds.id;
        {
          const from = app.tabs.findIndex(g => g.id === gid); if (from < 0) return;
          const over = e.target.closest('.tab'); let to = app.tabs.length - 1;
          if (over) { const r = over.getBoundingClientRect(); to = app.tabs.findIndex(g => g.id === over.dataset.id) + (e.clientX > r.left + r.width / 2 ? 1 : 0); }
          const [g] = app.tabs.splice(from, 1); if (to > from) to--; app.tabs.splice(Math.max(0, Math.min(to, app.tabs.length)), 0, g); renderTabs();
        }
      });
    }
    for (const g of app.tabs) {
      const p = g.activePane || g.panes[0]; if (!p) continue;
      const hh = p.hostId ? Hosts.byId(p.hostId) : null;
      const inactive = g.panes.every(x => x.status !== 'connected' && x.status !== 'connecting');
      const split = g.panes.length > 1;
      // Split tabs render one segment per pane (like Chrome's split view): click a segment to focus that pane.
      const segs = split ? g.panes.map(pp => {
        const ph = pp.hostId ? Hosts.byId(pp.hostId) : null;
        return h('span', { class: 'seg' + (pp === g.activePane ? ' cur' : '') + (pp.status !== 'connected' && pp.status !== 'connecting' ? ' dead' : ''), title: `${pp.entry.username || ''}@${pp.entry.host}:${pp.entry.port || 22}`,
          onClick: (e) => { e.stopPropagation(); activateTab(g.id); g.focus(pp); } },
          ph && ph.color ? h('span', { class: 'hc', style: { background: ph.color } }) : null,
          h('span', { class: 'title' }, pp.title + (pp.status === 'connecting' ? '…' : '')));
      }) : [h('span', { class: 'title' }, p.title + (p.status === 'connecting' ? '…' : ''))];
      const el = h('div', { class: 'tab' + (g.id === app.activeId ? ' active' : '') + (inactive ? ' inactive' : '') + (split ? ' split' : ''), dataset: { id: g.id }, title: split ? '' : (p.local ? p.profile.command : `${p.entry.username || ''}@${p.entry.host}:${p.entry.port || 22}`) + (inactive ? ' (' + t('tab.inactive') + ')' : ''), onClick: () => activateTab(g.id), onAuxclick: (e) => { if (e.button === 1) closeTab(g.id); } },
        !split && hh && hh.color ? h('span', { class: 'hc', style: { background: hh.color } }) : null,
        ...segs,
        h('span', { class: 'close tab-close', title: t('close'), onClick: (e) => { e.stopPropagation(); closeTab(g.id); } }, Icon('close', 12)));
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', g.id); e.dataTransfer.effectAllowed = 'move'; TabGroup.startDrag('tab', g.id);
        g.dragId = Math.random().toString(36).slice(2); window.api.window.dragBegin({ id: g.dragId }).catch(() => {});   // other windows may take the drop
      });
      el.addEventListener('dragend', async (e) => {
        TabGroup.endDrag();
        const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
        const noTarget = e.dataTransfer.dropEffect === 'none';
        const id = g.dragId; let claimed = false;
        try { ({ claimed } = await window.api.window.dragEnd({ id })); } catch (_) {}
        if (claimed || !app.tabs.includes(g)) return;   // another window took the tab
        // dropped outside every window (nothing accepted it and the pointer left the viewport) → tear the tab off
        if (noTarget && outside) app.detachGroup(g, e.screenX - 60, e.screenY - 20);
      });
      el.addEventListener('contextmenu', async (e) => { e.preventDefault(); activateTab(g.id);
        let others = []; try { others = await window.api.window.list(); } catch (_) {}
        UI.ctxmenu(e.clientX, e.clientY, [
        { label: t('pane.splitRight'), kbd: IS_MAC ? 'Cmd+D' : 'Ctrl+Shift+5', onClick: () => app.split('h') },
        { label: t('pane.splitDown'), kbd: IS_MAC ? 'Cmd+Shift+D' : 'Ctrl+Shift+6', onClick: () => app.split('v') },
        { label: t('tab.duplicate'), onClick: () => app.openTerminal({ hostId: p.hostId, entry: p.entry, profile: p.profile }) },
        '-',
        { label: t('tab.detach'), onClick: () => app.detachGroup(g, window.screenX + 80, window.screenY + 80) },
        ...others.map(w => ({ label: w.main ? t('tab.attach') : t('tab.moveTo', { title: w.title || 'terhui' }), onClick: () => app.moveGroupTo(g, w.id) })),
        '-',
        { label: t('menu.files'), onClick: () => p.local ? Files.openFor({ local: true, path: p.fsHome() }) : p.sessionId && Files.openFor({ sessionId: p.sessionId }), disabled: !p.sessionId },
        { label: t('tab.reconnect'), onClick: () => p.reconnect(), disabled: p.status === 'connected' },
        '-', { label: t('pane.close'), kbd: app.platform === 'darwin' ? 'Cmd+W' : 'Ctrl+Shift+W', onClick: () => closePane(p), disabled: g.panes.length < 2 },
        { label: t('close'), onClick: () => closeTab(g.id) }]); });
      box.append(el);
    }
  }
  function updateStatus() {
    const tb = app.activeTab();
    $('#st-cwd').textContent = tb ? (tb.cwd || '') : '';
    $('#st-session').textContent = tb ? `${tb.status === 'connected' ? '●' : '○'} ${tb.local ? tb.profile.name : `${tb.entry.username || ''}@${tb.entry.host}:${tb.entry.port || 22}`}` : '';
    $('#st-size').textContent = tb ? `${tb.term.cols}×${tb.term.rows}` : '';
  }
  app.updateIndexStatus = async () => {
    return;   // index status is shown inside the jump palette; the status bar no longer carries it
  };
  app.renderTabs = renderTabs;
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
    activateTab(tb.group.id);
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
  window.api.on('pty:data', ({ sessionId, data }) => { const tb = app.tabBySession(sessionId); if (tb) tb.onData(data); });
  window.api.on('pty:exit', ({ sessionId, exitCode }) => { const tb = app.tabBySession(sessionId); if (tb) tb.onClosed('exit ' + exitCode); });
  window.api.on('ssh:shell-closed', ({ sessionId }) => { const tb = app.tabBySession(sessionId); if (tb && tb.sessionId) window.api.ssh.close(sessionId); });
  window.api.on('ssh:banner', ({ sessionId, msg }) => { const tb = app.tabBySession(sessionId); if (tb) tb.term.write(msg.replace(/\r?\n/g, '\r\n')); });
  window.api.on('ssh:error', ({ message }) => UI.toast(message, 'error'));
  window.api.on('index:progress', (p) => { const tb = app.activeTab(); if (tb && Jump.indexKey(tb) === p.hostId) $('#st-msg').textContent = p.done ? '' : t('jump.building', { n: p.count }); });

  // ---------- host stats in the status bar ----------
  const fmtG = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + 'G' : Math.round(b / 1024 ** 2) + 'M');
  const fmtUp = (s) => { if (s == null) return ''; const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m`; };
  const pctClass = (p) => (p >= 90 ? 'crit' : p >= 70 ? 'hot' : '');
  let statsTimer = null, statsBusy = false, statsKey = null;
  async function pollStats(immediate) {
    const tb = app.activeTab(); const el = $('#st-stats');
    if (!tb || !tb.sessionId || tb.status !== 'connected') { el.innerHTML = ''; statsKey = null; return; }
    const key = tb.local ? 'local:' + (tb.profile.wsl || 'host') : 'ssh:' + tb.sessionId;
    if (statsBusy) return; statsBusy = true;
    try {
      const s = await window.api.stats.get(tb.local ? { local: true, wsl: tb.profile.wsl || '', key } : { sessionId: tb.sessionId, key });
      if (app.activeTab() !== tb) return;
      const parts = [];
      const memP = s.memTotal ? Math.round(s.memUsed / s.memTotal * 100) : null; const diskP = s.diskTotal ? Math.round(s.diskUsed / s.diskTotal * 100) : null;
      if (s.cpu != null) parts.push(h('span', { class: pctClass(s.cpu), title: (s.cores ? s.cores + ' cores' : '') }, h('b', null, 'CPU'), s.cpu + '%'));
      if (memP != null) parts.push(h('span', { class: pctClass(memP), title: `${fmtG(s.memUsed)} / ${fmtG(s.memTotal)}${s.swapTotal ? ` · swap ${fmtG(s.swapUsed)} / ${fmtG(s.swapTotal)}` : ''}` }, h('b', null, 'MEM'), `${fmtG(s.memUsed)}/${fmtG(s.memTotal)}`));
      if (diskP != null) parts.push(h('span', { class: pctClass(diskP), title: `${fmtG(s.diskUsed)} / ${fmtG(s.diskTotal)} used on /` }, h('b', null, 'DISK'), diskP + '%'));
      if (s.load) parts.push(h('span', { class: (s.cores && s.load[0] > s.cores) ? 'hot' : '', title: t('stats.loadHint') }, h('b', null, 'LOAD'), s.load.map(x => x.toFixed(2)).join(' ') + (s.cores ? ` / ${s.cores}` : '')));
      if (s.uptime != null) parts.push(h('span', { title: 'uptime' }, h('b', null, 'UP'), fmtUp(s.uptime)));
      el.innerHTML = ''; el.append(...parts); statsKey = key;
    } catch (_) { if (statsKey !== key) el.innerHTML = ''; }
    finally { statsBusy = false; }
  }
  function startStats() { clearInterval(statsTimer); statsTimer = setInterval(() => pollStats(), 5000); pollStats(true); }
  app.refreshStats = () => { $('#st-stats').innerHTML = ''; pollStats(true); setTimeout(() => pollStats(), 1200); };   // second sample gives a cpu % quickly

  // ---------- appearance ----------
  async function applyAppearance() {
    const s = app.settings;
    const theme = Themes.get(s.theme);
    const dark = Themes.isDark(theme);
    document.body.classList.toggle('theme-dark', dark); document.body.classList.toggle('theme-light', !dark);
    const root = document.documentElement;
    if (s.chromeFromTheme !== false) for (const [k, v] of Object.entries(Themes.chromeVars(theme))) root.style.setProperty(k, v);
    else for (const k of Object.keys(Themes.chromeVars(theme))) root.style.removeProperty(k);
    root.style.setProperty('--mono', s.fontFamily);
    // code editor colours follow the terminal scheme
    const cmv = { '--cm-bg': theme.background, '--cm-fg': theme.foreground, '--cm-cursor': theme.cursor || theme.foreground, '--cm-sel': theme.selectionBackground || 'rgba(128,128,128,.3)',
      '--cm-kw': theme.blue, '--cm-str': theme.green, '--cm-num': theme.yellow, '--cm-atom': theme.magenta, '--cm-def': theme.cyan, '--cm-type': theme.brightYellow || theme.yellow, '--cm-meta': theme.red, '--cm-tag': theme.red };
    for (const [k, v] of Object.entries(cmv)) if (v) root.style.setProperty(k, v);
    // OS title bar / caption buttons follow the UI colours (debounced: theme changes fire this often)
    const cs = getComputedStyle(root); const bg2 = cs.getPropertyValue('--bg2').trim(), fg = cs.getPropertyValue('--fg').trim();
    if (bg2 !== app._chromeSent) { app._chromeSent = bg2; clearTimeout(app._chromeTimer); app._chromeTimer = setTimeout(() => window.api.window.chrome({ bg: bg2, fg }), 150); }
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
    for (const tb of app.panes()) tb.applySettings(app.settings);
    resetLockTimer();
  }
  app.applySettings = applySettings;

  // ---------- settings dialog ----------
  let settingsCtl = null;
  function openSettings() {
    if (settingsCtl) { settingsCtl.focus(); return; }   // single instance: Ctrl+, again just refocuses
    if (UI.modalOpen) return;
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

    // --- Appearance: colour scheme (select + 16-colour strip preview)
    const themeSel = h('select', { onChange: () => { live({ theme: themeSel.value }); renderThemePreview(); } });
    const themePreview = h('div', { class: 'theme-preview' });
    const btnDeleteTheme = h('button', { onClick: async () => { const n = themeSel.value; if (Themes.builtin[n]) return; Themes.setCustom(await window.api.themes.delete(n)); live({ theme: 'Midnight' }); renderThemeList(); } }, t('settings.themes.delete'));
    const renderThemeList = () => {
      themeSel.innerHTML = '';
      const names = Object.keys(Themes.all);
      for (const n of names) themeSel.append(h('option', { value: n }, Themes.builtin[n] ? n : n + ' (custom)'));
      themeSel.value = names.includes(s().theme) ? s().theme : 'Midnight';
      renderThemePreview();
    };
    const renderThemePreview = () => {
      const th = Themes.get(themeSel.value);
      themePreview.innerHTML = ''; themePreview.style.background = th.background;
      for (const c of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']) themePreview.append(h('span', { style: { background: th[c] || th.foreground }, title: c }));
      btnDeleteTheme.hidden = !!Themes.builtin[themeSel.value];
    };
    renderThemeList();
    const btnImportTheme = h('button', { title: t('settings.themes.hint'), onClick: async () => { try { Themes.setCustom(await window.api.themes.import()); renderThemeList(); } catch (e) { UI.errToast(e); } } }, t('settings.themes.import'));

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
      L('settings.theme.pick'), h('div', { class: 'row' }, themeSel, btnImportTheme, btnDeleteTheme),
      h('label', null, ''), themePreview,
      L('settings.chromeFromTheme'), chk('chromeFromTheme'),
      L('settings.font'), text('fontFamily'),
      h('div', { class: 'hint' }, t('settings.fontHint')),
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
      ...(app.platform === 'darwin' ? [] : [L('settings.ctrlW'), chk('ctrlWClosesTab')]),
      L('host.localDir'), text('localDir'),
      L('settings.shellIntegration'), chk('shellIntegration'),
      L('settings.windowFrame'), h('div', { class: 'row' }, sel('windowFrame', [['integrated', t('settings.windowFrame.integrated')], ['native', t('settings.windowFrame.native')]], () => { dirty.windowFrame = f.windowFrame.value; app.settings.windowFrame = f.windowFrame.value; }), h('button', { onClick: () => { window.api.settings.set({ ...dirty }); window.api.window.relaunch(); } }, t('settings.restart'))),
      ...(app.platform === 'win32' ? [L('settings.winMaterial'), sel('winMaterial', [['none', t('settings.winMaterial.none')], ['mica', 'Mica'], ['acrylic', 'Acrylic'], ['tabbed', 'Mica Alt (tabbed)']], () => { dirty.winMaterial = f.winMaterial.value; app.settings.winMaterial = f.winMaterial.value; })] : []),
      h('div', { class: 'hint' }, t('settings.windowFrame.hint')),
    );

    // --- Security
    const knownBox = h('div', { class: 'kv', style: { maxHeight: '160px', overflow: 'auto' } });
    window.api.knownHosts.list().then(map => { for (const [k, v] of Object.entries(map)) knownBox.append(h('b', null, k), h('span', null, h('span', { class: 'fp' }, v.keyType + ' ' + v.fingerprint), ' ', h('button', { class: 'mini', onClick: async (e) => { const m = k.match(/^\[(.*)\]:(\d+)$/); await window.api.knownHosts.remove(m[1], +m[2]); e.target.parentElement.previousSibling.remove(); e.target.parentElement.remove(); } }, t('settings.forget')))); if (!Object.keys(map).length) knownBox.append(h('span', { class: 'hint' }, '—')); });
    const security = h('div', { class: 'form' },
      L('settings.autoLock'), num('autoLockMinutes', 0, 1440),
      L('settings.quick'), (() => { const box = h('div', { class: 'row' }); window.api.quick.status().then(q => { if (!q.method) { box.append(h('span', { class: 'hint', style: { gridColumn: 'auto' } }, t('settings.quick.na'))); return; } const cb = h('input', { type: 'checkbox' }); cb.checked = q.enabled; cb.addEventListener('change', async () => { try { if (cb.checked) await window.api.quick.enable(); else await window.api.quick.disable(); } catch (e) { UI.errToast(e); cb.checked = !cb.checked; } }); box.append(cb, h('span', null, t('settings.quick.label', { m: q.method === 'touchid' ? 'Touch ID' : 'Windows Hello' }))); }); return box; })(),
      h('div', { class: 'hint' }, t('settings.quick.hint')),
      L('settings.knownHosts'), knownBox,
      h('label', null, ''), h('div', { class: 'row' },
        h('button', { onClick: () => Hosts.importSshConfig() }, t('hosts.importSsh')),
        h('button', { onClick: () => changeMaster() }, t('vault.changeMaster')),
        h('button', { onClick: async () => { if (await UI.confirm(t('cache.all.confirm'), { danger: true, okLabel: t('cache.ok') })) { try { await window.api.cache.clearAll(); UI.toast(t('cache.done'), 'ok'); } catch (e) { UI.errToast(e); } } } }, t('cache.all')),
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

    settingsCtl = UI.modal({ title: t('settings.title'), body, width: '760px', closeOnBack: false, buttons: [
      { label: t('settings.reset'), onClick: () => { applySettings({ theme: 'Midnight', bgImage: '', bgDim: 0.55, bgBlur: 0, bgFit: 'cover', termOpacity: 0.85, termPadding: 10, chromeFromTheme: true, fontSize: 14, lineHeight: 1.15 }); renderThemeList(); refreshWp(); return UI.KEEP_OPEN; } },
      { label: t('cancel'), onClick: () => { const revert = {}; for (const k of Object.keys(dirty)) revert[k] = snapshot[k]; applySettings(revert, { persist: false }); return null; } },
      { label: t('apply'), primary: true, onClick: () => { window.api.settings.set({ ...dirty }); dirty = {}; return true; } },
    ] });
    settingsCtl.promise.then(() => { settingsCtl = null; });
  }

  // ---------- vault ----------
  async function vaultFlow() {
    const st = await window.api.vault.status();
    if (st.unlocked) return true;
    const create = !st.exists;
    let quick = { method: null, enabled: false };
    try { quick = await window.api.quick.status(); } catch (_) {}
    const quickName = quick.method === 'touchid' ? 'Touch ID' : quick.method === 'hello' ? 'Windows Hello' : '';
    return new Promise((resolve) => {
      // Lock screen: a full-window layer with one compact card (password + optional biometric button)
      const pw = h('input', { type: 'password', autofocus: true, placeholder: t('vault.master'), autocomplete: 'off' });
      const eye = h('button', { class: 'icon-btn eye', type: 'button', tabindex: '-1', title: t('vault.show'), onClick: () => { pw.type = pw.type === 'password' ? 'text' : 'password'; eye.classList.toggle('on', pw.type === 'text'); pw.focus(); } }, Icon('eye', 14));
      const pw2 = create ? h('input', { type: 'password', placeholder: t('vault.master2'), autocomplete: 'off' }) : null;
      const err = h('div', { class: 'lock-err' });
      const busy = h('div', { class: 'lock-busy', hidden: true }, t('vault.quick.waiting', { m: quickName }));
      const unlockBtn = h('button', { class: 'primary lock-unlock', onClick: () => submit() }, t(create ? 'vault.create' : 'vault.unlock'));
      const quickBtn = quick.method && quick.enabled && !create ? h('button', { class: 'lock-quick', onClick: () => tryQuick() }, Icon(quick.method === 'touchid' ? 'fingerprint' : 'hello', 16), t('vault.quick.unlock', { m: quickName })) : null;
      const card = h('div', { class: 'lock-card' },
        h('div', { class: 'lock-head' }, Icon('lock', 18), h('div', null, h('div', { class: 'lock-title' }, t(create ? 'vault.create.title' : 'vault.unlock.title')), h('div', { class: 'lock-sub' }, t(create ? 'vault.create.text' : 'vault.unlock.text')))),
        h('div', { class: 'lock-field' }, pw, eye),
        pw2 ? h('div', { class: 'lock-field' }, pw2) : null,
        err, busy,
        h('div', { class: 'lock-actions' }, quickBtn, unlockBtn));
      const layer = h('div', { class: 'lock-screen' }, card);
      $('#modals').append(layer);
      const stackEntry = UI.pushLayer ? UI.pushLayer(layer) : null;
      let done = false;
      const finish = (ok) => { if (done) return; done = true; layer.remove(); stackEntry && stackEntry.release(); resolve(ok); app.focusTerminal(); };
      async function submit() {
        err.textContent = '';
        try {
          if (create) { if (pw.value !== pw2.value) { err.textContent = t('vault.mismatch'); pw2.focus(); return; } if (!pw.value) { pw.focus(); return; } await window.api.vault.create(pw.value); }
          else { if (!pw.value) { pw.focus(); return; } await window.api.vault.unlock(pw.value); }
          finish(true);
        } catch (e) { err.textContent = /BAD_PASSWORD|Wrong master/.test(e.message) ? t('vault.bad') : e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); pw.select(); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
      }
      async function tryQuick() {
        err.textContent = ''; busy.hidden = false; quickBtn.disabled = true;
        try { await window.api.quick.unlock(); finish(true); }
        catch (e) { const m = (e.message || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); err.textContent = /Cancel/i.test(m) ? '' : m; if (/no longer matches/.test(m)) quickBtn.remove(); pw.focus(); }
        finally { busy.hidden = true; quickBtn.disabled = false; }
      }
      layer.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); return; }
        if (e.key === 'Enter') { e.preventDefault(); if (quickBtn && !pw.value && document.activeElement !== pw2) tryQuick(); else submit(); }
      });
      setTimeout(() => pw.focus(), 0);
      if (quickBtn) setTimeout(tryQuick, 150);   // like KeePassXC: the biometric prompt comes up immediately, password stays as fallback
    });
  }
  async function lock() {
    for (const g of app.tabs.slice()) await closeTab(g.id, true);
    await window.api.vault.lock();
    await startUnlocked();
  }
  async function startUnlocked() {
    while (!(await vaultFlow())) { /* keep asking */ }
    await Hosts.refresh(); Recent.render();
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
        case 'KeyW': e.preventDefault(); { const p = app.activeTab(); if (p) closePane(p); } return;
        case 'KeyD': e.preventDefault(); app.split(IS_MAC ? 'v' : undefined); return;   // mac: Cmd+Shift+D = split down (iTerm convention)
        case 'Digit5': e.preventDefault(); app.split('h'); return;
        case 'Digit6': e.preventDefault(); app.split('v'); return;
        case 'ArrowRight': case 'ArrowLeft': case 'ArrowDown': case 'ArrowUp':   // focus the neighbouring split pane
          e.preventDefault(); app.focusNeighbor(e.code.slice(5).toLowerCase()); return;
        case 'Enter': e.preventDefault(); { const g = app.activeGroup(); if (g) g.toggleMaximize(); } return;
        case 'KeyN': e.preventDefault(); { const tb = app.activeTab(); if (tb) app.openTerminal({ hostId: tb.hostId, entry: tb.entry, profile: tb.profile }); } return;
        case 'KeyR': e.preventDefault(); if (!inModal || $('.hist-modal')) History.open(); return;
        case 'Tab': e.preventDefault(); cycleTab(-1); return;
        case 'PageUp': e.preventDefault(); cycleTab(-1); return;
        case 'PageDown': e.preventDefault(); cycleTab(1); return;
        case 'KeyL': e.preventDefault(); lock(); return;
        case 'Comma': e.preventDefault(); openSettings(); return;
      }
    } else if (ctrl && !e.altKey) {
      // Cmd+W (macOS) always closes the pane; Ctrl+W does so outside the terminal, or inside it too when enabled
      // in Settings (by default the shell keeps Ctrl+W = delete word).
      if (e.code === 'KeyD' && e.metaKey && !inModal) { e.preventDefault(); app.split('h'); return; }
      if (e.code === 'KeyW' && !inModal) {
        const inTerm = !!(document.activeElement && document.activeElement.closest('.xterm'));
        if (e.metaKey || !inTerm || app.settings.ctrlWClosesTab) { e.preventDefault(); const p = app.activeTab(); if (p) closePane(p); return; }
      }
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
    } else if (e.altKey && e.shiftKey && !ctrl && (e.code === 'Equal' || e.code === 'Minus')) { e.preventDefault(); app.split(e.code === 'Equal' ? 'h' : 'v');
    } else if (!IS_MAC && e.altKey && !ctrl && !e.shiftKey && /^Arrow(Left|Right|Up|Down)$/.test(e.code)) { e.preventDefault(); app.focusNeighbor(e.code.slice(5).toLowerCase());   // on macOS Option+arrows belong to the shell (word jumps)
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
    Icon.mount(document);
    app.settings = await window.api.settings.get();
    app.info = await window.api.app.info(); app.home = app.info.home; app.platform = app.info.platform;
    const wi = await window.api.window.info();
    document.body.classList.toggle('wco', wi.frame === 'integrated');
    document.body.classList.toggle('detached', app.detached);
    document.body.classList.toggle('mac', wi.platform === 'darwin');
    window.api.on('window:fullscreen', (on) => { document.body.classList.toggle('fullscreen', !!on); app.fitActive(); });
    document.body.classList.toggle('material', wi.material !== 'none');
    try { Themes.setCustom(await window.api.themes.list()); } catch (_) {}
    I18N.setLocale(app.settings.locale);
    await applyAppearance();
    $('#sidebar').style.width = (app.settings.sidebarWidth || 240) + 'px';
    $('#files').style.width = (app.settings.filePanelWidth || 520) + 'px';
    resizer($('#sidebar-resizer'), $('#sidebar'), 1, 'sidebarWidth');
    resizer($('#files-resizer'), $('#files'), -1, 'filePanelWidth');
    try { app.profiles = await window.api.profiles.list(); } catch (_) { app.profiles = []; }
    Hosts.init(app); Files.init(app); Jump.init(app); History.init(app); Recent.init(app);
    $('#btn-sidebar').addEventListener('click', toggleSidebar);
    $('#btn-newtab').addEventListener('click', () => { const sel = Hosts.selectedId; if (sel) Hosts.connectSelected(); else $('#quick-connect').focus(); });
    $('#btn-jump').addEventListener('click', () => Jump.open());
    $('#btn-history').addEventListener('click', () => History.open());
    $('#btn-split').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); UI.ctxmenu(r.left, r.bottom + 2, [{ label: t('pane.splitRight'), kbd: IS_MAC ? 'Cmd+D' : 'Ctrl+Shift+5', onClick: () => app.split('h') }, { label: t('pane.splitDown'), kbd: IS_MAC ? 'Cmd+Shift+D' : 'Ctrl+Shift+6', onClick: () => app.split('v') }, { label: t('pane.splitLeft'), onClick: () => app.split('h', null, true) }, { label: t('pane.splitUp'), onClick: () => app.split('v', null, true) }, '-', { label: t('pane.maximize'), kbd: MOD + '+Shift+Enter', onClick: () => { const g = app.activeGroup(); if (g) g.toggleMaximize(); } }]); });
    $('#btn-files').addEventListener('click', () => Files.toggle());
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-lock').addEventListener('click', lock);
    window.addEventListener('resize', () => app.fitActive());
    app.ready = true;   // tabs from other windows can be adopted from here on, even while the lock screen is up
    if (app.detached) { try { await Hosts.refresh(); } catch (_) {} }   // vault is already open in main; no lock screen here
    else { await startUnlocked(); if (app.settings.filePanelOpen) Files.show(); }
    startStats();
  }
  init().catch(err => { console.error(err); UI.toast(String(err), 'error', 10000); });

  app.openSettings = openSettings; app.lock = lock; app.toggleSidebar = toggleSidebar;
  return app;
})();
