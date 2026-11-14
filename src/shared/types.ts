export type SourceId = "bitmidi" | "pdmx" | "browser";

export interface SongRef {
  source: SourceId;
  id: string;
  title: string;
  url: string;
  detail?: string;
}

export interface SearchPage {
  total: number;
  pageTotal: number;
  items: SongRef[];
}

export interface LibraryEntry extends SongRef {
  fileName: string;
  addedAt: string;
}

export interface LearnPianoApi {
  search(query: string, page: number): Promise<SearchPage>;
  download(ref: SongRef): Promise<{ entry: LibraryEntry; bytes: Uint8Array }>;
  listLibrary(): Promise<LibraryEntry[]>;
  readLibrary(fileName: string): Promise<Uint8Array>;
  status(): Promise<{ pdmx: boolean }>;
  openBrowser(url: string): Promise<void>;
  onImported(cb: (entry: LibraryEntry) => void): void;
}
