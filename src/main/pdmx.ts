import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize as normalizePath } from "node:path";
import { pdmxDir } from "./paths";
import { normalize, type Candidate } from "./search";

// [title, artist, midPath, views, pianoOnly]
type Row = [string, string, string, number, 0 | 1];

let rows: Row[] | null = null;
let searchable: string[] = [];

function load(): Row[] {
  if (rows) return rows;
  const file = join(pdmxDir, "index.json");
  if (!existsSync(file)) return [];
  rows = (JSON.parse(readFileSync(file, "utf8")) as { rows: Row[] }).rows;
  searchable = rows.map((r) => normalize(`${r[0]} ${r[1]}`).replace(/ /g, ""));
  return rows;
}

export function pdmxAvailable(): boolean {
  return load().length > 0;
}

export function pdmxCandidates(words: string[], required: number): Candidate[] {
  const all = load();
  const out: Candidate[] = [];
  for (let i = 0; i < all.length; i++) {
    const text = searchable[i];
    if (words.filter((w) => text.includes(w)).length < required) continue;
    const [title, artist, path, views, pianoOnly] = all[i];
    out.push({
      ref: {
        source: "pdmx",
        id: path,
        title,
        url: "",
        detail: `${artist ? `${artist} · ` : ""}PDMX · ${views.toLocaleString("pt-BR")} visualizações`,
      },
      names: [title, `${title} ${artist}`],
      popularity: views,
      bonus: 1 + pianoOnly * 2,
    });
  }
  return out;
}

export async function readPdmxMidi(relPath: string): Promise<Uint8Array> {
  const safe = normalizePath(relPath);
  if (safe.startsWith("..") || safe.startsWith("/")) throw new Error("Caminho inválido");
  return new Uint8Array(await readFile(join(pdmxDir, safe)));
}
