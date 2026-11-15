import { app, shell } from "electron";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LibraryEntry } from "../shared/types";
import { libraryFileName, titleFromFileName, type Library } from "../shared/library";

const MIDI_EXT = /\.(mid|midi)$/i;
const PARTIAL_EXT = [".part", ".crdownload", ".download"];

let watcher: FSWatcher | null = null;
const seen = new Set<string>();
const pending = new Map<string, NodeJS.Timeout>();

// Cloudflare rejects embedded Electron views, so sites open in the user's own browser
// and finished .mid downloads are picked up from the Downloads folder.
export async function openInSystemBrowser(
  library: Library,
  url: string,
  onImported: (entry: LibraryEntry) => void,
): Promise<void> {
  watchDownloads(library, onImported);
  await shell.openExternal(url);
}

function watchDownloads(library: Library, onImported: (entry: LibraryEntry) => void): void {
  if (watcher) return;
  const dir = app.getPath("downloads");
  const since = Date.now();
  watcher = watch(dir, (_event, name) => {
    if (!name || !MIDI_EXT.test(name)) return;
    clearTimeout(pending.get(name));
    pending.set(name, setTimeout(() => void tryImport(library, dir, name, since, onImported), 1500));
  });
}

async function tryImport(
  library: Library,
  dir: string,
  name: string,
  since: number,
  onImported: (entry: LibraryEntry) => void,
): Promise<void> {
  pending.delete(name);
  const path = join(dir, name);
  const info = await stat(path).catch(() => null);
  if (!info || info.size === 0 || info.mtimeMs < since) return;
  if (PARTIAL_EXT.some((ext) => existsSync(path + ext))) return;
  const key = `${name}:${info.size}:${info.mtimeMs}`;
  if (seen.has(key)) return;
  seen.add(key);
  const bytes = new Uint8Array(await readFile(path));
  const id = `${Date.now()}`;
  const entry = await library.add(
    { source: "browser", id, title: titleFromFileName(name), url: path, detail: "Navegador · Downloads" },
    libraryFileName("browser", `${id}-${name}`),
    bytes,
  );
  onImported(entry);
}
