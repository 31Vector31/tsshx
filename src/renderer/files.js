'use strict';
// Dual-pane file manager (local / SFTP / FTP) with transfers.
window.Files = (() => {
  const { $, $$, h } = UI;
  let app = null;
  const panes = [];
  let activePane = 0;
  const ftpConns = new Map(); // fsId -> {hostId, label, home}
  let showHidden = localStorage.getItem('terhui.showHidden') === '1';

  const isRemote = (fsId) => fsId !== 'local';
  const posixJoin = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
  const joinFor = (fsId, a, b) => (fsId === 'local' && app.platform === 'win32') ? (a.endsWith('\\') ? a + b : a + '\\' + b) : posixJoin(a, b);
  const parentOf = (fsId, p) => {
    if (fsId === 'local' && app.platform === 'win32') { const i = p.replace(/[\\/]+$/, '').lastIndexOf('\\'); return i <= 2 ? p.slice(0, 3) : p.slice(0, i); }
    if (p === '/' ) return '/';
    const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i);
  };

  class Pane {
    constructor(idx, el) {
      this.idx = idx; this.el = el; this.fsId = 'local'; this.label = t('files.local'); this.path = ''; this.items = []; this.selected = new Set(); this.cursor = 0;
      this.sort = { key: 'name', dir: 1 }; this.follow = false; this.loading = false; this.filter = '';
      this._build();
    }
    _build() {
      this.srcSel = h('select', { onChange: () => this.setSource(this.srcSel.value) });
      this.pathInput = h('input', { class: 'pane-path', type: 'text', spellcheck: 'false', onKeydown: (e) => { if (e.key === 'Enter') this.load(this.pathInput.value.trim()); if (e.key === 'Escape') { this.pathInput.value = this.path; this.list.focus(); } } });
      const tb = (icon, title, fn) => h('button', { class: 'icon-btn', title, onClick: fn }, Icon(icon));
      const sep = () => h('span', { class: 'sep' });
      this.btnFollow = tb('link', t('files.follow'), () => { this.follow = !this.follow; this.btnFollow.classList.toggle('on', this.follow); if (this.follow) { const tab = app.activeTab(); if (tab && tab.cwd) this.load(tab.cwd); } });
      this.btnCd = tb('terminal', t('files.cdTerm'), () => { const tab = app.activeTab(); if (tab && this.fsId === 'sftp:' + tab.sessionId) tab.cd(this.path); });
      this.btnHidden = tb('eye', t('files.hidden') + ' (Ctrl+H)', () => { showHidden = !showHidden; localStorage.setItem('terhui.showHidden', showHidden ? '1' : '0'); panes.forEach(p => { p.btnHidden.classList.toggle('on', showHidden); p.render(); }); });
      this.btnHidden.classList.toggle('on', showHidden);
      this.tools = h('div', { class: 'pane-tools' },
        tb('up', t('files.up') + ' (Backspace)', () => this.up()), tb('home', t('files.home'), () => this.home()), tb('refresh', t('files.refresh') + ' (F2)', () => this.load(this.path)), this.btnHidden,
        sep(), tb('folderPlus', t('files.mkdir') + ' (F7)', () => this.mkdir()), tb('filePlus', t('files.newfile'), () => this.newFile()),
        tb('edit', t('files.rename') + ' (F6)', () => this.rename()), tb('trash', t('files.delete') + ' (F8)', () => this.remove()), tb('shield', t('files.chmod'), () => this.chmod()),
        sep(), tb(this.idx === 0 ? 'arrowDown' : 'arrowUp', t('files.copyTo') + ' (F5)', () => this.copyToOther()),
        sep(), this.btnFollow, this.btnCd,
      );
      this.list = h('div', { class: 'pane-list', tabindex: '0' });
      this.status = h('div', { class: 'pane-status' });
      this.el.append(h('div', { class: 'pane-bar' }, this.srcSel, this.pathInput), this.tools, this.list, this.status);
      this.list.addEventListener('keydown', (e) => this._key(e));
      this.list.addEventListener('mousedown', () => setActive(this.idx));
      this.list.addEventListener('contextmenu', (e) => { e.preventDefault(); const tr = e.target.closest('tr[data-i]'); if (tr) { const i = +tr.dataset.i; if (!this.selected.has(this.visible[i].name)) { this.selected.clear(); this.selected.add(this.visible[i].name); } this.cursor = i; this.render(); } this.menu(e.clientX, e.clientY); });
      this.list.addEventListener('dblclick', (e) => { const tr = e.target.closest('tr[data-i]'); if (tr) this.activate(this.visible[+tr.dataset.i]); });
      this.list.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-i]'); if (!tr) { this.selected.clear(); this.render(); return; }
        const i = +tr.dataset.i; const it = this.visible[i];
        if (e.ctrlKey || e.metaKey) { this.selected.has(it.name) ? this.selected.delete(it.name) : this.selected.add(it.name); }
        else if (e.shiftKey) { const a = Math.min(this.cursor, i), b = Math.max(this.cursor, i); for (let k = a; k <= b; k++) this.selected.add(this.visible[k].name); }
        else { this.selected.clear(); this.selected.add(it.name); }
        this.cursor = i; this.render();
      });
      // drag & drop between panes / from OS
      this.list.addEventListener('dragstart', (e) => { const tr = e.target.closest('tr[data-i]'); if (!tr) return; const it = this.visible[+tr.dataset.i]; if (!this.selected.has(it.name)) { this.selected.clear(); this.selected.add(it.name); this.render(); } e.dataTransfer.setData('application/x-terhui', JSON.stringify({ pane: this.idx })); e.dataTransfer.effectAllowed = 'copy'; });
      this.list.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      this.list.addEventListener('drop', (e) => {
        e.preventDefault();
        const internal = e.dataTransfer.getData('application/x-terhui');
        if (internal) { const { pane } = JSON.parse(internal); if (pane !== this.idx) panes[pane].copyToOther(); return; }
        const paths = [...e.dataTransfer.files].map(f => window.api.pathForFile ? window.api.pathForFile(f) : null).filter(Boolean);
        if (paths.length) this.copyFromLocalPaths(paths);
      });
    }

    sources() {
      const list = [{ id: 'local', label: t('files.local') }];
      for (const tab of app.tabs) if (tab.sessionId && tab.status === 'connected') list.push({ id: 'sftp:' + tab.sessionId, label: 'SFTP ' + tab.title });
      for (const [id, c] of ftpConns) list.push({ id, label: 'FTP ' + c.label });
      return list;
    }
    refreshSources() {
      const cur = this.srcSel.value || this.fsId;
      this.srcSel.innerHTML = '';
      const srcs = this.sources();
      for (const s of srcs) this.srcSel.append(h('option', { value: s.id }, s.label));
      if (!srcs.some(s => s.id === this.fsId)) {
        if (this.fsId !== 'local') { this.items = []; this.selected.clear(); this.render(t('files.noremote')); }
      }
      this.srcSel.value = srcs.some(s => s.id === cur) ? cur : this.fsId;
      this.btnFollow.hidden = this.btnCd.hidden = !this.fsId.startsWith('sftp:');
    }
    async setSource(fsId, startPath) {
      this.fsId = fsId; this.srcSel.value = fsId; this.label = (this.sources().find(s => s.id === fsId) || {}).label || fsId;
      this.btnFollow.hidden = this.btnCd.hidden = !fsId.startsWith('sftp:');
      this.selected.clear();
      let p = startPath;
      if (!p) {
        if (fsId === 'local') p = app.settings.localDir || app.home;
        else if (fsId.startsWith('sftp:')) { const tab = app.tabs.find(x => 'sftp:' + x.sessionId === fsId); const hh = tab && tab.hostId ? Hosts.byId(tab.hostId) : null; p = (hh && hh.startDir) || (tab && tab.cwd) || null; if (!p) { try { p = await window.api.fs.home(fsId); } catch (e) { UI.errToast(e); p = '/'; } } }
        else { const c = ftpConns.get(fsId); p = (c && c.home) || '/'; }
      }
      await this.load(p);
    }
    async load(p) {
      if (!p) return;
      if (p.startsWith('~')) { try { const hm = await window.api.fs.home(this.fsId); p = hm + p.slice(1); } catch (_) {} }
      this.loading = true; this.status.textContent = '…';
      try {
        const r = await window.api.fs.list(this.fsId, p);
        const changed = r.path !== this.path;
        this.path = r.path; this.items = r.items; this.pathInput.value = r.path;
        if (changed) { this.selected.clear(); this.cursor = 0; this.filter = ''; }
        this.render();
      } catch (err) { UI.errToast(err); this.status.textContent = (err.message || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
      this.loading = false;
    }
    sortItems(items) {
      const { key, dir } = this.sort;
      const isDir = (x) => x.type === 'd' || (x.type === 'l' && x.targetType === 'd');
      return items.slice().sort((a, b) => {
        const da = isDir(a), db = isDir(b); if (da !== db) return da ? -1 : 1;
        let c = 0;
        if (key === 'size') c = a.size - b.size; else if (key === 'mtime') c = a.mtime - b.mtime;
        if (!c) c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        return c * dir;
      });
    }
    render(msg) {
      let items = this.items.filter(x => showHidden || !x.name.startsWith('.'));
      if (this.filter) items = items.filter(x => x.name.toLowerCase().includes(this.filter.toLowerCase()));
      this.visible = this.sortItems(items);
      for (const n of [...this.selected]) if (!this.visible.some(x => x.name === n)) this.selected.delete(n);
      this.cursor = Math.max(0, Math.min(this.cursor, this.visible.length - 1));
      const th = (key, label, cls) => h('th', { class: cls || '', onClick: () => { this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : 1 }; this.render(); } }, label + (this.sort.key === key ? (this.sort.dir > 0 ? ' ▴' : ' ▾') : ''));
      const tbody = h('tbody');
      this.visible.forEach((it, i) => {
        const dir = it.type === 'd' || (it.type === 'l' && it.targetType === 'd');
        const icon = h('span', { class: 'ic' }, Icon(dir ? 'folder' : it.type === 'l' ? 'link' : 'file', 14));
        const tr = h('tr', { class: (dir ? 'dir' : '') + (it.type === 'l' ? ' link' : '') + (this.selected.has(it.name) ? ' selected' : '') + (i === this.cursor ? ' cursor' : '') + (it.name.startsWith('.') ? ' hiddenf' : ''), dataset: { i }, draggable: 'true', title: it.linkTarget ? '→ ' + it.linkTarget : it.path },
          h('td', null, icon, h('span', { class: 'name' }, it.name)),
          h('td', { class: 'c-size' }, dir ? '' : UI.fmtSize(it.size)),
          h('td', { class: 'c-date' }, UI.fmtDate(it.mtime)),
          h('td', { class: 'c-perm' }, it.modeStr || ''));
        tbody.append(tr);
      });
      const table = h('table', null, h('thead', null, h('tr', null, th('name', t('files.name')), th('size', t('files.size'), 'c-size'), th('mtime', t('files.modified'), 'c-date'), h('th', { class: 'c-perm' }, t('files.mode')))), tbody);
      this.list.innerHTML = ''; this.list.append(table);
      if (msg) this.list.append(h('div', { class: 'empty' }, msg));
      const cur = tbody.children[this.cursor]; if (cur) cur.scrollIntoView({ block: 'nearest' });
      const selSize = this.visible.filter(x => this.selected.has(x.name)).reduce((a, x) => a + (x.size || 0), 0);
      this.status.innerHTML = '';
      this.status.append(h('span', null, t('files.items', { n: this.visible.length })), this.selected.size ? h('span', null, t('files.selected', { n: this.selected.size }) + ' · ' + UI.fmtSize(selSize)) : '', this.filter ? h('span', null, 'filter: ' + this.filter) : '');
    }
    selection() { const s = this.visible.filter(x => this.selected.has(x.name)); return s.length ? s : (this.visible[this.cursor] ? [this.visible[this.cursor]] : []); }
    _key(e) {
      const n = this.visible.length;
      const move = (to, extend) => { const from = this.cursor; this.cursor = Math.max(0, Math.min(n - 1, to)); if (extend) { const a = Math.min(from, this.cursor), b = Math.max(from, this.cursor); for (let k = a; k <= b; k++) this.selected.add(this.visible[k].name); } else if (!e.ctrlKey) { this.selected.clear(); } this.render(); };
      const pageN = Math.max(1, Math.floor(this.list.clientHeight / 22) - 1);
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); move(this.cursor + 1, e.shiftKey); break;
        case 'ArrowUp': e.preventDefault(); move(this.cursor - 1, e.shiftKey); break;
        case 'PageDown': e.preventDefault(); move(this.cursor + pageN, e.shiftKey); break;
        case 'PageUp': e.preventDefault(); move(this.cursor - pageN, e.shiftKey); break;
        case 'Home': e.preventDefault(); move(0, e.shiftKey); break;
        case 'End': e.preventDefault(); move(n - 1, e.shiftKey); break;
        case 'Enter': e.preventDefault(); if (this.visible[this.cursor]) this.activate(this.visible[this.cursor]); break;
        case 'Backspace': e.preventDefault(); if (this.filter) { this.filter = this.filter.slice(0, -1); this.render(); } else this.up(); break;
        case ' ': e.preventDefault(); { const it = this.visible[this.cursor]; if (it) { this.selected.has(it.name) ? this.selected.delete(it.name) : this.selected.add(it.name); } move(this.cursor + 1, false); if (it) this.selected.has(it.name) || this.selected.add(it.name); this.render(); } break;
        case 'F5': e.preventDefault(); this.copyToOther(); break;
        case 'F6': e.preventDefault(); this.rename(); break;
        case 'F7': e.preventDefault(); this.mkdir(); break;
        case 'F8': case 'Delete': e.preventDefault(); this.remove(); break;
        case 'F2': e.preventDefault(); this.load(this.path); break;
        case 'F3': case 'F4': e.preventDefault(); { const it = this.visible[this.cursor]; if (it && it.type !== 'd') this.openFile(it); } break;
        case 'Tab': e.preventDefault(); setActive(1 - this.idx); panes[1 - this.idx].list.focus(); break;
        case 'Escape': if (this.filter) { this.filter = ''; this.render(); } else { this.selected.clear(); this.render(); } break;
        default:
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.visible.forEach(x => this.selected.add(x.name)); this.render(); }
          else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); this.pathInput.focus(); this.pathInput.select(); }
          else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); this.load(this.path); }
          else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') { e.preventDefault(); this.btnHidden.click(); }
          else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) { this.filter += e.key; this.cursor = 0; this.render(); }
      }
    }
    async activate(it) {
      const dir = it.type === 'd' || (it.type === 'l' && it.targetType === 'd');
      if (dir) return this.load(it.path);
      return this.openFile(it);
    }
    async openFile(it) {
      if (this.fsId === 'local') { window.api.fs.openLocal(it.path); return; }
      return editFile(this.fsId, it.path, () => this.load(this.path));
    }
    up() { this.load(parentOf(this.fsId, this.path)); }
    async home() { try { this.load(await window.api.fs.home(this.fsId)); } catch (e) { UI.errToast(e); } }
    async mkdir() { const name = await UI.prompt(t('files.mkdir.prompt')); if (!name) return; try { await window.api.fs.mkdir(this.fsId, joinFor(this.fsId, this.path, name)); await this.load(this.path); this.select(name); } catch (e) { UI.errToast(e); } }
    async newFile() { const name = await UI.prompt(t('files.newfile.prompt')); if (!name) return; try { await window.api.fs.writeFile(this.fsId, joinFor(this.fsId, this.path, name), ''); await this.load(this.path); this.select(name); } catch (e) { UI.errToast(e); } }
    select(name) { this.selected.clear(); this.selected.add(name); const i = this.visible.findIndex(x => x.name === name); if (i >= 0) this.cursor = i; this.render(); }
    async rename() {
      const it = this.selection()[0]; if (!it) return;
      const name = await UI.prompt(t('files.rename.prompt'), { value: it.name }); if (!name || name === it.name) return;
      try { await window.api.fs.rename(this.fsId, it.path, joinFor(this.fsId, this.path, name)); await this.load(this.path); this.select(name); } catch (e) { UI.errToast(e); }
    }
    async remove() {
      const sel = this.selection(); if (!sel.length) return;
      if (!await UI.confirm(t('files.delete.confirm', { n: sel.length }), { danger: true, okLabel: t('delete'), detail: sel.slice(0, 8).map(x => x.path).join('\n') + (sel.length > 8 ? '\n…' : '') })) return;
      for (const it of sel) { try { await window.api.fs.delete(this.fsId, it.path, it.type === 'd'); } catch (e) { UI.errToast(e); } }
      this.selected.clear(); await this.load(this.path);
    }
    async chmod() {
      const sel = this.selection(); if (!sel.length) return;
      const cur = (sel[0].mode || 0).toString(8).padStart(3, '0');
      const v = await UI.prompt(t('files.chmod.prompt'), { value: cur, mono: true }); if (!v) return;
      if (!/^[0-7]{3,4}$/.test(v)) { UI.toast(t('files.chmod.prompt'), 'warn'); return; }
      for (const it of sel) { try { await window.api.fs.chmod(this.fsId, it.path, parseInt(v, 8)); } catch (e) { UI.errToast(e); } }
      await this.load(this.path);
    }
    async copyToOther() {
      const other = panes[1 - this.idx]; const sel = this.selection(); if (!sel.length || !other.path) return;
      if (other.fsId === this.fsId && other.path === this.path) return;
      for (const it of sel) startTransfer({ fsId: this.fsId, path: it.path }, { fsId: other.fsId, path: joinFor(other.fsId, other.path, it.name) }, this.label, other.label, () => other.load(other.path));
    }
    async copyFromLocalPaths(paths) {
      for (const p of paths) { const name = p.split(/[\\/]/).pop(); startTransfer({ fsId: 'local', path: p }, { fsId: this.fsId, path: joinFor(this.fsId, this.path, name) }, t('files.local'), this.label, () => this.load(this.path)); }
    }
    async download() {
      const sel = this.selection(); if (!sel.length) return;
      const dirs = await window.api.dialog.open({ properties: ['openDirectory', 'createDirectory'], title: t('files.download') }); if (!dirs) return;
      for (const it of sel) startTransfer({ fsId: this.fsId, path: it.path }, { fsId: 'local', path: joinFor('local', dirs[0], it.name) }, this.label, t('files.local'));
    }
    async upload(dirMode) {
      const files = await window.api.dialog.open({ properties: dirMode ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections', 'showHiddenFiles'], title: t('files.upload') }); if (!files) return;
      this.copyFromLocalPaths(files);
    }
    menu(x, y) {
      const sel = this.selection(); const one = sel.length === 1 ? sel[0] : null; const local = this.fsId === 'local';
      const tab = app.activeTab(); const isTabSftp = tab && this.fsId === 'sftp:' + tab.sessionId;
      UI.ctxmenu(x, y, [
        one ? { label: t('files.view'), kbd: 'Enter', onClick: () => this.activate(one) } : null,
        one && one.type !== 'd' ? { label: local ? 'Edit' : t('files.view'), kbd: 'F4', onClick: () => editFile(this.fsId, one.path, () => this.load(this.path)) } : null,
        isTabSftp && one ? { label: t('files.cdTerm'), onClick: () => tab.cd(one.type === 'd' ? one.path : this.path) } : null,
        { label: t('files.copyTo') + ' ' + panes[1 - this.idx].label, kbd: 'F5', onClick: () => this.copyToOther(), disabled: !sel.length },
        !local ? { label: t('files.download'), onClick: () => this.download(), disabled: !sel.length } : null,
        !local ? { label: t('files.upload'), onClick: () => this.upload(false) } : null,
        !local ? { label: t('files.uploadDir'), onClick: () => this.upload(true) } : null,
        '-',
        { label: t('files.mkdir'), kbd: 'F7', onClick: () => this.mkdir() },
        { label: t('files.newfile'), onClick: () => this.newFile() },
        { label: t('files.rename'), kbd: 'F6', onClick: () => this.rename(), disabled: !one },
        { label: t('files.chmod'), onClick: () => this.chmod(), disabled: !sel.length || this.fsId.startsWith('ftp:') },
        { label: t('files.delete'), kbd: 'F8', onClick: () => this.remove(), disabled: !sel.length },
        '-',
        { label: t('files.copyPath'), onClick: () => { window.api.clipboard.write(sel.map(s => s.path).join('\n') || this.path); UI.toast(t('copied'), 'ok', 1500); } },
        local && one ? { label: t('files.showLocal'), onClick: () => window.api.fs.showLocal(one.path) } : null,
        { label: t('files.refresh'), kbd: 'F2', onClick: () => this.load(this.path) },
      ]);
    }
  }

  // ---- text editor / viewer ----
  async function editFile(fsId, path, onSaved) {
    let r;
    try { r = await window.api.fs.readFile(fsId, path, 2 * 1024 * 1024); } catch (e) { UI.errToast(e); return; }
    const ta = h('textarea', { spellcheck: 'false' }, r.text);
    const ro = r.binary || r.truncated; if (ro) ta.readOnly = true;
    const note = r.binary ? t('files.binary') : r.truncated ? t('files.truncated', { n: r.text.length }) : '';
    const body = h('div', { class: 'editor' }, note ? h('div', { class: 'warn', style: { marginBottom: '6px' } }, note) : null, ta);
    const ctl = UI.modal({ title: path, body, closeOnBack: false, buttons: [
      { label: t('close'), value: null },
      ro ? null : { label: t('save'), primary: true, onClick: async () => { try { await window.api.fs.writeFile(fsId, path, ta.value); UI.toast(t('saved'), 'ok', 1500); onSaved && onSaved(); return true; } catch (e) { UI.errToast(e); return UI.KEEP_OPEN; } } },
    ].filter(Boolean), onKey: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (!ro) ctl.el.querySelector('.modal-foot .primary').click(); return true; } if (e.key === 'Tab' && e.target === ta) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('\t', s, ta.selectionEnd, 'end'); return true; } return false; } });
    setTimeout(() => ta.focus(), 0);
    return ctl.promise;
  }

  // ---- transfers ----
  const xfers = new Map();
  const xferCallbacks = new Map();
  async function startTransfer(src, dst, srcLabel, dstLabel, onDone) {
    try { const id = await window.api.xfer.start({ src, dst, srcLabel, dstLabel }); if (onDone) xferCallbacks.set(id, onDone); } catch (e) { UI.errToast(e); }
  }
  function onProgress(v) {
    xfers.set(v.id, v); renderTransfers();
    if (v.status === 'done' || v.status === 'error' || v.status === 'cancelled') {
      const cb = xferCallbacks.get(v.id); if (cb) { xferCallbacks.delete(v.id); cb(); }
      if (v.status === 'error') UI.toast(`${v.srcPath}: ${v.error}`, 'error', 6000);
    }
  }
  function renderTransfers() {
    const box = $('#transfer-list'); box.innerHTML = '';
    const list = [...xfers.values()].sort((a, b) => b.id - a.id);
    $('#transfers').dataset.empty = list.length ? '0' : '1';
    let running = 0;
    for (const v of list) {
      if (v.status === 'running' || v.status === 'queued') running++;
      const pct = v.bytesTotal ? Math.min(100, v.bytesDone / v.bytesTotal * 100) : (v.status === 'done' ? 100 : 0);
      const el = h('div', { class: 'xfer ' + v.status },
        h('div', { class: 'row' }, h('span', { class: 'path', title: v.srcPath + ' → ' + v.dstPath }, `${v.srcPath.split('/').pop()} → ${v.dstLabel || ''}`),
          h('span', { class: 'meta' }, `${UI.fmtSize(v.bytesDone)}${v.bytesTotal ? ' / ' + UI.fmtSize(v.bytesTotal) : ''}  ${v.filesDone}/${v.filesTotal}  ${t('xfer.' + v.status)}${v.error ? ': ' + v.error : ''}`),
          (v.status === 'running' || v.status === 'queued') ? h('button', { class: 'icon-btn', title: t('cancel'), onClick: () => window.api.xfer.cancel(v.id) }, Icon('close', 12)) : null),
        h('div', { class: 'bar' }, h('div', { style: { width: pct + '%' } })));
      box.append(el);
    }
    $('#st-xfer').textContent = running ? `⇅ ${running}` : '';
  }

  function setActive(i) { activePane = i; panes.forEach(p => p.el.classList.toggle('active', p.idx === i)); }

  // ---- public ----
  function init(a) {
    app = a;
    $$('#panes .pane').forEach((el, i) => panes.push(new Pane(i, el)));
    setActive(1);
    $('#btn-files-close').addEventListener('click', hide);
    $('#btn-files-swap').addEventListener('click', () => { const [a0, a1] = panes; const s0 = { fsId: a0.fsId, path: a0.path }, s1 = { fsId: a1.fsId, path: a1.path }; a0.setSource(s1.fsId, s1.path); a1.setSource(s0.fsId, s0.path); });
    $('#btn-xfer-clear').addEventListener('click', async () => { await window.api.xfer.clear(); for (const [id, v] of xfers) if (v.status !== 'running' && v.status !== 'queued') xfers.delete(id); renderTransfers(); });
    window.api.on('xfer:progress', onProgress);
    renderTransfers();
  }
  const visible = () => !$('#files').hidden;
  function show() { $('#files').hidden = false; $('#files-resizer').hidden = false; refreshSources(); if (!panes[0].path) panes[0].setSource('local'); app.settings.filePanelOpen = true; window.api.settings.set({ filePanelOpen: true }); app.fitActive(); }
  function hide() { $('#files').hidden = true; $('#files-resizer').hidden = true; app.settings.filePanelOpen = false; window.api.settings.set({ filePanelOpen: false }); app.fitActive(); app.focusTerminal(); }
  function toggle() { visible() ? hide() : show(); }
  function refreshSources() { panes.forEach(p => p.refreshSources()); }
  /** Open remote pane for a session (optionally at a path). */
  async function openFor({ sessionId, path, ftpHostId }) {
    show();
    if (ftpHostId) {
      try { const r = await window.api.fs.ftpConnect(ftpHostId); const hh = Hosts.byId(ftpHostId); ftpConns.set(r.fsId, { hostId: ftpHostId, label: hh ? hh.name : ftpHostId, home: r.home }); refreshSources(); await panes[1].setSource(r.fsId, (hh && hh.startDir) || r.home); }
      catch (e) { UI.errToast(e); }
      return;
    }
    if (sessionId) { const fsId = 'sftp:' + sessionId; if (panes[1].fsId !== fsId || path) await panes[1].setSource(fsId, path); }
    panes[1].list.focus(); setActive(1);
  }
  function onCwd(tab, path) { for (const p of panes) if (p.follow && p.fsId === 'sftp:' + tab.sessionId && visible()) p.load(path); }
  function onSessionsChanged() { refreshSources(); }
  function focus() { panes[activePane].list.focus(); }
  return { init, show, hide, toggle, openFor, onCwd, onSessionsChanged, refreshSources, visible, focus, editFile, get panes() { return panes; } };
})();
