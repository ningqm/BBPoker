const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tongzhuoDesktop', Object.freeze({
  saveFile: payload => ipcRenderer.invoke('tongzhuo:save-file', payload),
  identityRead: () => ipcRenderer.invoke('tongzhuo:identity-read'),
  identityWrite: token => ipcRenderer.invoke('tongzhuo:identity-write', token),
  identityClear: expectedToken => ipcRenderer.invoke('tongzhuo:identity-clear', expectedToken),
}));
