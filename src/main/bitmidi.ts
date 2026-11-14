import type { Candidate } from "./search";

const BITMIDI = "https://bitmidi.com";

interface BitmidiHit {
  id: number;
  name: string;
  alternateNames?: string[];
  downloadUrl: string;
  plays: number;
}

async function fetchPage(query: string, page: number): Promise<{ pageTotal: number; results: BitmidiHit[] }> {
  const res = await fetch(`${BITMIDI}/api/midi/search?q=${encodeURIComponent(query)}&page=${page}`);
  if (!res.ok) throw new Error(`BitMIDI respondeu ${res.status}`);
  return ((await res.json()) as { result: { pageTotal: number; results: BitmidiHit[] } }).result;
}

async function fetchAllPages(query: string, maxPages: number): Promise<BitmidiHit[]> {
  const first = await fetchPage(query, 0);
  const rest = await Promise.all(
    Array.from({ length: Math.min(first.pageTotal, maxPages) - 1 }, (_, i) =>
      fetchPage(query, i + 1).then((r) => r.results, () => []),
    ),
  );
  return [first.results, ...rest].flat();
}

// BitMIDI matches any single word and sorts by popularity, so we gather wide and let search.ts re-rank.
export async function bitmidiCandidates(query: string, words: string[]): Promise<Candidate[]> {
  const glued = words.slice(1).map((w, i) => words[i] + w);
  const batches = await Promise.all([
    fetchAllPages(query, 10).catch(() => []),
    ...glued.map((g) => fetchAllPages(g, 2).catch(() => [])),
  ]);
  const hits = new Map<number, BitmidiHit>();
  for (const h of batches.flat()) hits.set(h.id, h);
  return [...hits.values()].map((h) => ({
    ref: {
      source: "bitmidi",
      id: String(h.id),
      title: h.name.replace(/\.midi?$/i, ""),
      url: BITMIDI + h.downloadUrl,
      detail: `BitMIDI · ${h.plays.toLocaleString("pt-BR")} reproduções`,
    },
    names: [h.name, ...(h.alternateNames ?? [])],
    popularity: h.plays,
    bonus: 0,
  }));
}
