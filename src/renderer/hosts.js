'use strict';
// Host sidebar + host editor.
window.Hosts = (() => {
  const { $, h } = UI;
  let app = null;
  let hosts = [];
  let selectedId = null;
  const collapsed = new Set(JSON.parse(localStorage.getItem('terhui.collapsedGroups') || '[]'));
  const KEEP = '__KEEP_SECRET__';
  const COLORS = ['', '#4c9be8', '#7bd88f', '#e5c07b', '#e06c75', '#c678dd', '#56b6c2', '#ff9f43', '#8b95a7'];

  function init(a) {
    app = a;
    $('#host-filter').addEventListener('input', render);
    $('#btn-addhost').addEventListener('click', () => edit(null));
    $('#btn-import-sshconfig').addEventListener('click', async () => {
      try { const r = await window.api.hosts.importSshConfig(); UI.toast(t('hosts.imported', { n: r.added }), 'ok'); await refresh(); } catch (e) { UI.errToast(e); }
    });
    $('#quick-connect').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const v = e.target.value.trim(); if (!v) return;
      const m = v.match(/^(?:([^@]+)@)?([^:\s]+|\[[^\]]+\])(?::(\d+))?$/);
      if (!m) { UI.toast(t('quick.bad'), 'warn'); return; }
      e.target.value = '';
      app.openTerminal({ entry: { name: v, host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? parseInt(m[3], 10) : 22, username: m[1] || '', protocol: 'ssh' } });
    });
    $('#host-list').addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.host'); if (!row) return;
      e.preventDefault(); select(row.dataset.id); menu(e.clientX, e.clientY, byId(row.dataset.id));
    });
  }

  const byId = (id) => hosts.find(x => x.id === id);
  async function refresh() { try { hosts = await window.api.hosts.list(); } catch (_) { hosts = []; } render(); }
  function select(id) { selectedId = id; UI.$$('.host', $('#host-list')).forEach(el => el.classList.toggle('selected', el.dataset.id === id)); }

  function render() {
    const list = $('#host-list'); list.innerHTML = '';
    const q = $('#host-filter').value.trim().toLowerCase();
    const filtered = hosts.filter(hh => !q || [hh.name, hh.host, hh.username, hh.group, hh.notes].join(' ').toLowerCase().includes(q));
    if (!filtered.length) { list.append(h('div', { class: 'empty' }, hosts.length ? '—' : t('hosts.empty'))); return; }
    const groups = new Map();
    for (const hh of filtered) { const g = hh.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(hh); }
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    for (const g of keys) {
      if (g) {
        const gh = h('div', { class: 'host-group' + (collapsed.has(g) && !q ? ' collapsed' : ''), onClick: () => { collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g); localStorage.setItem('terhui.collapsedGroups', JSON.stringify([...collapsed])); render(); } }, g);
        list.append(gh);
        if (collapsed.has(g) && !q) continue;
      }
      for (const hh of groups.get(g).sort((a, b) => a.name.localeCompare(b.name))) {
        const live = app.sessionsForHost(hh.id).length > 0;
        const row = h('div', { class: 'host' + (hh.id === selectedId ? ' selected' : ''), dataset: { id: hh.id }, style: hh.color ? { borderLeftColor: hh.color } : undefined, title: `${hh.username ? hh.username + '@' : ''}${hh.host}:${hh.port}${hh.notes ? '\n' + hh.notes : ''}` },
          h('div', { class: 'h-color', style: hh.color ? { background: hh.color } : undefined }),
          h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'h-name' }, hh.name || hh.host), h('div', { class: 'h-sub' }, `${hh.username ? hh.username + '@' : ''}${hh.host}${hh.port !== (hh.protocol === 'ftp' ? 21 : 22) ? ':' + hh.port : ''}`)),
          hh.protocol === 'ftp' ? h('span', { class: 'h-proto' }, 'FTP') : null,
          live ? h('span', { class: 'h-live' }) : null,
        );
        row.addEventListener('click', () => select(hh.id));
        row.addEventListener('dblclick', () => connect(hh));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(hh); });
        list.append(row);
      }
    }
  }

  function connect(hh) { if (hh.protocol === 'ftp') app.openFiles({ ftpHostId: hh.id }); else app.openTerminal({ hostId: hh.id, entry: hh }); }

  function menu(x, y, hh) {
    if (!hh) return;
    UI.ctxmenu(x, y, [
      { label: t('menu.connect'), onClick: () => connect(hh) },
      { label: t('menu.files'), onClick: () => (hh.protocol === 'ftp' ? app.openFiles({ ftpHostId: hh.id }) : app.openFilesForHost(hh.id)) },
      hh.protocol === 'ssh' ? { label: t('menu.index'), onClick: () => app.buildIndexForHost(hh.id) } : null,
      '-',
      { label: t('menu.edit'), onClick: () => edit(hh) },
      { label: t('menu.duplicate'), onClick: () => edit({ ...hh, id: '', name: hh.name + ' (copy)', hasPassword: false, hasPrivateKey: false, hasPassphrase: false }) },
      { label: t('menu.copyAddr'), onClick: () => { window.api.clipboard.write(`${hh.username ? hh.username + '@' : ''}${hh.host}`); UI.toast(t('copied'), 'ok', 1500); } },
      '-',
      { label: t('menu.delete'), onClick: async () => { if (await UI.confirm(t('host.delete.confirm', { name: hh.name || hh.host }), { danger: true, okLabel: t('delete') })) { await window.api.hosts.remove(hh.id); refresh(); } } },
    ]);
  }

  /** Host editor. entry = public view (secrets shown as "kept") or null for new. */
  function edit(entry) {
    const e = entry || { protocol: 'ssh', port: 22, useAgent: false };
    const isNew = !e.id;
    const f = {};
    const inp = (name, attrs = {}) => { f[name] = h('input', { type: 'text', value: e[name] ?? '', spellcheck: 'false', ...attrs }); return f[name]; };
    const secret = (name, has) => { f[name] = h('input', { type: 'password', value: has ? KEEP : '', placeholder: has ? t('host.secretKept') : '' }); return f[name]; };
    const authSel = h('select', null,
      h('option', { value: 'password' }, t('host.password')), h('option', { value: 'key' }, t('host.key')), h('option', { value: 'agent' }, t('host.agent')));
    authSel.value = e.hasPrivateKey || e.privateKeyPath ? 'key' : (e.useAgent && !e.hasPassword ? 'agent' : 'password');
    f.protocol = h('select', null, h('option', { value: 'ssh' }, 'SSH'), h('option', { value: 'ftp' }, 'FTP'));
    f.protocol.value = e.protocol || 'ssh';
    f.ftpSecure = h('select', null, h('option', { value: 'none' }, t('host.ftpSecure.none')), h('option', { value: 'explicit' }, t('host.ftpSecure.explicit')), h('option', { value: 'implicit' }, t('host.ftpSecure.implicit')));
    f.ftpSecure.value = e.ftpSecure || 'none';
    f.privateKey = h('textarea', { placeholder: e.hasPrivateKey ? t('host.secretKept') : t('host.keypaste'), spellcheck: 'false' }, e.hasPrivateKey ? KEEP : '');
    const keyFileBtn = h('button', { type: 'button', onClick: async () => { const r = await window.api.hosts.readKeyFile(); if (r) { f.privateKey.value = r.content; f.privateKeyPath.value = ''; } } }, t('host.keyfile'));
    f.useAgent = h('input', { type: 'checkbox' }); f.useAgent.checked = !!e.useAgent;
    f.color = h('select', null, ...COLORS.map(c => h('option', { value: c, style: c ? { color: c } : undefined }, c ? '■ ' + c : '—')));
    f.color.value = e.color || '';
    f.notes = h('textarea', { spellcheck: 'false' }, e.notes || '');

    const sshOnly = [], ftpOnly = [], keyOnly = [], pwOnly = [];
    const row = (label, el, opts = {}) => { const l = h('label', null, label); const wrap = el.tagName === 'DIV' ? el : h('div', { class: 'row' }, el); (opts.list || []).forEach(a => a.push(l, wrap)); return [l, wrap]; };
    const form = h('div', { class: 'form' },
      ...row(t('host.name'), inp('name', { autofocus: true })),
      ...row(t('host.group'), inp('group', { list: 'group-list' })),
      ...row(t('host.protocol'), f.protocol),
      ...row(t('host.host'), h('div', { class: 'row' }, inp('host'), h('span', null, ':'), inp('port', { style: { width: '80px', flex: '0 0 auto' } }))),
      ...row(t('host.user'), inp('username')),
      ...row(t('host.auth'), authSel, { list: [sshOnly] }),
      ...row(t('host.password'), secret('password', e.hasPassword)),
      ...row(t('host.key'), h('div', { class: 'row' }, f.privateKey, keyFileBtn), { list: [keyOnly] }),
      ...row(t('host.keypath'), inp('privateKeyPath', { placeholder: '~/.ssh/id_ed25519' }), { list: [keyOnly] }),
      ...row(t('host.passphrase'), secret('passphrase', e.hasPassphrase), { list: [keyOnly] }),
      ...row(t('host.agent'), f.useAgent, { list: [sshOnly] }),
      ...row(t('host.ftpSecure'), f.ftpSecure, { list: [ftpOnly] }),
      ...row(t('host.startDir'), inp('startDir', { placeholder: '~' })),
      ...row(t('host.indexRoot'), inp('indexRoot', { placeholder: '/' }), { list: [sshOnly] }),
      ...row(t('host.localDir'), inp('localDir', { placeholder: '~' })),
      ...row(t('host.color'), f.color),
      ...row(t('host.notes'), f.notes),
    );
    const groupsDl = h('datalist', { id: 'group-list' }, ...[...new Set(hosts.map(x => x.group).filter(Boolean))].map(g => h('option', { value: g })));
    form.append(groupsDl);
    const update = () => {
      const ssh = f.protocol.value === 'ssh';
      sshOnly.forEach(el => el.hidden = !ssh); ftpOnly.forEach(el => el.hidden = ssh);
      const a = authSel.value;
      keyOnly.forEach(el => el.hidden = !ssh || a !== 'key');
      f.password.parentElement.hidden = f.password.parentElement.previousSibling.hidden = ssh && a === 'agent';
      if (!f.port.value || f.port.value === '22' || f.port.value === '21') f.port.value = ssh ? '22' : '21';
    };
    f.protocol.addEventListener('change', update); authSel.addEventListener('change', update); update();

    const ctl = UI.modal({ title: t('host.edit') + (isNew ? '' : ': ' + (e.name || e.host)), body: form, width: '640px', buttons: [
      { label: t('cancel'), value: null },
      { label: t('connect'), onClick: async (c) => { const saved = await save(); if (!saved) return UI.KEEP_OPEN; connect(saved); return saved; } },
      { label: t('save'), primary: true, onClick: async () => { const saved = await save(); return saved ? saved : UI.KEEP_OPEN; } },
    ] });
    async function save() {
      const ssh = f.protocol.value === 'ssh'; const a = authSel.value;
      if (!f.host.value.trim() || (ssh && !f.username.value.trim())) { UI.toast(t('host.required'), 'warn'); return null; }
      const out = {
        id: e.id || '', name: f.name.value.trim() || f.host.value.trim(), group: f.group.value, protocol: f.protocol.value, host: f.host.value, port: f.port.value, username: f.username.value,
        password: (ssh && a === 'agent') ? '' : f.password.value,
        privateKey: (ssh && a === 'key') ? f.privateKey.value : '', privateKeyPath: (ssh && a === 'key') ? f.privateKeyPath.value : '', passphrase: (ssh && a === 'key') ? f.passphrase.value : '',
        useAgent: ssh && (a === 'agent' || f.useAgent.checked), ftpSecure: f.ftpSecure.value, startDir: f.startDir.value, indexRoot: f.indexRoot.value, localDir: f.localDir.value, color: f.color.value, notes: f.notes.value,
      };
      try { const saved = await window.api.hosts.save(out); await refresh(); select(saved.id); return saved; } catch (err) { UI.errToast(err); return null; }
    }
    return ctl.promise;
  }

  return { init, refresh, edit, render, byId, get list() { return hosts; }, get selectedId() { return selectedId; }, connectSelected: () => { const hh = byId(selectedId); if (hh) connect(hh); } };
})();
