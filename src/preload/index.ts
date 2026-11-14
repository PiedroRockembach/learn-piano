import { contextBridge, ipcRenderer } from "electron";
import type { LearnPianoApi } from "../shared/types";

const api: LearnPianoApi = {
  search: (query, page) => ipcRenderer.invoke("search", query, page),
  download: (ref) => ipcRenderer.invoke("download", ref),
  listLibrary: () => ipcRenderer.invoke("library:list"),
  readLibrary: (fileName) => ipcRenderer.invoke("library:read", fileName),
  status: () => ipcRenderer.invoke("status"),
  openBrowser: (url) => ipcRenderer.invoke("browser:open", url),
  onImported: (cb) => ipcRenderer.on("library:imported", (_e, entry) => cb(entry)),
};

contextBridge.exposeInMainWorld("learnPiano", api);
