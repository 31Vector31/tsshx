'use strict';
// Built-in colour schemes (xterm ITheme format) + helpers to derive the app chrome palette from a scheme.
window.Themes = (() => {
  const builtin = {
    'Midnight': { background: '#0e1116', foreground: '#d6dce6', cursor: '#7fc1ff', selectionBackground: 'rgba(76,155,232,0.35)',
      black: '#1c2330', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#c8ccd4',
      brightBlack: '#5c6370', brightRed: '#ff7b86', brightGreen: '#b5e890', brightYellow: '#ffd98c', brightBlue: '#7fc1ff', brightMagenta: '#e39dff', brightCyan: '#6ee0ec', brightWhite: '#ffffff' },
    'One Dark': { background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: 'rgba(62,68,81,0.9)',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff' },
    'Tokyo Night': { background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: 'rgba(51,70,124,0.7)',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5' },
    'Catppuccin Mocha': { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: 'rgba(88,91,112,0.6)',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8' },
    'Dracula': { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: 'rgba(68,71,90,0.8)',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' },
    'Nord': { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: 'rgba(67,76,94,0.9)',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4' },
    'Gruvbox Dark': { background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', selectionBackground: 'rgba(235,219,178,0.2)',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2' },
    'Monokai': { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: 'rgba(73,72,62,0.9)',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5' },
    'Solarized Dark': { background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: 'rgba(147,161,161,0.25)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
    'Rosé Pine': { background: '#191724', foreground: '#e0def4', cursor: '#524f67', selectionBackground: 'rgba(64,61,82,0.8)',
      black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#31748f', brightYellow: '#f6c177', brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#e0def4' },
    'Sakura': { background: '#1b1420', foreground: '#f2dfe6', cursor: '#ff8fb8', selectionBackground: 'rgba(255,143,184,0.25)',
      black: '#2a1f30', red: '#ff6b9d', green: '#8fe3a6', yellow: '#ffd07f', blue: '#8fb7ff', magenta: '#e39dff', cyan: '#7fe6ea', white: '#e6d4dc',
      brightBlack: '#6a5470', brightRed: '#ff8fb8', brightGreen: '#b0f3c0', brightYellow: '#ffe2a8', brightBlue: '#b0ceff', brightMagenta: '#f0bdff', brightCyan: '#a8f0f3', brightWhite: '#ffffff' },
    'Light': { background: '#fbfbfd', foreground: '#1f2430', cursor: '#1f2430', selectionBackground: 'rgba(45,125,210,0.25)',
      black: '#000000', red: '#c91b00', green: '#00a600', yellow: '#b48a00', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#a5a5a5',
      brightBlack: '#686868', brightRed: '#ff6e67', brightGreen: '#5ffa68', brightYellow: '#e9b400', brightBlue: '#3b8eea', brightMagenta: '#ff77ff', brightCyan: '#5ffdff', brightWhite: '#ffffff' },
  };
  let custom = {}; // name -> ITheme (loaded from userData/themes)

  const KEYS = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

  // Accept xterm ITheme, Windows Terminal scheme ({name, cursorColor, selectionBackground, purple...}), or iTerm-ish JSON with the same keys.
  function normalize(obj) {
    const out = {};
    const src = { ...obj };
    if (src.cursorColor && !src.cursor) src.cursor = src.cursorColor;
    if (src.purple && !src.magenta) src.magenta = src.purple;
    if (src.brightPurple && !src.brightMagenta) src.brightMagenta = src.brightPurple;
    for (const k of KEYS) if (typeof src[k] === 'string') out[k] = src[k];
    if (!out.background || !out.foreground) throw new Error('Theme needs at least background and foreground');
    return out;
  }

  const all = () => ({ ...builtin, ...custom });
  const get = (name) => all()[name] || builtin['Midnight'];
  const setCustom = (map) => { custom = {}; for (const [n, v] of Object.entries(map || {})) { try { custom[n] = normalize(v); } catch (_) {} } };

  // ---- colour math ----
  const hex = (c) => { const m = String(c).trim().match(/^#?([0-9a-f]{6})$/i); if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)]; const r = String(c).match(/rgba?\(([^)]+)\)/); if (r) return r[1].split(',').slice(0, 3).map(x => +x); return [0, 0, 0]; };
  const toHex = (rgb) => '#' + rgb.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, k) => toHex(hex(a).map((x, i) => x + (hex(b)[i] - x) * k));
  const lum = (c) => { const [r, g, b] = hex(c).map(x => x / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const isDark = (theme) => lum(theme.background) < 0.5;
  const withAlpha = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r},${g},${b},${a})`; };

  /** Compute CSS variables for the app chrome from a terminal theme. */
  function chromeVars(theme) {
    const dark = isDark(theme);
    const bg = theme.background, fg = theme.foreground;
    const step = dark ? '#ffffff' : '#000000';
    return {
      '--bg': bg, '--bg2': mix(bg, step, dark ? 0.035 : 0.03), '--bg3': mix(bg, step, dark ? 0.08 : 0.06), '--hover': mix(bg, step, dark ? 0.06 : 0.05),
      '--border': mix(bg, step, dark ? 0.12 : 0.12), '--fg': fg, '--fg2': mix(fg, bg, 0.42), '--accent': theme.blue || theme.brightBlue || '#4c9be8', '--accent2': theme.green || '#7bd88f',
      '--danger': theme.red || '#e06c75', '--warn': theme.yellow || '#e5c07b', '--sel': withAlpha(theme.blue || '#4c9be8', 0.22), '--sel-solid': mix(bg, theme.blue || '#4c9be8', 0.25),
    };
  }

  return { builtin, get all() { return all(); }, get, normalize, setCustom, chromeVars, isDark, withAlpha, mix, hex };
})();
