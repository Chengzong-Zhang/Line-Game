const { contextBridge, ipcRenderer } = require("electron");
let lastSaveStatus = { ok: true, status: "not-read" };

contextBridge.exposeInMainWorld("lifelineDesktop", Object.freeze({
  isDesktop: true,
  readProgressSync: () => { lastSaveStatus = ipcRenderer.sendSync("lifeline:save:read"); return lastSaveStatus; },
  writeProgressSync: (serialized) => { lastSaveStatus = ipcRenderer.sendSync("lifeline:save:write", serialized); return lastSaveStatus; },
  clearProgressSync: () => { lastSaveStatus = ipcRenderer.sendSync("lifeline:save:clear"); return lastSaveStatus; },
  getLastSaveStatus: () => lastSaveStatus,
  readProfileSync: () => ipcRenderer.sendSync("lifeline:profile:read"),
  writeProfileSync: (serialized) => ipcRenderer.sendSync("lifeline:profile:write", serialized),
  quit: () => ipcRenderer.invoke("lifeline:app:quit"),
  saveReplay: (serialized) => ipcRenderer.invoke("lifeline:replay:save", serialized),
  getSteamStatus: () => ipcRenderer.invoke("lifeline:steam:status"),
  readAchievements: () => ipcRenderer.invoke("lifeline:achievements:read"),
  exportProgressBackup: () => ipcRenderer.invoke("lifeline:progress-backup:export"),
  importProgressBackup: () => ipcRenderer.invoke("lifeline:progress-backup:import")
}));
