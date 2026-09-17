'use strict';
// Recent connections in the sidebar footer: saved hosts, quick-connect (ad-hoc) targets and local shells.
window.Recent = (() => {
  const { $, h } = UI;
  let app = null;
  const MAX = 12;

  function init(a) { app = a; render(); }
  const list = () => (Array.isArray(app.settings.recent) ? app.settings.recent : []);
  const keyOf = (r) => r.hostId ? 'h:' + r.hostId : r.profileId ? 'p:' + r.profileId : 'a:' + (r.entry.username || '') + '@' + r.entry.host + ':' + (r.entry.port || 22);

  /** Record a pane's target (called when it connects). Ad-hoc entries never include secrets. */
  function add(pane) {
    let r;
    if (pane.local) r = { profileId: pane.profile.id, name: pane.profile.name, at: Date.now() };
    else if (pane.hostId) r = { hostId: pane.hostId, name: pane.title, at: Date.now() };
    else r = { entry: { host: pane.entry.host, port: pane.entry.port || 22, username: pane.entry.username || '' }, name: pane.title, at: Date.now() };
    const k = keyOf(r);
    const next = [r, ...list().filter(x => keyOf(x) !== k)].slice(0, MAX);
    app.settings.recent = next; window.api.settings.set({ recent: next }); render();
  }
  function remove(r) { const next = list().filter(x => keyOf(x) !== keyOf(r)); app.settings.recent = next; window.api.settings.set({ recent: next }); render(); }
  function open(r) {
    if (r.hostId) { const hh = Hosts.byId(r.hostId); if (hh) return hh.protocol === 'ftp' ? app.openFiles({ ftpHostId: hh.id }) : app.openTerminal({ hostId: hh.id, entry: hh }); return remove(r); }
    if (r.profileId) { const p = (app.profiles || []).find(x => x.id === r.profileId); if (p) return app.openTerminal({ profile: p }); return remove(r); }
    return app.openTerminal({ entry: { ...r.entry, name: r.name, protocol: 'ssh' } });
  }
  function render() {
    const box = $('#recent-list'); if (!box) return; box.innerHTML = '';
    const items = list();
    if (!items.length) { box.append(h('div', { class: 'empty' }, t('recent.empty'))); return; }
    for (const r of items) {
      const hh = r.hostId ? Hosts.byId(r.hostId) : null;
      const sub = r.entry ? `${r.entry.username ? r.entry.username + '@' : ''}${r.entry.host}` : hh ? `${hh.username ? hh.username + '@' : ''}${hh.host}` : '';
      const row = h('div', { class: 'rc', title: sub || r.name, onClick: () => open(r) },
        Icon(r.profileId ? 'terminal' : hh && hh.protocol === 'ftp' ? 'ftp' : 'key', 13),
        h('span', { class: 'n' }, hh ? hh.name : r.name),
        sub ? h('span', { class: 'u' }, sub) : null,
        h('span', { class: 'a' }, UI.fmtAgo(r.at)));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); UI.ctxmenu(e.clientX, e.clientY, [
        { label: t('menu.connect'), onClick: () => open(r) },
        r.entry ? { label: t('recent.saveHost'), onClick: () => Hosts.edit({ protocol: 'ssh', name: r.name, host: r.entry.host, port: r.entry.port, username: r.entry.username, useAgent: false }) } : null,
        '-', { label: t('recent.remove'), onClick: () => remove(r) }, { label: t('recent.clear'), onClick: () => { app.settings.recent = []; window.api.settings.set({ recent: [] }); render(); } }]); });
      box.append(row);
    }
  }
  return { init, add, render };
})();
