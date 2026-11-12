const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('obd', {
  listPorts: () => ipcRenderer.invoke('ports:list'),
  scan: (portPath, options) => ipcRenderer.invoke('scan:run', portPath, options),
  clear: (portPath, targets, options) => ipcRenderer.invoke('clear:run', portPath, targets, options),
  onProgress: subscribe('scan:progress'),
  onLog: subscribe('scan:log'),
  onAppError: subscribe('app:error'),

  liveStart: (portPath) => ipcRenderer.invoke('live:start', portPath),
  liveStop: () => ipcRenderer.invoke('live:stop'),
  onLiveData: subscribe('live:data'),
  onLiveError: subscribe('live:error'),
  onLiveStopped: subscribe('live:stopped'),

  // Coding (writes to the car). Progress arrives on the same channel as scans (onProgress).
  codingPlatforms: () => ipcRenderer.invoke('coding:platforms'),
  codingRead: (portPath) => ipcRenderer.invoke('coding:read', portPath),
  codingWrite: (portPath, changes) => ipcRenderer.invoke('coding:write', portPath, changes),
  codingBackups: (vin) => ipcRenderer.invoke('coding:backups', vin),
  codingRestore: (portPath, backupId) => ipcRenderer.invoke('coding:restore', portPath, backupId),

  historyList:() => ipcRenderer.invoke('history:list'),
  historyLoad: (id) => ipcRenderer.invoke('history:load', id),
  historyRemove: (id) => ipcRenderer.invoke('history:remove', id),
  markRepaired: (id, note) => ipcRenderer.invoke('repair:mark', id, note),
  saveLiveCsv: (samples) => ipcRenderer.invoke('live:saveCsv', samples),

  copyReport: (report) => ipcRenderer.invoke('report:copy', report),
  saveReport: (report, format) => ipcRenderer.invoke('report:save', report, format),
});
