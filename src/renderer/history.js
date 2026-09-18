'use strict';
// Shell history palette: remote history files of the active session, fuzzy search, insert/run, pins.
window.History = (() => {
  const { $, h } = UI;
  let app = null; let ctl = null;
  const cache = new Map(); // hostKey -> { entries, files, pins, at }

  function init(a) { app = a; }

  const match = (cmd, terms) => { const l = cmd.toLowerCase(); return terms.every(t => l.includes(t)); };
  const score = (e, terms, pinned) => {
    let s = pinned ? 1e6 : 0;
    const l = e.cmd.toLowerCase();
    for (const t of terms) { const i = l.indexOf(t); if (i === 0) s += 40; else if (l[i - 1] === ' ') s += 20; else s += 5; }
    s += Math.min(e.count, 50) * 2;
    if (e.last) s += Math.max(0, 30 - (Date.now() - e.last) / 86400000);   // recency bonus over ~30 days
    return s;
  };
  const hl = (text, terms) => {
    const frag = document.createDocumentFragment();
    const low = text.toLowerCase(); const marks = new Array(text.length).fill(false);
    for (const tm of terms) { let i = low.indexOf(tm); while (i >= 0) { for (let k = i; k < i + tm.length; k++) marks[k] = true; i = low.indexOf(tm, i + 1); } }
    let run = '', cur = false;
    const flush = () => { if (run) { frag.append(cur ? h('mark', null, run) : document.createTextNode(run)); run = ''; } };
    for (let i = 0; i < text.length; i++) { if (marks[i] !== cur) { flush(); cur = marks[i]; } run += text[i]; }
    flush(); return frag;
  };

  async function open() {
    if (ctl) { ctl.close(); return; }
    const tab = app.activeTab();
    if (!tab || !tab.sessionId) { UI.toast(t('jump.nosession'), 'warn'); return; }
    const key = Jump.indexKey(tab);
    let data = cache.get(key) || { entries: [], files: [], pins: [] };
    let results = []; let active = 0; let terms = [];

    const q = h('input', { class: 'q', type: 'text', placeholder: t('hist.placeholder'), spellcheck: 'false', autofocus: true });
    const res = h('div', { class: 'results' });
    const status = h('span', null, t('hist.loading'));
    const foot = h('div', { class: 'foot' }, status, h('div', { class: 'spacer' }),
      h('span', null, h('kbd', null, 'Enter'), ' ' + t('hist.insert') + '  ', h('kbd', null, 'Ctrl+Enter'), ' ' + t('hist.run') + '  ', h('kbd', null, 'Ctrl+B'), ' ' + t('hist.pin') + '  ', h('kbd', null, 'Ctrl+C'), ' ' + t('hist.copy')));
    const body = h('div', { class: 'jump hist no-enter' }, q, res, foot);

    const renderStatus = () => { status.textContent = data.entries.length ? t('hist.entries', { n: data.entries.length, f: data.files.join(', ') || '—' }) : t('hist.empty'); };
    const render = () => {
      res.innerHTML = '';
      if (!results.length) { res.append(h('div', { class: 'empty' }, data.entries.length ? t('jump.noresults') : t('hist.empty'))); return; }
      const pins = new Set(data.pins);
      results.forEach((e, i) => {
        const pinned = pins.has(e.cmd);
        const row = h('div', { class: 'r' + (i === active ? ' active' : '') + (pinned ? ' pinned' : '') + (e.cmd.includes('\n') ? ' multi' : ''), title: e.cmd, onClick: () => { active = i; render(); }, onDblclick: () => go(i, false) },
          h('button', { class: 'pinbtn', title: t('hist.pin'), onClick: (ev) => { ev.stopPropagation(); togglePin(e.cmd); } }, Icon('pin', 12)),
          h('span', { class: 'cmd' }, hl(e.cmd.split('\n')[0], terms)),
          h('span', { class: 'meta', title: (e.count > 1 ? t('hist.used', { n: e.count }) + (e.last ? ' · ' : '') : '') + (e.last ? UI.fmtDate(e.last) : '') }, [e.count > 1 ? e.count + '×' : '', e.last ? UI.fmtAgoWords(e.last) : ''].filter(Boolean).join(' · ')));
        res.append(row);
      });
      const a = res.children[active]; if (a) a.scrollIntoView({ block: 'nearest' });
    };
    const search = () => {
      terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const pins = new Set(data.pins);
      results = data.entries.filter(e => !terms.length || match(e.cmd, terms)).map(e => ({ e, s: score(e, terms, pins.has(e.cmd)) })).sort((a, b) => b.s - a.s).slice(0, 300).map(x => x.e);
      active = 0; render();
    };
    const go = (i, run) => {
      const e = results[i]; if (!e) return;
      ctl.close();
      tab.insert(e.cmd, run);
      if (run) { window.api.history.note(key, e.cmd).catch(() => {}); const c = cache.get(key); if (c) { const x = c.entries.find(y => y.cmd === e.cmd); if (x) { x.count++; x.last = Date.now(); } } }
    };
    const togglePin = async (cmd) => {
      const list = data.pins.includes(cmd) ? data.pins.filter(x => x !== cmd) : [...data.pins, cmd];
      data.pins = await window.api.history.pins(key, list); cache.set(key, data); search();
    };
    let timer = null;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 40); });
    ctl = UI.modal({ body, top: true, cls: 'hist-modal', onKey: (e) => {
      if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); render(); return true; }
      if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); return true; }
      if (e.key === 'PageDown') { active = Math.min(results.length - 1, active + 10); render(); return true; }
      if (e.key === 'PageUp') { active = Math.max(0, active - 10); render(); return true; }
      if (e.key === 'Enter') { e.preventDefault(); go(active, e.ctrlKey || e.metaKey); return true; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); if (results[active]) togglePin(results[active].cmd); return true; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !window.getSelection().toString()) { e.preventDefault(); if (results[active]) { window.api.clipboard.write(results[active].cmd); UI.toast(t('copied'), 'ok', 1200); } return true; }
      return false;
    } });
    ctl.promise.then(() => { ctl = null; });
    search(); renderStatus();
    setTimeout(() => q.focus(), 0);
    // always refresh from the host (history files change as shells exit / flush)
    try {
      data = tab.local ? await window.api.history.fetchLocal(key, { wsl: tab.profile.wsl || '', kind: tab.profile.kind }) : await window.api.history.fetch(tab.sessionId, key);
      data.at = Date.now(); cache.set(key, data);
      if (ctl) { search(); renderStatus(); }
    } catch (err) { if (ctl) { status.textContent = (err.message || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); } }
  }

  const forget = (key) => cache.delete(key);
  return { init, open, forget };
})();
