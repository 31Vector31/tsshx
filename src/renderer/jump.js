'use strict';
// Quick-jump palette backed by the remote directory index.
window.Jump = (() => {
  const { $, h } = UI;
  let app = null; let ctl = null; let progressUnsub = null;

  function init(a) { app = a; }

  function indexKey(tab) { return tab.hostId || ('adhoc:' + (tab.entry.username || '') + '@' + tab.entry.host + ':' + (tab.entry.port || 22)); }

  async function open() {
    if (ctl) { ctl.close(); return; }
    const tab = app.activeTab();
    if (!tab || !tab.sessionId) { UI.toast(t('jump.nosession'), 'warn'); return; }
    const key = indexKey(tab);
    const hh = tab.hostId ? Hosts.byId(tab.hostId) : null;
    let info = await window.api.index.info(key);
    let results = []; let active = 0; let query = '';

    const q = h('input', { class: 'q', type: 'text', placeholder: t('jump.placeholder'), spellcheck: 'false', autofocus: true });
    const res = h('div', { class: 'results' });
    const status = h('span');
    const rootInput = h('input', { type: 'text', value: (info.root) || (hh && hh.indexRoot) || '/', style: { width: '160px', fontFamily: 'var(--mono)' }, spellcheck: 'false', title: t('jump.root') });
    const filesCb = h('input', { type: 'checkbox' }); filesCb.checked = !!info.includeFiles;
    const btnBuild = h('button', { class: 'mini', onClick: () => build() }, t('jump.build'));
    const btnCancel = h('button', { class: 'mini', onClick: () => window.api.index.cancel(key) }, t('jump.cancel'));
    const foot = h('div', { class: 'foot' }, status, h('div', { class: 'spacer' }), h('label', null, t('jump.root') + ' '), rootInput, h('label', null, filesCb, ' ' + t('jump.files')), btnBuild, btnCancel,
      h('span', null, h('kbd', null, 'Enter'), ' cd  ', h('kbd', null, 'Ctrl+Enter'), ' files'));
    const body = h('div', { class: 'jump no-enter' }, q, res, foot);

    const renderStatus = () => {
      if (info.building) { status.textContent = t('jump.building', { n: info.progress }); btnBuild.hidden = true; btnCancel.hidden = false; return; }
      btnCancel.hidden = true; btnBuild.hidden = false; btnBuild.textContent = info.exists ? t('jump.rebuild') : t('jump.build');
      status.textContent = info.exists ? t('jump.info', { n: info.count, d: UI.fmtAgo(info.builtAt), r: info.root }) + (info.truncated ? ' ' + t('jump.truncated') : '') : t('jump.noindex');
    };
    const renderResults = () => {
      res.innerHTML = '';
      if (!results.length) { res.append(h('div', { class: 'empty' }, info.exists ? t('jump.noresults') : t('jump.noindex'))); return; }
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      results.forEach((r, i) => {
        const p = r.path; const cut = p.lastIndexOf('/');
        const dir = p.slice(0, cut + 1), base = p.slice(cut + 1);
        const row = h('div', { class: 'r' + (i === active ? ' active' : ''), onClick: () => go(i, false), onDblclick: () => go(i, true) });
        row.append(h('span', { class: 'dir' }, hl(dir, terms)), h('span', { class: 'base' }, hl(base, terms)));
        res.append(row);
      });
      const a = res.children[active]; if (a) a.scrollIntoView({ block: 'nearest' });
    };
    const hl = (text, terms) => {
      const frag = document.createDocumentFragment();
      const low = text.toLowerCase(); const marks = new Array(text.length).fill(false);
      for (const tm of terms) { let i = low.indexOf(tm); while (i >= 0) { for (let k = i; k < i + tm.length; k++) marks[k] = true; i = low.indexOf(tm, i + 1); } }
      let run = '', cur = false;
      const flush = () => { if (!run) return; frag.append(cur ? h('mark', null, run) : document.createTextNode(run)); run = ''; };
      for (let i = 0; i < text.length; i++) { if (marks[i] !== cur) { flush(); cur = marks[i]; } run += text[i]; }
      flush(); return frag;
    };
    let timer = null;
    const search = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        query = q.value; try { results = await window.api.index.search(key, query, 200); } catch (_) { results = []; }
        active = 0; renderResults();
      }, 50);
    };
    const go = (i, files) => {
      const r = results[i]; if (!r) return;
      const isFile = info.includeFiles && !r.path.endsWith('/') && /\.[^/]+$/.test(r.path.split('/').pop()) && false; // unknown; treat as dir unless it errors
      const dir = r.path;
      ctl.close();
      if (files) Files.openFor({ sessionId: tab.sessionId, path: dir });
      else tab.cd(dir);
    };
    const build = async () => {
      info = { ...info, building: true, progress: 0 }; renderStatus();
      try { info = await window.api.index.build(key, { sessionId: tab.sessionId, root: rootInput.value.trim() || '/', includeFiles: filesCb.checked }); UI.toast(t('jump.info', { n: info.count, d: 'now', r: info.root }), 'ok'); }
      catch (e) { UI.errToast(e); info = await window.api.index.info(key); }
      renderStatus(); search(); app.updateIndexStatus();
    };
    q.addEventListener('input', search);
    ctl = UI.modal({ body, top: true, cls: 'jump-modal', onKey: (e) => {
      if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); renderResults(); return true; }
      if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); renderResults(); return true; }
      if (e.key === 'PageDown') { active = Math.min(results.length - 1, active + 10); renderResults(); return true; }
      if (e.key === 'PageUp') { active = Math.max(0, active - 10); renderResults(); return true; }
      if (e.key === 'Enter') { e.preventDefault(); if (!results.length && !info.exists && !info.building) build(); else go(active, e.ctrlKey || e.metaKey); return true; }
      return false;
    } });
    ctl.promise.then(() => { ctl = null; if (progressUnsub) { progressUnsub(); progressUnsub = null; } });
    progressUnsub = window.api.on('index:progress', (p) => { if (p.hostId !== key) return; if (p.done) return; info = { ...info, building: true, progress: p.count }; renderStatus(); });
    renderStatus(); search();
    setTimeout(() => q.focus(), 0);
  }

  return { init, open, indexKey };
})();
