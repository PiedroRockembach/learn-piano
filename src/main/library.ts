import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LibraryEntry, SongRef } from "../shared/types";
import { fetchSequenceMidi } from "./onlinesequencer";
import { libraryDir, libraryIndexFile } from "./paths";
import { readPdmxMidi } from "./pdmx";

export async function listLibrary(): Promise<LibraryEntry[]> {
  try {
    return JSON.parse(await readFile(libraryIndexFile, "utf8"));
  } catch {
    return [];
  }
}

export async function addToLibrary(ref: SongRef, fileName: string, bytes: Uint8Array): Promise<LibraryEntry> {
  await mkdir(libraryDir, { recursive: true });
  await writeFile(join(libraryDir, fileName), bytes);
  const entry: LibraryEntry = { ...ref, fileName, addedAt: new Date().toISOString() };
  const index = await listLibrary();
  await writeFile(libraryIndexFile, JSON.stringify([entry, ...index.filter((e) => e.fileName !== fileName)], null, 2));
  return entry;
}

// Re-importing the same path replaces its earlier copy instead of duplicating the entry.
export async function importMidiFile(path: string): Promise<LibraryEntry> {
  const bytes = new Uint8Array(await readFile(path));
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "MThd") throw new Error("O arquivo não é um MIDI válido");
  const name = basename(path);
  const existing = (await listLibrary()).find((e) => e.source === "local" && e.url === path);
  const id = existing?.id ?? `${Date.now()}`;
  const title = name.replace(/\.midi?$/i, "").replace(/[-_]+/g, " ").trim();
  return addToLibrary(
    { source: "local", id, title, url: path, detail: "Arquivo local" },
    existing?.fileName ?? libraryFileName("local", `${id}-${name}`),
    bytes,
  );
}

export async function importOnlineSequence(id: string, title: string): Promise<LibraryEntry> {
  const bytes = await fetchSequenceMidi(id);
  return addToLibrary(
    { source: "onlinesequencer", id, title, url: `https://onlinesequencer.net/${id}`, detail: `Online Sequencer · #${id}` },
    libraryFileName("onlinesequencer", id),
    bytes,
  );
}

export function libraryFileName(source: string, id: string): string {
  return `${source}-${id.replace(/[^\w.-]+/g, "_").replace(/\.midi?$/i, "")}.mid`;
}

function libraryPath(fileName: string): string {
  if (fileName.includes("/") || fileName.includes("..")) throw new Error("Nome de arquivo inválido");
  return join(libraryDir, fileName);
}

export async function readLibraryFile(fileName: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(libraryPath(fileName)));
}

export async function removeFromLibrary(fileName: string): Promise<void> {
  const path = libraryPath(fileName);
  const index = await listLibrary();
  await writeFile(libraryIndexFile, JSON.stringify(index.filter((e) => e.fileName !== fileName), null, 2));
  await rm(path, { force: true });
}

export async function download(ref: SongRef): Promise<{ entry: LibraryEntry; bytes: Uint8Array }> {
  const fileName = libraryFileName(ref.source, ref.id);
  const existing = (await listLibrary()).find((e) => e.fileName === fileName);
  if (existing) {
    try {
      return { entry: existing, bytes: await readLibraryFile(fileName) };
    } catch {
      // file missing on disk: fetch again
    }
  }
  let bytes: Uint8Array;
  if (ref.source === "pdmx") {
    bytes = await readPdmxMidi(ref.id);
  } else {
    const res = await fetch(ref.url);
    if (!res.ok) throw new Error(`Download falhou (${res.status})`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  return { entry: await addToLibrary(ref, fileName, bytes), bytes };
}
