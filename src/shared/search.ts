import type { SearchPage, SongRef } from "./types";

export interface Candidate {
  ref: SongRef;
  names: string[];
  popularity: number;
  bonus: number;
}

// A source of candidates for one query variant; `words` are the significant words, `required` how many must match.
export type CandidateSource = (variant: string, words: string[], required: number) => Promise<Candidate[]> | Candidate[];

const PAGE_SIZE = 20;

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

// Alternative titles (e.g. Brazilian dub → original).
export const DEFAULT_ALIASES: Record<string, string[]> = {
  "sorriso resplandecente": ["dan dan hikareteku", "dan dan kokoro hikareteku", "dragonball gt"],
};

export function expandWithAliases(query: string, aliases: Record<string, string[]>): string[] {
  const q = normalize(query);
  const variants = [query];
  for (const [title, alts] of Object.entries(aliases)) {
    const t = normalize(title);
    if (q === t || (q.length >= 4 && (t.includes(q) || q.includes(t)))) variants.push(...alts);
  }
  return [...new Set(variants)];
}

function score(words: string[], c: Candidate): { matched: number; value: number } {
  const normalized = c.names.map(normalize);
  const tokens = new Set(normalized.flatMap((n) => n.split(" ")));
  const compact = normalized.map((n) => n.replace(/ /g, ""));
  const matches = (w: string) => tokens.has(w) || (w.length >= 4 && compact.some((n) => n.includes(w)));
  const matched = words.filter(matches).length;
  const phrase = compact.some((n) => n.includes(words.join(""))) ? 1 : 0;
  return { matched, value: phrase * 100 + matched * 10 + Math.log10(c.popularity + 1) + c.bonus };
}

export class Search {
  private readonly cache = new Map<string, SongRef[]>();

  constructor(
    private readonly sources: CandidateSource[],
    private readonly aliases: () => Record<string, string[]>,
  ) {}

  private async ranked(query: string): Promise<SongRef[]> {
    const best = new Map<string, { ref: SongRef; value: number }>();
    for (const variant of expandWithAliases(query, this.aliases())) {
      const words = significantWords(queryWords(variant));
      if (!words.length) continue;
      const required = words.length <= 3 ? words.length : words.length - 1;
      const batches = await Promise.all(this.sources.map((source) => source(variant, words, required)));
      for (const c of batches.flat()) {
        const s = score(words, c);
        if (s.matched < required) continue;
        const key = `${c.ref.source}:${c.ref.id}`;
        const prev = best.get(key);
        if (!prev || prev.value < s.value) best.set(key, { ref: c.ref, value: s.value });
      }
    }
    return [...best.values()].sort((a, b) => b.value - a.value).map((x) => x.ref);
  }

  async page(query: string, page: number): Promise<SearchPage> {
    const key = normalize(query);
    let all = this.cache.get(key);
    if (!all) {
      all = await this.ranked(query);
      this.cache.set(key, all);
    }
    return {
      total: all.length,
      pageTotal: Math.max(1, Math.ceil(all.length / PAGE_SIZE)),
      items: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    };
  }
}
