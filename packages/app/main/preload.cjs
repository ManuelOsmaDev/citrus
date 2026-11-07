// Puente mínimo: la página solo puede llamar a la API de main.js. No recibe ipcRenderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("citrusBridge", {
  call: (method, args) => ipcRenderer.invoke("citrus", method, args),
  onFocus: (callback) => {
    ipcRenderer.on("citrus:focus", () => callback());
  },
  platform: process.platform,
});
