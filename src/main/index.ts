import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { join } from "node:path";
import { parseSequenceId } from "../shared/onlinesequencer";
import type { SongRef } from "../shared/types";
import { openInSystemBrowser } from "./browser";
import { download, importMidiFile, importOnlineSequence, listLibrary, readLibraryFile, removeFromLibrary } from "./library";
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
      backgroundThrottling: false,
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
  ipcMain.handle("library:remove", (_e, fileName: string) => removeFromLibrary(fileName));
  ipcMain.handle("library:import-file", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Adicionar MIDI",
      defaultPath: app.getPath("downloads"),
      properties: ["openFile"],
      filters: [{ name: "Arquivos MIDI", extensions: ["mid", "midi", "MID", "MIDI"] }],
    };
    const { canceled, filePaths } = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return canceled || !filePaths[0] ? null : importMidiFile(filePaths[0]);
  });
  ipcMain.handle("onlinesequencer:import", (_e, link: string, title: string) => {
    const id = parseSequenceId(link);
    if (!id) throw new Error("link da Online Sequencer inválido");
    return importOnlineSequence(id, title.trim() || `Online Sequencer #${id}`);
  });
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
