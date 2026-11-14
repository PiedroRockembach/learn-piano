import { app, BrowserWindow, ipcMain, session } from "electron";
import { join } from "node:path";
import type { SongRef } from "../shared/types";
import { openInSystemBrowser } from "./browser";
import { download, listLibrary, readLibraryFile } from "./library";
import { pdmxAvailable } from "./pdmx";
import { search } from "./search";

const preload = join(__dirname, "../preload/index.js");
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#16181d",
    title: "Learn Piano",
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  mainWindow.on("closed", () => app.quit());
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  const allowed = new Set(["midi", "midiSysex"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  ipcMain.handle("search", (_e, query: string, page: number) => search(query, page));
  ipcMain.handle("download", (_e, ref: SongRef) => download(ref));
  ipcMain.handle("library:list", () => listLibrary());
  ipcMain.handle("library:read", (_e, fileName: string) => readLibraryFile(fileName));
  ipcMain.handle("status", () => ({ pdmx: pdmxAvailable() }));
  ipcMain.handle("browser:open", (_e, url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error("URL inválida");
    return openInSystemBrowser(url, (entry) => {
      mainWindow?.webContents.send("library:imported", entry);
      mainWindow?.focus();
    });
  });

  createWindow();
  setTimeout(() => pdmxAvailable(), 2000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
