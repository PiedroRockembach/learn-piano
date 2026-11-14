import type { SearchPage, SongRef } from "../shared/types";
import { expandWithAliases } from "./aliases";
import { bitmidiCandidates } from "./bitmidi";
import { pdmxCandidates } from "./pdmx";

export interface Candidate {
  ref: SongRef;
  names: string[];
  popularity: number;
  bonus: number;
}

const PAGE_SIZE = 20;
const cache = new Map<string, SongRef[]>();

export const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.midi?$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const queryWords = (q: string) => normalize(q).split(" ").filter(Boolean);

const STOPWORDS = new Set(["the", "and", "of", "a", "an", "to", "in", "on", "for", "de", "do", "da", "dos", "das", "e", "o", "os", "as", "um", "uma"]);

// Words that must match; short words and articles only add noise (e.g. "us" inside "music").
export const significantWords = (words: string[]) => {
  const sig = words.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return sig.length ? sig : words;
};

function score(words: string[], c: Candidate): { matched: number; value: number } {
  const normalized = c.names.map(normalize);
  const tokens = new Set(normalized.flatMap((n) => n.split(" ")));
  const compact = normalized.map((n) => n.replace(/ /g, ""));
  const matches = (w: string) => tokens.has(w) || (w.length >= 4 && compact.some((n) => n.includes(w)));
  const matched = words.filter(matches).length;
  const phrase = compact.some((n) => n.includes(words.join(""))) ? 1 : 0;
  return { matched, value: phrase * 100 + matched * 10 + Math.log10(c.popularity + 1) + c.bonus };
}

async function rankedSearch(query: string): Promise<SongRef[]> {
  const best = new Map<string, { ref: SongRef; value: number }>();
  for (const variant of expandWithAliases(query)) {
    const words = significantWords(queryWords(variant));
    if (!words.length) continue;
    const required = words.length <= 3 ? words.length : words.length - 1;
    const candidates = [...pdmxCandidates(words, required), ...(await bitmidiCandidates(variant, queryWords(variant)))];
    for (const c of candidates) {
      const s = score(words, c);
      if (s.matched < required) continue;
      const key = `${c.ref.source}:${c.ref.id}`;
      const prev = best.get(key);
      if (!prev || prev.value < s.value) best.set(key, { ref: c.ref, value: s.value });
    }
  }
  return [...best.values()].sort((a, b) => b.value - a.value).map((x) => x.ref);
}

export async function search(query: string, page: number): Promise<SearchPage> {
  const key = normalize(query);
  let all = cache.get(key);
  if (!all) {
    all = await rankedSearch(query);
    cache.set(key, all);
  }
  return {
    total: all.length,
    pageTotal: Math.max(1, Math.ceil(all.length / PAGE_SIZE)),
    items: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
  };
}

export function clearSearchCache(): void {
  cache.clear();
}
