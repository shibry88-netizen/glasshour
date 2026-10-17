'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gh', {
  // 状态
  getState: () => ipcRenderer.invoke('state:get'),
  setState: (patch) => ipcRenderer.invoke('state:set', patch),
  setMode: (m) => ipcRenderer.invoke('mode:set', m),
  setLoginItem: (on) => ipcRenderer.invoke('login-item:set', on),
  setScale: (k) => ipcRenderer.invoke('size:set', k),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('state:changed', h);
    return () => ipcRenderer.removeListener('state:changed', h);
  },

  // 窗口行为
  openSettings: () => ipcRenderer.invoke('ui:open-settings'),
  hide: () => ipcRenderer.invoke('ui:hide'),
  show: () => ipcRenderer.invoke('ui:show'),
  resetPosition: (corner) => ipcRenderer.invoke('ui:reset-position', corner),
  quit: () => ipcRenderer.invoke('app:quit'),
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),

  // 手动拖动
  dragStart: (pt) => ipcRenderer.send('drag:start', pt),
  dragMove: (pt) => ipcRenderer.send('drag:move', pt),
  dragEnd: () => ipcRenderer.send('drag:end'),

  platform: process.platform,
});
