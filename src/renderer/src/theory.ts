import type { ConvertedScore } from "./score/convert";
import {
  chordName,
  chordPcs,
  MAJOR_SCALE,
  MINOR_SCALE,
  pcName,
  QUALITIES,
  type ChordEvent,
  type HarmonyAnalysis,
  type Mode,
  type Quality,
} from "./score/harmony";

const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII"];
const PT_NAMES: Record<string, string> = { C: "Dó", D: "Ré", E: "Mi", F: "Fá", G: "Sol", A: "Lá", B: "Si" };
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

const FUNCTIONS: Record<Mode, string[]> = {
  major: ["T", "S", "T", "S", "D", "T", "D"],
  minor: ["T", "S", "T", "S", "D", "S", "D"],
};
const FUNCTION_NAMES: Record<string, string> = { T: "Tônica", S: "Subdominante", D: "Dominante" };

interface NamedProgression {
  mode: Mode;
  romans: string[];
  name: string;
  about: string;
}

const NAMED: NamedProgression[] = [
  { mode: "major", romans: ["I", "V", "vi", "IV"], name: "Progressão pop", about: "a sequência mais usada do pop; centenas de músicas cabem nesses quatro acordes." },
  { mode: "major", romans: ["vi", "IV", "I", "V"], name: "Pop começando no vi", about: "os mesmos acordes da I–V–vi–IV, mas partindo do relativo menor: soa mais melancólica." },
  { mode: "major", romans: ["I", "vi", "IV", "V"], name: "Anos 50 (doo-wop)", about: "clássica de baladas dos anos 50 e 60." },
  { mode: "major", romans: ["IV", "V", "iii", "vi"], name: "Royal Road", about: "muito comum em J-pop e aberturas de anime: sobe para a dominante e cai no relativo menor." },
  { mode: "major", romans: ["ii", "V", "I"], name: "ii–V–I", about: "preparação, tensão e resolução; a cadência mais importante do jazz." },
  { mode: "major", romans: ["I", "IV", "V"], name: "I–IV–V", about: "os três acordes principais (uma de cada função); base do rock e do blues." },
  { mode: "minor", romans: ["i", "VI", "III", "VII"], name: "Pop em menor", about: "versão menor da progressão pop (mesmos acordes, outro centro)." },
  { mode: "minor", romans: ["i", "VII", "VI", "V"], name: "Cadência andaluza", about: "descida pelo baixo até a dominante; típica do flamenco." },
  { mode: "minor", romans: ["VI", "VII", "i"], name: "Subida épica", about: "VI–VII–i, sobe por graus até a tônica; comum em trilhas e rock." },
  { mode: "minor", romans: ["ii°", "V", "i"], name: "ii°–V–i", about: "a cadência ii–V–I no modo menor." },
  { mode: "minor", romans: ["i", "iv", "V"], name: "i–iv–V", about: "as três funções no modo menor, com a dominante maior da menor harmônica." },
];

interface Analyzed {
  chord: ChordEvent;
  roman: string;
  base: string;
  kind: string;
  degree: number | null;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function ptName(pc: number, fifths: number): string {
  const name = pcName(pc, fifths);
  return PT_NAMES[name[0]] + name.slice(1);
}

const HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11];

function scaleOf(mode: Mode): number[] {
  return mode === "major" ? MAJOR_SCALE : MINOR_SCALE;
}

function degreeOf(interval: number, mode: Mode): { deg: number; acc: string } {
  const scale = scaleOf(mode);
  const exact = scale.indexOf(interval);
  if (exact >= 0) return { deg: exact, acc: "" };
  if (mode === "minor" && interval === 11) return { deg: 6, acc: "" };
  const preferSharp = mode === "minor" ? interval !== 1 : interval === 6;
  const below = scale.indexOf(interval - 1);
  const above = scale.indexOf((interval + 1) % 12);
  if (preferSharp && below >= 0) return { deg: below, acc: "♯" };
  if (above >= 0) return { deg: above, acc: "♭" };
  return { deg: below, acc: "♯" };
}

const ROMAN_SUFFIX: Record<string, string> = {
  diminished: "°",
  "half-diminished": "ø7",
  "diminished-seventh": "°7",
  augmented: "+",
  dominant: "7",
  "minor-seventh": "7",
  "major-seventh": "maj7",
  "major-sixth": "6",
  "minor-sixth": "6",
  "suspended-fourth": "sus4",
  "suspended-second": "sus2",
};

function numeral(deg: number, q: Quality): string {
  return q.minor ? NUMERALS[deg].toLowerCase() : NUMERALS[deg];
}

function baseRoman(deg: number, acc: string, q: Quality): string {
  const dim = q.kind === "diminished" || q.kind === "half-diminished" || q.kind === "diminished-seventh" ? "°" : "";
  return acc + numeral(deg, q) + dim;
}

function qualityOf(intervals: number[]): Quality {
  return QUALITIES.find((q) => q.intervals.length === intervals.length && q.intervals.every((i, k) => i === intervals[k]))!;
}

function fieldChord(deg: number, scale: number[], size: 3 | 4): { root: number; quality: Quality } {
  const root = scale[deg];
  const intervals = [0, 2, 4, 6].slice(0, size).map((step) => (scale[(deg + step) % 7] - root + 12) % 12);
  return { root, quality: qualityOf(intervals) };
}

function classify(c: ChordEvent, h: HarmonyAnalysis): Analyzed {
  const interval = (c.root - h.tonic + 12) % 12;
  const scale = scaleOf(h.mode).map((d) => (h.tonic + d) % 12);
  const allowed = new Set(scale);
  if (h.mode === "minor") allowed.add((h.tonic + 11) % 12);
  const pcs = chordPcs(c.root, c.quality);
  const { deg, acc } = degreeOf(interval, h.mode);
  // Sus chords have no third; name them after the diatonic triad of their degree.
  const shape = c.quality.kind.startsWith("suspended") && !acc ? fieldChord(deg, scaleOf(h.mode), 3).quality : c.quality;
  const roman = acc + numeral(deg, shape) + (ROMAN_SUFFIX[c.quality.kind] ?? "");
  const base = baseRoman(deg, acc, shape);

  if (pcs.every((pc) => allowed.has(pc))) return { chord: c, roman, base, kind: "diatônico", degree: acc ? null : deg };

  const target = (c.root + 5) % 12;
  const targetInterval = (target - h.tonic + 12) % 12;
  const targetDeg = scaleOf(h.mode).indexOf(targetInterval);
  const targetTriad = targetDeg >= 0 ? fieldChord(targetDeg, scaleOf(h.mode), 3).quality : null;
  const dominantLike = c.quality.kind === "major" || c.quality.kind === "dominant";
  if (dominantLike && targetDeg > 0 && targetTriad && targetTriad.kind !== "diminished") {
    const v = c.quality.kind === "dominant" ? "V7" : "V";
    const label = `${v}/${numeral(targetDeg, targetTriad)}`;
    return { chord: c, roman: label, base: label, kind: `dominante secundária (prepara o ${numeral(targetDeg, targetTriad)})`, degree: null };
  }

  const parallel: Mode = h.mode === "major" ? "minor" : "major";
  const parallelSet = new Set(scaleOf(parallel).map((d) => (h.tonic + d) % 12));
  if (pcs.every((pc) => parallelSet.has(pc))) {
    return { chord: c, roman, base, kind: `empréstimo modal (do modo ${parallel === "minor" ? "menor" : "maior"})`, degree: null };
  }
  return { chord: c, roman, base, kind: "cromático", degree: null };
}

function keyName(h: HarmonyAnalysis): string {
  return `${ptName(h.tonic, h.fifths)} ${h.mode === "major" ? "maior" : "menor"}`;
}

function signatureText(fifths: number): string {
  if (fifths === 0) return "sem sustenidos nem bemóis";
  const n = Math.abs(fifths);
  const list = (fifths > 0 ? SHARP_ORDER : FLAT_ORDER).slice(0, n).map((s) => s + (fifths > 0 ? "♯" : "♭"));
  return `${n} ${fifths > 0 ? (n > 1 ? "sustenidos" : "sustenido") : n > 1 ? "bemóis" : "bemol"} (${list.join(" ")})`;
}

function measureIndex(h: HarmonyAnalysis, unit: number): number {
  let lo = 0;
  let hi = h.measures.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (h.measures[mid].start <= unit) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function countSequence(seq: string[], pattern: string[]): number[] {
  const at: number[] = [];
  for (let i = 0; i + pattern.length <= seq.length; i++) {
    if (pattern.every((p, k) => seq[i + k] === p)) at.push(i);
  }
  return at;
}

export function renderTheory(el: HTMLElement, score: ConvertedScore | null): void {
  if (!score || !score.harmony.chords.length) {
    el.innerHTML = `<p class="theory-empty">${score ? "Não encontrei acordes nesta partitura (só melodia?)." : "Abra uma música para ver a teoria por trás dela."}</p>`;
    return;
  }
  const h = score.harmony;
  const analyzed = h.chords.map((c) => classify(c, h));
  const totalUnits = h.chords.reduce((s, c) => s + c.end - c.unit, 0) || 1;
  const scale = scaleOf(h.mode);
  const meterCount = new Map<string, number>();
  for (const m of h.measures) meterCount.set(`${m.beats}/${m.beatType}`, (meterCount.get(`${m.beats}/${m.beatType}`) ?? 0) + 1);
  const meter = [...meterCount].sort((a, b) => b[1] - a[1])[0][0];
  const relative = h.mode === "major" ? (h.tonic + 9) % 12 : (h.tonic + 3) % 12;

  const sections: string[] = [];

  sections.push(`
    <section>
      <h3>Tonalidade</h3>
      <p class="big">${keyName(h)} <span class="muted">(${pcName(h.tonic, h.fifths)}${h.mode === "minor" ? "m" : ""})</span></p>
      <p>Armadura: ${signatureText(h.fifths)} · relativa ${h.mode === "major" ? "menor" : "maior"}: ${ptName(relative, h.fifths)} ${h.mode === "major" ? "menor" : "maior"} · compasso ${meter} · ${score.bpm} bpm</p>
      <p class="hint">A tonalidade é o “centro de gravidade” da música: a nota e o acorde onde as frases repousam. A armadura no início da pauta mostra quais notas são alteradas o tempo todo. Toda tonalidade maior tem uma relativa menor com a mesma armadura (3 semitons abaixo); a diferença é qual acorde funciona como casa.</p>
    </section>`);

  const steps = scale.map((d, i) => {
    const next = i === 6 ? 12 : scale[i + 1];
    return next - d === 2 ? "T" : next - d === 1 ? "S" : "T+S";
  });
  sections.push(`
    <section>
      <h3>Escala de ${keyName(h)}</h3>
      <div class="scale">${scale
        .map((d, i) => `<div class="degree"><b>${ptName((h.tonic + d) % 12, h.fifths)}</b><small>${i + 1}º grau</small></div>`)
        .join("")}</div>
      <p>Fórmula: ${steps.join(" – ")} <span class="muted">(T = tom, S = semitom)</span></p>
      <p class="hint">${
        h.mode === "major"
          ? "A escala maior segue sempre T T S T T T S, partindo de qualquer nota. As notas dela são as teclas “seguras” para a melodia e formam os acordes da música."
          : `A menor natural segue T S T T S T T. Na prática a música menor costuma subir o 7º grau (${ptName((h.tonic + 11) % 12, h.fifths)}) para criar uma sensível que puxa para a tônica: é a escala menor harmônica.`
      }</p>
    </section>`);

  const usage = new Array(7).fill(0);
  analyzed.forEach((a) => {
    if (a.degree !== null) usage[a.degree] += a.chord.end - a.chord.unit;
  });
  const nameOf = (c: { root: number; quality: Quality }) =>
    chordName({ unit: 0, end: 0, root: (h.tonic + c.root) % 12, quality: c.quality, bass: null }, h.fifths);
  const rows = scale.map((_, deg) => {
    const tri = fieldChord(deg, scale, 3);
    const tet = fieldChord(deg, scale, 4);
    let numeralText = baseRoman(deg, "", tri.quality);
    let triName = nameOf(tri);
    let tetName = nameOf(tet);
    // In minor, V and vii° from the harmonic minor are as common as the natural v and VII.
    if (h.mode === "minor" && (deg === 4 || deg === 6)) {
      const hTri = fieldChord(deg, HARMONIC_MINOR, 3);
      const hTet = fieldChord(deg, HARMONIC_MINOR, 4);
      numeralText += ` / ${baseRoman(deg, "", hTri.quality)}`;
      triName += ` / ${nameOf(hTri)}`;
      tetName += ` / ${nameOf(hTet)}`;
    }
    const fn = FUNCTIONS[h.mode][deg];
    const share = Math.round((usage[deg] / totalUnits) * 100);
    return `<tr class="${share ? "used" : ""}"><td>${numeralText}</td><td>${triName}</td><td>${tetName}</td><td><span class="fn fn-${fn}">${FUNCTION_NAMES[fn]}</span></td><td>${share ? `${share}%` : "—"}</td></tr>`;
  });
  sections.push(`
    <section>
      <h3>Campo harmônico</h3>
      <table class="field"><thead><tr><th>Grau</th><th>Tríade</th><th>Tétrade</th><th>Função</th><th>Na música</th></tr></thead><tbody>${rows.join("")}</tbody></table>
      <p class="hint">Empilhando terças (nota sim, nota não) sobre cada grau da escala saem os 7 acordes “da casa”. Algarismo romano maiúsculo = acorde maior, minúsculo = menor, ° = diminuto. Cada um tem uma função: <b>tônica</b> (repouso), <b>subdominante</b> (afasta da casa) e <b>dominante</b> (tensão que pede volta à tônica).${
        h.mode === "minor" ? " No modo menor, o V costuma aparecer maior (V ou V7, da menor harmônica) para resolver com mais força no i." : ""
      }</p>
    </section>`);

  const byName = new Map<string, { a: Analyzed; units: number; count: number }>();
  for (const a of analyzed) {
    const key = chordName({ ...a.chord, bass: null }, h.fifths);
    const entry = byName.get(key) ?? { a, units: 0, count: 0 };
    entry.units += a.chord.end - a.chord.unit;
    entry.count++;
    byName.set(key, entry);
  }
  const chordRows = [...byName]
    .sort((x, y) => y[1].units - x[1].units)
    .map(
      ([name, e]) =>
        `<tr><td class="chord">${escapeHtml(name)}</td><td>${e.a.roman}</td><td>${Math.round((e.units / totalUnits) * 100)}%</td><td class="${e.a.kind === "diatônico" ? "muted" : "accent"}">${e.a.kind}</td></tr>`,
    );
  sections.push(`
    <section>
      <h3>Acordes usados</h3>
      <table class="chords"><thead><tr><th>Acorde</th><th>Grau</th><th>Tempo</th><th>Origem</th></tr></thead><tbody>${chordRows.join("")}</tbody></table>
      <p class="hint">Acordes de fora do campo harmônico têm motivo: a <b>dominante secundária</b> (V/x) é a dominante de outro grau e cria tensão em direção a ele; o <b>empréstimo modal</b> pega um acorde do modo paralelo (ex.: o iv menor numa música maior) para mudar a cor.</p>
    </section>`);

  const seq: Analyzed[] = [];
  for (const a of analyzed) if (!seq.length || seq[seq.length - 1].base !== a.base) seq.push(a);
  const bases = seq.map((a) => a.base);

  const named = NAMED.filter((n) => n.mode === h.mode)
    .map((n) => ({ n, at: countSequence(bases, n.romans) }))
    .filter((x) => x.at.length > 0)
    .sort((x, y) => y.at.length - x.at.length);
  const loops = new Map<string, number[]>();
  for (let i = 0; i + 4 <= bases.length; i++) {
    const slice = bases.slice(i, i + 4);
    if (new Set(slice).size < 3) continue;
    const key = slice.join(" – ");
    loops.set(key, [...(loops.get(key) ?? []), i]);
  }
  const isRotation = (a: string, b: string) => {
    const x = a.split(" – ");
    const y = b.split(" – ");
    return x.some((_, r) => x.every((v, k) => v === y[(k + r) % y.length]));
  };
  const topLoops: [string, number[]][] = [];
  for (const entry of [...loops].filter(([, at]) => at.length >= 2).sort((x, y) => y[1].length - x[1].length)) {
    if (topLoops.length < 4 && !topLoops.some(([key]) => isRotation(key, entry[0]))) topLoops.push(entry);
  }
  const example = (i: number, len: number) =>
    seq
      .slice(i, i + len)
      .map((a) => chordName({ ...a.chord, bass: null }, h.fifths))
      .join(" – ");
  const where = (i: number) => `compasso ${measureIndex(h, seq[i].chord.unit) + 1}`;

  sections.push(`
    <section>
      <h3>Progressões</h3>
      ${
        topLoops.length
          ? `<ul class="loops">${topLoops
              .map(([key, at]) => `<li><b>${key}</b> <span class="muted">×${at.length} · ex.: ${escapeHtml(example(at[0], 4))} (${where(at[0])})</span></li>`)
              .join("")}</ul>`
          : `<p class="muted">Nenhuma sequência de 4 acordes se repete.</p>`
      }
      ${
        named.length
          ? `<h4>Progressões conhecidas</h4><ul class="loops">${named
              .map(
                ({ n, at }) =>
                  `<li><b>${n.name}</b> (${n.romans.join("–")}) <span class="muted">×${at.length}, primeira no ${where(at[0])}</span><br>${n.about}</li>`,
              )
              .join("")}</ul>`
          : ""
      }
      <p class="hint">Progressão é a ordem em que os acordes aparecem. Escrevendo em graus (I, IV, V…) em vez de nomes, a mesma progressão vale em qualquer tonalidade: é assim que dá para perceber que músicas diferentes usam o mesmo “esqueleto”.</p>
    </section>`);

  const tonicBase = h.mode === "major" ? "I" : "i";
  const cadenceDefs = [
    { name: "Autêntica (V → I)", from: ["V", "vii°"], to: [tonicBase], about: "tensão da dominante resolvida na tônica; fecha frases com sensação de final." },
    { name: "Plagal (IV → I)", from: ["IV", "iv"], to: [tonicBase], about: "resolução suave da subdominante para a tônica (o “amém” das igrejas)." },
    h.mode === "minor"
      ? { name: "Eólia (VII → i)", from: ["VII"], to: [tonicBase], about: "resolve na tônica pelo acorde um tom abaixo dela, sem a sensível; som típico do pop e do rock em tom menor." }
      : { name: "Modal (♭VII → I)", from: ["♭VII"], to: [tonicBase], about: "chega na tônica pelo acorde um tom abaixo, emprestado do modo menor; som de rock." },
    { name: "Deceptiva (V → vi)", from: ["V"], to: [h.mode === "major" ? "vi" : "VI"], about: "o ouvido espera a tônica e recebe o relativo; surpresa que prolonga a frase." },
  ];
  const cadences = cadenceDefs
    .map((d) => {
      const at: number[] = [];
      for (let i = 0; i + 1 < seq.length; i++) if (d.from.includes(seq[i].base) && d.to.includes(seq[i + 1].base)) at.push(i + 1);
      return { d, at };
    })
    .filter((x) => x.at.length);
  sections.push(`
    <section>
      <h3>Cadências</h3>
      ${
        cadences.length
          ? `<ul class="loops">${cadences
              .map(
                ({ d, at }) =>
                  `<li><b>${d.name}</b> <span class="muted">×${at.length} · compassos ${at
                    .slice(0, 8)
                    .map((i) => measureIndex(h, seq[i].chord.unit) + 1)
                    .join(", ")}${at.length > 8 ? "…" : ""}</span><br>${d.about}</li>`,
              )
              .join("")}</ul>`
          : `<p class="muted">Nenhuma cadência clássica encontrada.</p>`
      }
      <p class="hint">Cadência é o “sinal de pontuação” da música: a dupla de acordes que encerra uma frase.</p>
    </section>`);

  let current = "";
  const cells = h.measures.map((m, i) => {
    const inside = analyzed.filter((a) => a.chord.unit >= m.start && a.chord.unit < m.start + m.length);
    if (!inside.length) {
      return `<div class="bar"><small>${i + 1}</small><span class="muted">${current ? escapeHtml(current) : "—"}</span></div>`;
    }
    current = chordName(inside[inside.length - 1].chord, h.fifths);
    return `<div class="bar"><small>${i + 1}</small>${inside
      .map((a) => `<span><b>${escapeHtml(chordName(a.chord, h.fifths))}</b> <i>${a.roman}</i></span>`)
      .join("")}</div>`;
  });
  sections.push(`
    <section>
      <h3>Mapa harmônico</h3>
      <div class="bars">${cells.join("")}</div>
      <p class="hint">Acordes por compasso. Em cinza, o acorde que continua soando do compasso anterior.</p>
    </section>`);

  sections.push(`<p class="hint">Análise automática a partir das notas do MIDI: notas de passagem, arpejos rápidos e mudanças de tonalidade no meio da música podem confundir a detecção.</p>`);

  el.innerHTML = sections.join("");
}
