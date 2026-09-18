'use strict';
// Single monochrome 16px stroke icon set (currentColor). No emoji, no icon fonts.
window.Icon = (() => {
  const P = {
    menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
    plus: 'M8 3v10M3 8h10',
    close: 'M4 4l8 8M12 4l-8 8',
    search: 'M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.3 10.3L14 14',
    panel: 'M2 3h12v10H2zM9 3v10',
    settings: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3',
    up: 'M8 13V3M3.5 7.5L8 3l4.5 4.5',
    home: 'M2.5 7.5L8 2.5l5.5 5v6h-4v-4h-3v4h-4z',
    refresh: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3',
    eye: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    folderPlus: 'M1.5 3.5h4l1.5 1.5h7.5v8h-13zM8 7.5v4M6 9.5h4',
    filePlus: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3M8 7.5v4M6 9.5h4',
    edit: 'M11.5 2l2.5 2.5L6 12.5H3.5V10zM9.5 4l2.5 2.5',
    trash: 'M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v5M9.5 6.5v5',
    shield: 'M8 1.5l5.5 2v4c0 3.2-2.3 5.7-5.5 7-3.2-1.3-5.5-3.8-5.5-7v-4z',
    arrowDown: 'M8 3v10M3.5 8.5L8 13l4.5-4.5',
    arrowUp: 'M8 13V3M3.5 7.5L8 3l4.5 4.5',
    arrowRight: 'M3 8h10M8.5 3.5L13 8l-4.5 4.5',
    link: 'M6.5 9.5l3-3M5 11a2.5 2.5 0 0 1-3.5-3.5l2-2a2.5 2.5 0 0 1 3.5 0M11 5a2.5 2.5 0 0 1 3.5 3.5l-2 2a2.5 2.5 0 0 1-3.5 0',
    terminal: 'M2 3h12v10H2zM4.5 6l2.5 2-2.5 2M8 10h3.5',
    swap: 'M3 5.5h10l-3-3M13 10.5H3l3 3',
    folder: 'M1.5 3.5h4l1.5 1.5h7.5v8h-13z',
    file: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3',
    chevronDown: 'M4 6l4 4 4-4',
    chevronRight: 'M6 4l4 4-4 4',
    lock: 'M4 7V5a4 4 0 0 1 8 0v2M3 7h10v7H3z',
    download: 'M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13h11',
    upload: 'M8 10V2M4.5 5.5L8 2l3.5 3.5M2.5 13h11',
    check: 'M3 8.5l3 3 7-7',
    warning: 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.5',
    key: 'M9.5 2a4.5 4.5 0 1 0 1.9 8.6L14 13.2V11h-2v-2h-1.4A4.5 4.5 0 0 0 9.5 2z',
    ftp: 'M2 3h12v10H2zM2 6.5h12M6 6.5v6.5',
    play: 'M4 2.5l9 5.5-9 5.5z',
    clock: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM8 4.5V8l2.5 1.5',
    pin: 'M9.5 2l4.5 4.5-2 .5-2.5 2.5.5 3L8.5 11 5 14.5l-.5-.5L8 10.5 6.5 9l3-.5.5-2z',
    stop: 'M3.5 3.5h9v9h-9z',
    fingerprint: 'M4 6.5a4 4 0 0 1 8 0v1M5.5 9a2.5 2.5 0 0 1 5 0v2.5M8 8v6M3 5a5.5 5.5 0 0 1 10 0M2.5 8.5a6 6 0 0 0 1 3.5M12.5 12a6 6 0 0 0 1-3',
    hello: 'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zM5.5 6.5h.5M10 6.5h.5M5 9.5c1.5 1.8 4.5 1.8 6 0',
    splitH: 'M2 3h12v10H2zM8 3v10',
    splitV: 'M2 3h12v10H2zM2 8h12',
    maximize: 'M2.5 2.5h11v11h-11zM5 5h6v6H5z',
  };
  const svg = (name, size = 16) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('aria-hidden', 'true');
    s.classList.add('icon', 'icon-' + name);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', P[name] || P.close); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.4'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    s.append(p); return s;
  };
  // Replace <button data-icon="x"> contents in a subtree.
  const mount = (root) => { (root || document).querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = ''; el.append(svg(el.dataset.icon)); }); };
  return Object.assign(svg, { mount, names: Object.keys(P) });
})();
