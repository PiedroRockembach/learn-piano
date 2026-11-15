import type { Http } from "./platform";
import { queryWords, type Candidate, type CandidateSource } from "./search";

const BITMIDI = "https://bitmidi.com";

interface BitmidiHit {
  id: number;
  name: string;
  alternateNames?: string[];
  downloadUrl: string;
  plays: number;
}

async function fetchPage(http: Http, query: string, page: number): Promise<{ pageTotal: number; results: BitmidiHit[] }> {
  const url = `${BITMIDI}/api/midi/search?q=${encodeURIComponent(query)}&page=${page}`;
  return (await http.json<{ result: { pageTotal: number; results: BitmidiHit[] } }>(url)).result;
}

async function fetchAllPages(http: Http, query: string, maxPages: number): Promise<BitmidiHit[]> {
  const first = await fetchPage(http, query, 0);
  const rest = await Promise.all(
    Array.from({ length: Math.min(first.pageTotal, maxPages) - 1 }, (_, i) =>
      fetchPage(http, query, i + 1).then((r) => r.results, () => []),
    ),
  );
  return [first.results, ...rest].flat();
}

// BitMIDI matches any single word and sorts by popularity, so we gather wide and let Search re-rank.
export const bitmidiSource =
  (http: Http): CandidateSource =>
  (variant) =>
    bitmidiCandidates(http, variant, queryWords(variant));

async function bitmidiCandidates(http: Http, query: string, words: string[]): Promise<Candidate[]> {
  const glued = words.slice(1).map((w, i) => words[i] + w);
  const batches = await Promise.all([
    fetchAllPages(http, query, 10).catch(() => []),
    ...glued.map((g) => fetchAllPages(http, g, 2).catch(() => [])),
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
