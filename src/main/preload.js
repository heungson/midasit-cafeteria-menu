'use strict';
// 화면에 노출하는 최소 API. 비밀번호는 저장 요청으로만 넘어가고 다시 읽어 올 수 없다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cafeteria', {
  getView: () => ipcRenderer.invoke('view:get'),
  refresh: () => ipcRenderer.invoke('menu:refresh'),
  onView: (cb) => ipcRenderer.on('view:update', (_e, v) => cb(v)),
  onOpen: (cb) => ipcRenderer.on('ui:open', (_e, v) => cb(v)),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  saveCredentials: (username, password) => ipcRenderer.invoke('creds:save', { username, password }),
  clearCredentials: () => ipcRenderer.invoke('creds:clear'),
  importProfile: () => ipcRenderer.invoke('profile:import'),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  hide: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
});
