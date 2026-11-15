import { fetchSequenceMidi } from "./onlinesequencer";
import { isMidi, type FileStore, type Http } from "./platform";
import type { LibraryEntry, SongRef } from "./types";

const INDEX = "library.json";

export function libraryFileName(source: string, id: string): string {
  return `${source}-${id.replace(/[^\w.-]+/g, "_").replace(/\.midi?$/i, "")}.mid`;
}

export const titleFromFileName = (name: string) =>
  name
    .replace(/\.midi?$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();

function libraryPath(fileName: string): string {
  if (fileName.includes("/") || fileName.includes("..")) throw new Error("Nome de arquivo inválido");
  return `library/${fileName}`;
}

// Sources a platform can download from besides plain URLs (the desktop's offline PDMX copy).
export type ExtraSource = (ref: SongRef) => Promise<Uint8Array> | null;

export class Library {
  constructor(
    private readonly store: FileStore,
    private readonly http: Http,
    private readonly extra: ExtraSource = () => null,
  ) {}

  async list(): Promise<LibraryEntry[]> {
    try {
      return JSON.parse((await this.store.readText(INDEX)) ?? "[]");
    } catch {
      return [];
    }
  }

  async add(ref: SongRef, fileName: string, bytes: Uint8Array): Promise<LibraryEntry> {
    await this.store.writeBytes(libraryPath(fileName), bytes);
    const entry: LibraryEntry = { ...ref, fileName, addedAt: new Date().toISOString() };
    const index = await this.list();
    await this.store.writeText(INDEX, JSON.stringify([entry, ...index.filter((e) => e.fileName !== fileName)], null, 2));
    return entry;
  }

  read(fileName: string): Promise<Uint8Array> {
    return this.store.readBytes(libraryPath(fileName));
  }

  async remove(fileName: string): Promise<void> {
    const path = libraryPath(fileName);
    const index = await this.list();
    await this.store.writeText(INDEX, JSON.stringify(index.filter((e) => e.fileName !== fileName), null, 2));
    await this.store.remove(path);
  }

  // Re-importing the same origin replaces its earlier copy instead of duplicating the entry.
  async importLocal(name: string, origin: string, bytes: Uint8Array): Promise<LibraryEntry> {
    if (!isMidi(bytes)) throw new Error("O arquivo não é um MIDI válido");
    const existing = (await this.list()).find((e) => e.source === "local" && e.url === origin);
    const id = existing?.id ?? `${Date.now()}`;
    return this.add(
      { source: "local", id, title: titleFromFileName(name), url: origin, detail: "Arquivo local" },
      existing?.fileName ?? libraryFileName("local", `${id}-${name}`),
      bytes,
    );
  }

  async importOnlineSequence(id: string, title: string): Promise<LibraryEntry> {
    const bytes = await fetchSequenceMidi(this.http, id);
    return this.add(
      { source: "onlinesequencer", id, title, url: `https://onlinesequencer.net/${id}`, detail: `Online Sequencer · #${id}` },
      libraryFileName("onlinesequencer", id),
      bytes,
    );
  }

  async download(ref: SongRef): Promise<{ entry: LibraryEntry; bytes: Uint8Array }> {
    const fileName = libraryFileName(ref.source, ref.id);
    const existing = (await this.list()).find((e) => e.fileName === fileName);
    if (existing) {
      try {
        return { entry: existing, bytes: await this.read(fileName) };
      } catch {
        // file missing on disk: fetch again
      }
    }
    const bytes = await (this.extra(ref) ?? this.http.bytes(ref.url));
    return { entry: await this.add(ref, fileName, bytes), bytes };
  }
}
