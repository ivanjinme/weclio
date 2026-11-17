// Electron 沙盒预加载只支持 CommonJS，不能使用 ESM 导入。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("weclioDesktop", Object.freeze({
  // 连接信息由主进程持有；静态资产里不保存 Service 地址或凭据。
  getAgentService: () => ipcRenderer.invoke("agent-service:config"),
  downloadResource: (url) => ipcRenderer.invoke("resource:download", url),
  getUpdateState: () => ipcRenderer.invoke("desktop-update:get"),
  onUpdateState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("desktop-update:state", handler);
    return () => ipcRenderer.removeListener("desktop-update:state", handler);
  },
  restartUpdate: (locale) => ipcRenderer.invoke("desktop-update:restart", locale),
  checkForUpdates: () => ipcRenderer.invoke("desktop-update:check"),
}));
