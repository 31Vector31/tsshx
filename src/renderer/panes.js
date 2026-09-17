'use strict';
// A tab is a group of terminal panes arranged in a binary split tree.
// node = { type:'leaf', pane } | { type:'split', dir:'h'|'v', children:[node,node], sizes:[w0,w1] }  (sizes are flex weights)
// Panes have a header (visible when the tab has >1 pane) with split/maximise/close buttons and a drag handle;
// a pane dragged onto the edge of another pane is re-docked there, dropped on the tab bar it becomes its own tab.
window.TabGroup = (() => {
  const { h } = UI;
  let seq = 1;
  const DND = 'application/x-terhui-pane';
  const paneById = new Map();

  class TabGroup {
    constructor(app) {
      this.app = app; this.id = 'grp' + (seq++);
      this.wrap = h('div', { class: 'tab-group' });
      this.root = null; this.panes = []; this.activePane = null; this.maximized = false;
    }
    get title() { const p = this.activePane || this.panes[0]; return p ? p.title + (this.panes.length > 1 ? ` (${this.panes.length})` : '') : ''; }
    get status() { const p = this.activePane || this.panes[0]; return p ? p.status : 'closed'; }

    /** Add a pane; if `from` is given, split that pane in direction `dir` ('h' = side by side, 'v' = stacked). */
    add(pane, from, dir, before) {
      pane.group = this; paneById.set(pane.id, pane);
      if (!this.panes.includes(pane)) this.panes.push(pane);
      const leaf = { type: 'leaf', pane };
      if (!this.root) this.root = leaf;
      else {
        const target = from ? this._find(this.root, from) : null;
        const kids = before ? [leaf, { type: 'leaf', pane: from }] : [{ type: 'leaf', pane: from }, leaf];
        if (target) this._replace(target, { type: 'split', dir: dir || 'h', children: kids, sizes: [1, 1] });
        else this.root = { type: 'split', dir: dir || 'h', children: [this.root, leaf], sizes: [1, 1] };
      }
      this.maximized = false;
      this.layout(); this.focus(pane);
    }
    /** Detach a pane from the tree (does not close it); returns the number of panes left. */
    remove(pane) {
      const node = this._find(this.root, pane); if (!node) return this.panes.length;
      this.panes = this.panes.filter(p => p !== pane);
      const parent = this._parent(this.root, node);
      if (!parent) this.root = null;
      else { const sibling = parent.children.find(c => c !== node); this._replace(parent, sibling); }
      this.maximized = false;
      if (this.activePane === pane) this.activePane = null;
      pane.group = null; paneById.delete(pane.id);
      this.layout();
      if (!this.activePane && this.panes.length) this.focus(this.panes[0]);
      return this.panes.length;
    }
    /** Re-dock `pane` next to `target` on the given side ('left'|'right'|'top'|'bottom'). Works across groups. */
    static move(pane, target, side) {
      if (pane === target) return;
      const src = pane.group, dst = target.group; if (!src || !dst) return;
      const left = src.remove(pane);
      dst.add(pane, target, (side === 'left' || side === 'right') ? 'h' : 'v', side === 'left' || side === 'top');
      if (left === 0 && src.app.dropGroup) src.app.dropGroup(src);
    }
    /** Dock a whole tab (group) next to `target` pane on the given side; the source tab disappears. */
    static dock(group, target, side) {
      const dst = target.group; if (!dst || !group || group === dst || !group.root) return;
      const node = dst._find(dst.root, target); if (!node) return;
      const incoming = group.root;
      for (const p of group.panes) { p.group = dst; dst.panes.push(p); }
      const kids = (side === 'left' || side === 'top') ? [incoming, node] : [node, incoming];
      dst._replace(node, { type: 'split', dir: (side === 'left' || side === 'right') ? 'h' : 'v', children: kids, sizes: [1, 1] });
      const moved = group.panes.slice(); group.panes = []; group.root = null; group.activePane = null;
      dst.maximized = false; dst.layout(); dst.focus(moved[0]);
      dst.app.dropGroup && dst.app.dropGroup(group);
    }
    focus(pane) {
      if (!pane || !this.panes.includes(pane)) return;
      this.activePane = pane;
      for (const p of this.panes) p.wrap.parentElement && p.wrap.parentElement.classList.toggle('active', p === pane);
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
        if (p === pane || p.wrap.offsetWidth === 0) continue;
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
      for (const p of this.panes) p.wrap.parentElement.classList.toggle('active', p === this.activePane);
      requestAnimationFrame(() => this.fitAll());
    }
    _render(node) {
      if (node.type === 'leaf') return this._paneBox(node.pane);
      const el = h('div', { class: 'split ' + node.dir });
      node.children.forEach((c, i) => {
        const childEl = this._render(c);
        childEl.style.flex = `${node.sizes[i]} 1 0%`;
        if (i > 0) el.append(this._divider(node, i - 1, el));
        el.append(childEl);
      });
      return el;
    }
    _paneBox(pane) {
      const app = this.app;
      const btn = (icon, title, fn) => h('button', { class: 'icon-btn', title, onClick: (e) => { e.stopPropagation(); fn(); } }, Icon(icon, 14));
      const head = h('div', { class: 'pane-head', draggable: 'true', title: t('pane.dragHint') },
        h('span', { class: 'grip' }, Icon('menu', 12)),
        h('span', { class: 'pt' }, `${pane.entry.username ? pane.entry.username + '@' : ''}${pane.entry.host}`),
        h('span', { class: 'spacer' }),
        btn('splitH', t('pane.splitRight'), () => app.split('h', pane)), btn('splitV', t('pane.splitDown'), () => app.split('v', pane)),
        btn('maximize', t('pane.maximize'), () => this.toggleMaximize()), btn('close', t('pane.close'), () => app.closePane(pane)));
      head.addEventListener('mousedown', () => this.focus(pane));
      head.addEventListener('dragstart', (e) => { e.dataTransfer.setData(DND, pane.id); e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('pane-dragging'); });
      head.addEventListener('dragend', () => document.body.classList.remove('pane-dragging'));
      const hint = h('div', { class: 'drop-hint', hidden: true });
      const box = h('div', { class: 'pane-box' }, head, pane.wrap, hint);
      pane.wrap.style.flex = '';
      const zoneOf = (e) => { const r = box.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height; const dx = Math.min(x, 1 - x), dy = Math.min(y, 1 - y); return dx < dy ? (x < 0.5 ? 'left' : 'right') : (y < 0.5 ? 'top' : 'bottom'); };
      const TAB = 'application/x-terhui-tab';
      box.addEventListener('dragover', (e) => {
        const types = [...e.dataTransfer.types]; if (!types.includes(DND) && !types.includes(TAB)) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        const z = zoneOf(e); hint.hidden = false; hint.className = 'drop-hint ' + z;
      });
      box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) hint.hidden = true; });
      box.addEventListener('drop', (e) => {
        hint.hidden = true;
        const id = e.dataTransfer.getData(DND);
        const gid = e.dataTransfer.getData(TAB);
        if (!id && !gid) return;
        e.preventDefault();
        if (id) { const moving = paneById.get(id); if (moving) TabGroup.move(moving, pane, zoneOf(e)); }
        else { const g = app.tabs.find(x => x.id === gid); if (g) TabGroup.dock(g, pane, zoneOf(e)); }
        app.renderTabs && app.renderTabs();
      });
      return box;
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
  TabGroup.DND = DND;
  TabGroup.paneById = (id) => paneById.get(id);
  return TabGroup;
})();
