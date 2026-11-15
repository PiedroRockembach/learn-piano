import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { FileStore, Http } from "../shared/platform";

export const nodeHttp: Http = {
  async bytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download falhou (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async json(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Requisição falhou (${res.status})`);
    return res.json();
  },
};

export function nodeStore(root: string): FileStore {
  const resolve = (path: string) => {
    const safe = normalize(path);
    if (safe.startsWith("..") || safe.startsWith("/")) throw new Error("Caminho inválido");
    return join(root, safe);
  };
  return {
    async readText(path) {
      try {
        return await readFile(resolve(path), "utf8");
      } catch {
        return null;
      }
    },
    async writeText(path, text) {
      const file = resolve(path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    },
    async readBytes(path) {
      return new Uint8Array(await readFile(resolve(path)));
    },
    async writeBytes(path, bytes) {
      const file = resolve(path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
    },
    async remove(path) {
      await rm(resolve(path), { force: true });
    },
  };
}
