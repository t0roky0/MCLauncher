'use strict';
// The in-game overlay page: its state in; out only the menu's actions and
// the layout editor's changes.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  listen(fn) {
    ipcRenderer.on('overlay:state', (_event, state) => fn(state));
  },
  save(patch) {
    ipcRenderer.send('overlay:save', JSON.parse(JSON.stringify(patch || {})));
  },
  done() {
    ipcRenderer.send('overlay:done');
  },
  action(name, value) {
    ipcRenderer.send('overlay:action', String(name), value === undefined ? null : JSON.parse(JSON.stringify(value)));
  },
});
