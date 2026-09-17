'use strict';
// A tab is a group of terminal panes arranged in a binary split tree.
// node = { type:'leaf', pane } | { type:'split', dir:'h'|'v', children:[node,node], sizes:[w0,w1] }  (sizes are flex weights)
window.TabGroup = (() => {
  const { h } = UI;
  let seq = 1;

  class TabGroup {
    constructor(app) {
      this.app = app; this.id = 'grp' + (seq++);
      this.wrap = h('div', { class: 'tab-group' });
      this.root = null; this.panes = []; this.activePane = null; this.maximized = false;
    }
    get title() { const p = this.activePane || this.panes[0]; return p ? p.title + (this.panes.length > 1 ? ` (${this.panes.length})` : '') : ''; }
    get status() { const p = this.activePane || this.panes[0]; return p ? p.status : 'closed'; }

    /** Add a pane; if `from` is given, split that pane in direction `dir` ('h' = side by side, 'v' = stacked). */
    add(pane, from, dir) {
      pane.group = this; this.panes.push(pane);
      const leaf = { type: 'leaf', pane };
      if (!this.root) this.root = leaf;
      else if (from) {
        const target = this._find(this.root, from);
        if (target) {
          const split = { type: 'split', dir: dir || 'h', children: [{ type: 'leaf', pane: from }, leaf], sizes: [1, 1] };
          this._replace(target, split);
        } else this.root = { type: 'split', dir: 'h', children: [this.root, leaf], sizes: [1, 1] };
      } else this.root = { type: 'split', dir: 'h', children: [this.root, leaf], sizes: [1, 1] };
      this.maximized = false;
      this.layout(); this.focus(pane);
    }
    /** Remove a pane; returns the number of panes left. */
    remove(pane) {
      const node = this._find(this.root, pane); if (!node) return this.panes.length;
      this.panes = this.panes.filter(p => p !== pane);
      const parent = this._parent(this.root, node);
      if (!parent) this.root = null;
      else { const sibling = parent.children.find(c => c !== node); this._replace(parent, sibling); }
      this.maximized = false;
      if (this.activePane === pane) this.activePane = null;
      this.layout();
      if (!this.activePane && this.panes.length) this.focus(this.panes[0]);
      return this.panes.length;
    }
    focus(pane) {
      if (!pane || !this.panes.includes(pane)) return;
      this.activePane = pane;
      for (const p of this.panes) p.wrap.classList.toggle('active', p === pane);
      pane.focus();
      this.app.onPaneFocus && this.app.onPaneFocus(pane);
    }
    toggleMaximize() { if (this.panes.length < 2) return; this.maximized = !this.maximized; this.wrap.classList.toggle('max', this.maximized); this.fitAll(); }
    show() { this.wrap.hidden = false; requestAnimationFrame(() => { this.fitAll(); if (this.activePane) this.activePane.focus(); }); }
    hide() { this.wrap.hidden = true; }
    fitAll() { for (const p of this.panes) p.fitNow(); }

    /** Pane adjacent to `pane` in a direction ('left'|'right'|'up'|'down'), by geometry. */
    neighbor(pane, direction) {
      const r = pane.wrap.getBoundingClientRect(); const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      let best = null, bestD = Infinity;
      for (const p of this.panes) {
        if (p === pane || p.wrap.hidden) continue;
        const q = p.wrap.getBoundingClientRect(); const qx = (q.left + q.right) / 2, qy = (q.top + q.bottom) / 2;
        const ok = direction === 'left' ? q.right <= r.left + 2 : direction === 'right' ? q.left >= r.right - 2 : direction === 'up' ? q.bottom <= r.top + 2 : q.top >= r.bottom - 2;
        if (!ok) continue;
        const d = (direction === 'left' || direction === 'right') ? Math.abs(qx - cx) + Math.abs(qy - cy) * 3 : Math.abs(qy - cy) + Math.abs(qx - cx) * 3;
        if (d < bestD) { bestD = d; best = p; }
      }
      return best;
    }

    // ---- tree helpers ----
    _find(node, pane) { if (!node) return null; if (node.type === 'leaf') return node.pane === pane ? node : null; return this._find(node.children[0], pane) || this._find(node.children[1], pane); }
    _parent(node, target) { if (!node || node.type === 'leaf') return null; if (node.children.includes(target)) return node; return this._parent(node.children[0], target) || this._parent(node.children[1], target); }
    _replace(target, replacement) {
      if (this.root === target) { this.root = replacement; return; }
      const parent = this._parent(this.root, target);
      if (parent) parent.children[parent.children.indexOf(target)] = replacement;
    }

    // ---- DOM ----
    layout() {
      this.wrap.innerHTML = '';
      if (this.root) this.wrap.append(this._render(this.root));
      this.wrap.classList.toggle('multi', this.panes.length > 1);
      this.wrap.classList.toggle('max', this.maximized);
      requestAnimationFrame(() => this.fitAll());
    }
    _render(node) {
      if (node.type === 'leaf') { node.pane.wrap.style.flex = ''; return node.pane.wrap; }
      const el = h('div', { class: 'split ' + node.dir });
      node.children.forEach((c, i) => {
        const childEl = this._render(c);
        childEl.style.flex = `${node.sizes[i]} 1 0%`;
        if (i > 0) el.append(this._divider(node, i - 1, el));
        el.append(childEl);
      });
      return el;
    }
    _divider(node, i, container) {
      const d = h('div', { class: 'divider ' + node.dir });
      d.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const horiz = node.dir === 'h';
        const kids = [...container.children].filter(c => !c.classList.contains('divider'));
        const a = kids[i], b = kids[i + 1];
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const total = horiz ? ra.width + rb.width : ra.height + rb.height;
        const start = horiz ? e.clientX : e.clientY; const sa = horiz ? ra.width : ra.height;
        const overlay = h('div', { class: 'drag-overlay ' + node.dir }); document.body.append(overlay);
        const move = (ev) => {
          const pos = horiz ? ev.clientX : ev.clientY;
          const na = Math.max(80, Math.min(total - 80, sa + (pos - start)));
          node.sizes[i] = na; node.sizes[i + 1] = total - na;
          a.style.flex = `${na} 1 0%`; b.style.flex = `${total - na} 1 0%`;
        };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); overlay.remove(); this.fitAll(); if (this.activePane) this.activePane.focus(); };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
      return d;
    }
  }
  return TabGroup;
})();
