import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { aliasesFile } from "./paths";
import { normalize } from "./search";

// Alternative titles (e.g. Brazilian dub → original). Users edit this file directly.
const DEFAULT_ALIASES: Record<string, string[]> = {
  "sorriso resplandecente": ["dan dan hikareteku", "dan dan kokoro hikareteku", "dragonball gt"],
};

function loadAliases(): Record<string, string[]> {
  if (!existsSync(aliasesFile)) {
    mkdirSync(dirname(aliasesFile), { recursive: true });
    writeFileSync(aliasesFile, JSON.stringify(DEFAULT_ALIASES, null, 2) + "\n");
    return DEFAULT_ALIASES;
  }
  try {
    return JSON.parse(readFileSync(aliasesFile, "utf8"));
  } catch {
    return DEFAULT_ALIASES;
  }
}

export function expandWithAliases(query: string): string[] {
  const q = normalize(query);
  const variants = [query];
  for (const [title, alts] of Object.entries(loadAliases())) {
    const t = normalize(title);
    if (q === t || (q.length >= 4 && (t.includes(q) || q.includes(t)))) variants.push(...alts);
  }
  return [...new Set(variants)];
}
