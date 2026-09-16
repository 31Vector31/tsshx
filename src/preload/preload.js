'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['ssh:data', 'ssh:status', 'ssh:closed', 'ssh:shell-closed', 'ssh:banner', 'ssh:error', 'xfer:progress', 'index:progress', 'prompt']);

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  app: { info: invoke('app:info') },
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  vault: { status: invoke('vault:status'), create: invoke('vault:create'), unlock: invoke('vault:unlock'), lock: invoke('vault:lock'), changeMaster: invoke('vault:changeMaster') },
  hosts: {
    list: invoke('hosts:list'), get: invoke('hosts:get'), save: invoke('hosts:save'), remove: invoke('hosts:remove'),
    importSshConfig: invoke('hosts:importSshConfig'), exportFile: invoke('hosts:exportFile'), importFile: invoke('hosts:importFile'), readKeyFile: invoke('hosts:readKeyFile'),
  },
  knownHosts: { list: invoke('knownhosts:list'), remove: invoke('knownhosts:remove') },
  ssh: {
    connect: invoke('ssh:connect'), close: invoke('ssh:close'), exec: invoke('ssh:exec'),
    write: (sessionId, data) => ipcRenderer.send('ssh:write', { sessionId, data }),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', { sessionId, cols, rows }),
  },
  fs: {
    ftpConnect: invoke('fs:ftpConnect'), ftpClose: invoke('fs:ftpClose'), home: invoke('fs:home'), list: invoke('fs:list'), stat: invoke('fs:stat'),
    mkdir: invoke('fs:mkdir'), rename: invoke('fs:rename'), delete: invoke('fs:delete'), chmod: invoke('fs:chmod'),
    readFile: invoke('fs:readFile'), writeFile: invoke('fs:writeFile'), openLocal: invoke('fs:openLocal'), showLocal: invoke('fs:showLocal'),
  },
  xfer: { start: invoke('xfer:start'), list: invoke('xfer:list'), cancel: invoke('xfer:cancel'), clear: invoke('xfer:clear') },
  index: { info: invoke('index:info'), build: invoke('index:build'), search: invoke('index:search'), cancel: invoke('index:cancel'), clear: invoke('index:clear') },
  dialog: { open: invoke('dialog:open'), save: invoke('dialog:save'), confirm: invoke('dialog:confirm') },
  themes: { list: invoke('themes:list'), import: invoke('themes:import'), save: invoke('themes:save'), delete: invoke('themes:delete') },
  wallpaper: { pick: invoke('wallpaper:pick'), read: invoke('wallpaper:read') },
  clipboard: { read: invoke('clipboard:read'), write: invoke('clipboard:write') },
  shell: { openExternal: invoke('shell:openExternal') },
  window: { setTitle: invoke('window:setTitle'), info: invoke('window:info'), chrome: invoke('window:chrome'), relaunch: invoke('app:relaunch') },
  theme: { native: invoke('theme:native') },
  answerPrompt: (id, value) => ipcRenderer.send('prompt:answer', { id, value }),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return null; } },
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error('Unknown event ' + channel);
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
