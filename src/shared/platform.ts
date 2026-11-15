// What the shared core needs from each platform (Node in Electron's main process, Capacitor on Android).
export interface Http {
  bytes(url: string): Promise<Uint8Array>;
  json<T>(url: string): Promise<T>;
}

// Paths are relative to the app's data folder, e.g. "library.json" or "library/x.mid".
export interface FileStore {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export function isMidi(bytes: Uint8Array): boolean {
  return bytes.length >= 14 && String.fromCharCode(...bytes.subarray(0, 4)) === "MThd";
}
