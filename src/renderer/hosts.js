'use strict';
// Host sidebar + host editor.
window.Hosts = (() => {
  const { $, h } = UI;
  let app = null;
  let hosts = [];
  let selectedId = null;
  const collapsed = new Set(JSON.parse(localStorage.getItem('terhui.collapsedGroups') || '[]'));
  const KEEP = '__KEEP_SECRET__';
  const COLORS = ['', '#4f8cc9', '#6aa66a', '#c9a44f', '#c9605f', '#9b7fc4', '#4fa3a8', '#c98a4f', '#8a8f99'];
  /** Row of colour swatches with a `.value` property (native <select> option colours are not rendered on macOS). */
  function colorPicker(initial) {
    const box = h('div', { class: 'swatch-row' });
    box.value = initial || '';
    const render = () => { box.innerHTML = ''; for (const c of COLORS) box.append(h('button', { type: 'button', class: 'sw' + (c === box.value ? ' on' : '') + (c ? '' : ' none'), title: c || '—', style: c ? { background: c } : undefined, onClick: () => { box.value = c; render(); } }, c ? '' : '×')); };
    render();
    return box;
  }

  function init(a) {
    app = a;
    $('#host-filter').addEventListener('input', render);
    $('#btn-addhost').addEventListener('click', () => edit(null));
    Hosts.importSshConfig = async () => { try { const r = await window.api.hosts.importSshConfig(); UI.toast(t('hosts.imported', { n: r.added }), 'ok'); await refresh(); } catch (e) { UI.errToast(e); } };
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
    renderLocal(list, q);
    if (!filtered.length) { list.append(h('div', { class: 'empty' }, hosts.length ? '—' : t('hosts.empty'))); return; }
    const groups = new Map();
    for (const hh of filtered) { const g = hh.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(hh); }
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    for (const g of keys) {
      if (g) {
        const gh = h('div', { class: 'host-group', onClick: () => { collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g); localStorage.setItem('terhui.collapsedGroups', JSON.stringify([...collapsed])); render(); } }, Icon(collapsed.has(g) && !q ? 'chevronRight' : 'chevronDown', 12), g);
        list.append(gh);
        if (collapsed.has(g) && !q) continue;
      }
      for (const hh of groups.get(g).sort((a, b) => a.name.localeCompare(b.name))) {
        const live = app.sessionsForHost(hh.id).length > 0;
        const row = h('div', { class: 'host' + (hh.id === selectedId ? ' selected' : '') + (g ? '' : ' nogroup'), dataset: { id: hh.id }, title: `${hh.username ? hh.username + '@' : ''}${hh.host}:${hh.port}${hh.notes ? '\n' + hh.notes : ''}` },
          hh.color ? h('span', { class: 'h-color', style: { background: hh.color } }) : null,
          h('span', { class: 'h-name' }, hh.name || hh.host),
          hh.protocol === 'ftp' ? h('span', { class: 'h-proto' }, 'ftp') : null,
          h('span', { class: 'h-sub' }, `${hh.username ? hh.username + '@' : ''}${hh.host}${hh.port !== (hh.protocol === 'ftp' ? 21 : 22) ? ':' + hh.port : ''}`),
          live ? h('span', { class: 'h-live', title: 'connected' }, '●') : null,
        );
        row.addEventListener('click', () => select(hh.id));
        row.addEventListener('dblclick', () => connect(hh));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(hh); });
        list.append(row);
      }
    }
  }

  // ---- local shells ----
  function renderLocal(list, q) {
    const profiles = (app.profiles || []).filter(p => !q || (p.name + ' ' + p.command).toLowerCase().includes(q));
    if (!profiles.length) return;
    const gh = h('div', { class: 'host-group', onClick: () => { collapsed.has('__local') ? collapsed.delete('__local') : collapsed.add('__local'); localStorage.setItem('terhui.collapsedGroups', JSON.stringify([...collapsed])); render(); } }, Icon(collapsed.has('__local') && !q ? 'chevronRight' : 'chevronDown', 12), t('local.title'));
    gh.addEventListener('contextmenu', (e) => { e.preventDefault(); UI.ctxmenu(e.clientX, e.clientY, [{ label: t('local.add'), onClick: () => editProfile(null) }, { label: t('local.redetect'), onClick: redetect }]); });
    list.append(gh);
    if (collapsed.has('__local') && !q) return;
    for (const p of profiles) {
      const live = app.panes().some(x => x.local && x.profile.id === p.id && x.status === 'connected');
      const row = h('div', { class: 'host local', dataset: { pid: p.id }, title: [p.command, ...(p.args || [])].join(' ') },
        p.color ? h('span', { class: 'h-color', style: { background: p.color } }) : null,
        h('span', { class: 'h-name' }, p.name),
        h('span', { class: 'h-sub' }, p.kind === 'pwsh' ? 'pwsh' : p.kind === 'cmd' ? 'cmd' : 'sh'),
        live ? h('span', { class: 'h-live', title: 'running' }, '●') : null);
      row.addEventListener('click', () => { selectedId = 'local:' + p.id; UI.$$('.host', $('#host-list')).forEach(el => el.classList.toggle('selected', el.dataset.pid === p.id)); });
      row.addEventListener('dblclick', () => app.openTerminal({ profile: p }));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); UI.ctxmenu(e.clientX, e.clientY, [
        { label: t('menu.open'), onClick: () => app.openTerminal({ profile: p }) },
        { label: t('pane.splitRight'), onClick: () => { const from = app.activeTab(); if (from) app.openTerminal({ profile: p, from, dir: 'h' }); else app.openTerminal({ profile: p }); } },
        '-', { label: t('menu.edit'), onClick: () => editProfile(p) },
        { label: t('menu.duplicate'), onClick: () => editProfile({ ...p, id: '', name: p.name + ' (copy)' }) },
        { label: t('local.add'), onClick: () => editProfile(null) }, { label: t('local.redetect'), onClick: redetect },
        '-', { label: t('menu.delete'), onClick: async () => { if (await UI.confirm(t('host.delete.confirm', { name: p.name }), { danger: true, okLabel: t('delete') })) { app.profiles = await window.api.profiles.save(app.profiles.filter(x => x.id !== p.id)); render(); } } }]); });
      list.append(row);
    }
  }
  async function redetect() { const found = await window.api.profiles.detect(); const known = new Set(app.profiles.map(p => p.command + JSON.stringify(p.args || []))); const fresh = found.filter(p => !known.has(p.command + JSON.stringify(p.args || []))); app.profiles = await window.api.profiles.save([...app.profiles, ...fresh.map(p => ({ ...p, id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }))]); UI.toast(t('hosts.imported', { n: fresh.length }), 'ok'); render(); }
  function editProfile(p) {
    const e = p || { name: '', command: '', args: [], cwd: '', kind: 'posix', color: '' };
    const f = {};
    const inp = (k, v, attrs = {}) => { f[k] = h('input', { type: 'text', value: v, spellcheck: 'false', ...attrs }); return f[k]; };
    f.kind = h('select', null, h('option', { value: 'posix' }, 'bash / zsh / fish (POSIX)'), h('option', { value: 'pwsh' }, 'PowerShell'), h('option', { value: 'cmd' }, 'cmd')); f.kind.value = e.kind || 'posix';
    f.color = colorPicker(e.color || '');
    const form = h('div', { class: 'form' },
      h('label', null, t('host.name')), inp('name', e.name, { autofocus: true }),
      h('label', null, t('local.command')), inp('command', e.command, { placeholder: process_hint() }),
      h('label', null, t('local.args')), inp('args', (e.args || []).join(' ')),
      h('label', null, t('local.cwd')), inp('cwd', e.cwd || '', { placeholder: '~' }),
      h('label', null, t('local.kind')), f.kind,
      h('label', null, 'WSL distro'), inp('wsl', e.wsl || '', { placeholder: 'Ubuntu (for wsl.exe profiles: enables the distro file browser)' }),
      h('label', null, t('host.color')), f.color);
    UI.modal({ title: t('local.edit'), body: form, width: '520px', buttons: [{ label: t('cancel'), value: null }, { label: t('save'), primary: true, onClick: async () => {
      if (!f.command.value.trim()) { UI.toast(t('host.required'), 'warn'); return UI.KEEP_OPEN; }
      const out = { ...e, id: e.id || 'local-' + Date.now(), name: f.name.value.trim() || f.command.value.trim(), command: f.command.value.trim(), args: f.args.value.trim() ? f.args.value.trim().split(/\s+/) : [], cwd: f.cwd.value.trim(), kind: f.kind.value, wsl: f.wsl.value.trim(), color: f.color.value };
      const list = app.profiles.slice(); const i = list.findIndex(x => x.id === out.id); if (i >= 0) list[i] = out; else list.push(out);
      app.profiles = await window.api.profiles.save(list); render(); return true;
    } }] });
  }
  const process_hint = () => (app.platform === 'win32' ? 'pwsh.exe / cmd.exe / wsl.exe' : '/bin/zsh');

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
    f.color = colorPicker(e.color || '');
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

  return { init, refresh, edit, render, byId, editProfile, get list() { return hosts; }, get selectedId() { return selectedId; }, connectSelected: () => { if (String(selectedId).startsWith('local:')) { const p = (app.profiles || []).find(x => 'local:' + x.id === selectedId); if (p) app.openTerminal({ profile: p }); return; } const hh = byId(selectedId); if (hh) connect(hh); } };
})();
