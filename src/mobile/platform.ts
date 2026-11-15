import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { FileStore, Http } from "../shared/platform";

function fromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const isNative = Capacitor.isNativePlatform();

// Native requests skip the WebView's CORS checks (BitMIDI and Online Sequencer send no CORS headers).
export const capHttp: Http = {
  async bytes(url) {
    if (!isNative) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download falhou (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    }
    const res = await CapacitorHttp.get({ url, responseType: "arraybuffer" });
    if (res.status >= 400) throw new Error(`Download falhou (${res.status})`);
    return typeof res.data === "string" ? fromBase64(res.data) : new Uint8Array(res.data);
  },
  async json(url) {
    if (!isNative) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Requisição falhou (${res.status})`);
      return res.json();
    }
    const res = await CapacitorHttp.get({ url, responseType: "json" });
    if (res.status >= 400) throw new Error(`Requisição falhou (${res.status})`);
    return typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  },
};

// App-private storage: the library survives updates and is removed with the app.
export const capStore: FileStore = {
  async readText(path) {
    try {
      const { data } = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
      return typeof data === "string" ? data : await data.text();
    } catch {
      return null;
    }
  },
  async writeText(path, text) {
    await Filesystem.writeFile({ path, data: text, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
  },
  async readBytes(path) {
    const { data } = await Filesystem.readFile({ path, directory: Directory.Data });
    return typeof data === "string" ? fromBase64(data) : new Uint8Array(await data.arrayBuffer());
  },
  async writeBytes(path, bytes) {
    await Filesystem.writeFile({ path, data: toBase64(bytes), directory: Directory.Data, recursive: true });
  },
  async remove(path) {
    await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
  },
};
