'use strict';
// Small DOM / modal / toast / context-menu helpers.
window.UI = (() => {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === false || v === null || v === undefined) continue;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const stack = [];
  /** open modal: returns {el, close(result)} ; resolves promise with result */
  function modal({ title, body, buttons = [], width, top = false, onKey, closeOnBack = true, cls = '' }) {
    let resolveP; const p = new Promise(r => { resolveP = r; });
    const back = h('div', { class: 'modal-back' + (top ? ' top' : '') });
    const box = h('div', { class: 'modal ' + cls, style: width ? { width } : undefined });
    if (title) box.append(h('div', { class: 'modal-head' }, title));
    const bodyEl = h('div', { class: 'modal-body' });
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
    box.append(bodyEl);
    const ctl = { el: box, body: bodyEl, back, close: (result) => { if (!back.isConnected) return; back.remove(); stack.splice(stack.indexOf(ctl), 1); resolveP(result); const prev = stack[stack.length - 1]; if (prev && prev.focus) prev.focus(); else { const a = window.App; if (a && a.focusTerminal) a.focusTerminal(); } }, promise: p };
    if (buttons.length) {
      const foot = h('div', { class: 'modal-foot' });
      for (const b of buttons) {
        const btn = h('button', { class: b.cls || '', onClick: async () => { const r = b.onClick ? await b.onClick(ctl) : b.value; if (r !== UI.KEEP_OPEN) ctl.close(r === undefined ? b.value : r); } }, b.label);
        if (b.primary) btn.classList.add('primary');
        foot.append(btn); b.el = btn;
      }
      box.append(foot);
    }
    back.append(box);
    back.addEventListener('mousedown', (e) => { if (e.target === back && closeOnBack) ctl.close(undefined); });
    box.addEventListener('keydown', (e) => {
      if (onKey && onKey(e, ctl) === true) return;
      if (e.key === 'Escape') { e.stopPropagation(); ctl.close(undefined); }
      else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && !e.target.closest('.no-enter')) {
        const prim = buttons.find(b => b.primary);
        if (prim && prim.el && !prim.el.disabled) { e.preventDefault(); prim.el.click(); }
      }
    });
    $('#modals').append(back);
    stack.push(ctl);
    ctl.focus = () => { const f = box.querySelector('[autofocus], input, select, textarea, button'); if (f) f.focus(); };
    setTimeout(ctl.focus, 0);
    return ctl;
  }
  const KEEP_OPEN = Symbol('keep');

  function confirm(message, { title, okLabel, danger, detail } = {}) {
    const body = h('div', null, h('div', null, message), detail ? h('div', { class: 'fp', style: { marginTop: '8px' } }, detail) : null);
    return modal({ title: title || '', body, buttons: [{ label: t('cancel'), value: false }, { label: okLabel || t('ok'), value: true, primary: true, cls: danger ? 'danger' : '' }] }).promise.then(v => v === true);
  }

  function prompt(message, { title, value = '', password = false, placeholder = '', mono = false } = {}) {
    const input = h('input', { type: password ? 'password' : 'text', value, placeholder, autofocus: true, style: { width: '100%', fontFamily: mono ? 'var(--mono)' : undefined }, spellcheck: 'false' });
    const body = h('div', null, h('div', { style: { marginBottom: '8px' } }, message), input);
    const ctl = modal({ title: title || '', body, buttons: [{ label: t('cancel'), value: null }, { label: t('ok'), primary: true, onClick: () => input.value }] });
    setTimeout(() => { input.focus(); if (!password) input.select(); }, 0);
    return ctl.promise.then(v => (v === undefined ? null : v));
  }

  function toast(msg, kind = 'info', ms = 3500) {
    const el = h('div', { class: 'toast ' + kind }, msg);
    $('#toasts').append(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, ms);
    return el;
  }
  const errToast = (err) => toast((err && err.message) ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err), 'error', 6000);

  // Context menu: items [{label, kbd, onClick, disabled}, 'sep']
  function ctxmenu(x, y, items) {
    const m = $('#ctxmenu'); m.innerHTML = ''; m.hidden = false;
    for (const it of items) {
      if (it === 'sep' || it === '-') { m.append(h('div', { class: 'sep' })); continue; }
      if (!it) continue;
      m.append(h('div', { class: 'mi' + (it.disabled ? ' disabled' : ''), onClick: () => { hide(); it.onClick && it.onClick(); } }, h('span', null, it.label), it.kbd ? h('kbd', null, it.kbd) : null));
    }
    const hide = () => { m.hidden = true; document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); };
    const outside = (e) => { if (!m.contains(e.target)) hide(); };
    const esc = (e) => { if (e.key === 'Escape') hide(); };
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc, true); }, 0);
    m.style.left = '0px'; m.style.top = '0px';
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
    m.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  }

  const fmtSize = (n) => { if (n == null) return ''; if (n < 1024) return n + ' B'; const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1); return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i]; };
  const fmtDate = (ms) => { if (!ms) return ''; const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const fmtAgo = (ms) => { const s = Math.round((Date.now() - ms) / 1000); if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; if (s < 86400) return Math.round(s / 3600) + 'h'; return Math.round(s / 86400) + 'd'; };

  return { $, $$, h, esc, modal, confirm, prompt, toast, errToast, ctxmenu, fmtSize, fmtDate, fmtAgo, KEEP_OPEN, get modalOpen() { return stack.length > 0; } };
})();
