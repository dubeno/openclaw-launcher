const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  },
  openclaw: {
    start: () => ipcRenderer.invoke('openclaw:start'),
    stop: () => ipcRenderer.invoke('openclaw:stop'),
    getStatus: () => ipcRenderer.invoke('openclaw:status'),
    needsOnboard: () => ipcRenderer.invoke('openclaw:needsOnboard'),
    runOnboard: (opts) => ipcRenderer.invoke('openclaw:runOnboard', opts),
    onLog: (cb) => ipcRenderer.on('openclaw:log', (_, d) => cb(d)),
    onOnboardLog: (cb) => ipcRenderer.on('openclaw:onboardLog', (_, d) => cb(d)),
    onStatus: (cb) => ipcRenderer.on('openclaw:status', (_, s) => cb(s)),
    onReady: (cb) => ipcRenderer.on('openclaw:ready', (_, data) => cb(data))
  },
  config: {
    get: (key) => ipcRenderer.invoke('config:get', key),
    getAll: () => ipcRenderer.invoke('config:getAll'),
    save: (cfg) => ipcRenderer.invoke('config:save', cfg)
  }
});
