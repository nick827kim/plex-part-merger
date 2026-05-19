const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  getMode: () => ipcRenderer.invoke("app:get-mode"),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  chooseOutput: (payload) => ipcRenderer.invoke("merge:choose-output", payload),
  merge: (payload) => ipcRenderer.invoke("merge:start", payload),
  onMergeLog: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("merge:log", handler);
    return () => ipcRenderer.removeListener("merge:log", handler);
  },
  onMergeProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on("merge:progress", handler);
    return () => ipcRenderer.removeListener("merge:progress", handler);
  }
});
