export interface TimedNote {
  pitch: number;
  start: number;
  end: number;
}

export interface MeasureSpan {
  start: number;
  length: number;
  beats: number;
  beatType: number;
}

export interface Quality {
  kind: string;
  suffix: string;
  intervals: number[];
  minor: boolean;
  rarity: number;
}

export interface ChordEvent {
  unit: number;
  end: number;
  root: number;
  quality: Quality;
  bass: number | null;
}

export type Mode = "major" | "minor";

export interface HarmonyAnalysis {
  fifths: number;
  mode: Mode;
  tonic: number;
  chords: ChordEvent[];
  measures: MeasureSpan[];
}

// Suffixes mirror OSMD's default chord labels so the theory tab matches the score.
export const QUALITIES: Quality[] = [
  { kind: "major", suffix: "", intervals: [0, 4, 7], minor: false, rarity: 0 },
  { kind: "minor", suffix: "m", intervals: [0, 3, 7], minor: true, rarity: 0 },
  { kind: "dominant", suffix: "7", intervals: [0, 4, 7, 10], minor: false, rarity: 0.03 },
  { kind: "minor-seventh", suffix: "m7", intervals: [0, 3, 7, 10], minor: true, rarity: 0.03 },
  { kind: "major-seventh", suffix: "maj7", intervals: [0, 4, 7, 11], minor: false, rarity: 0.06 },
  { kind: "suspended-fourth", suffix: "sus4", intervals: [0, 5, 7], minor: false, rarity: 0.1 },
  { kind: "suspended-second", suffix: "sus2", intervals: [0, 2, 7], minor: false, rarity: 0.12 },
  { kind: "diminished", suffix: "dim", intervals: [0, 3, 6], minor: true, rarity: 0.06 },
  { kind: "half-diminished", suffix: "m7♭5", intervals: [0, 3, 6, 10], minor: true, rarity: 0.06 },
  { kind: "diminished-seventh", suffix: "dim7", intervals: [0, 3, 6, 9], minor: true, rarity: 0.1 },
  { kind: "augmented", suffix: "aug", intervals: [0, 4, 8], minor: false, rarity: 0.12 },
  { kind: "major-sixth", suffix: "maj6", intervals: [0, 4, 7, 9], minor: false, rarity: 0.12 },
  { kind: "minor-sixth", suffix: "m6", intervals: [0, 3, 7, 9], minor: true, rarity: 0.12 },
];

export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

const SHARP_SPELLING: [string, number][] = [
  ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];
const FLAT_SPELLING: [string, number][] = [
  ["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0],
];

export function spell(pitch: number, fifths: number): { step: string; alter: number; octave: number } {
  const pc = pitch % 12;
  const octave = Math.floor(pitch / 12) - 1;
  if (fifths >= 6 && pc === 5) return { step: "E", alter: 1, octave };
  if (fifths <= -6 && pc === 11) return { step: "C", alter: -1, octave: octave + 1 };
  const [step, alter] = (fifths >= 0 ? SHARP_SPELLING : FLAT_SPELLING)[pc];
  return { step, alter, octave };
}

export function pcName(pc: number, fifths: number): string {
  const { step, alter } = spell(60 + pc, fifths);
  return step + (alter > 0 ? "♯" : alter < 0 ? "♭" : "");
}

export function chordName(c: ChordEvent, fifths: number): string {
  const bass = c.bass === null ? "" : `/${pcName(c.bass, fifths)}`;
  return pcName(c.root, fifths) + c.quality.suffix + bass;
}

export const chordPcs = (root: number, q: Quality) => q.intervals.map((i) => (root + i) % 12);

export function majorTonic(fifths: number): number {
  return (((7 * fifths) % 12) + 12) % 12;
}

export function harmonyXml(c: ChordEvent, fifths: number): string {
  const root = spell(60 + c.root, fifths);
  const bass = c.bass === null ? null : spell(60 + c.bass, fifths);
  return (
    `<harmony print-frame="no"><root><root-step>${root.step}</root-step>` +
    (root.alter ? `<root-alter>${root.alter}</root-alter>` : "") +
    `</root><kind>${c.quality.kind}</kind>` +
    (bass
      ? `<bass><bass-step>${bass.step}</bass-step>${bass.alter ? `<bass-alter>${bass.alter}</bass-alter>` : ""}</bass>`
      : "") +
    `<staff>1</staff></harmony>`
  );
}

interface Window {
  start: number;
  end: number;
  weights: number[];
  inner: number[];
  total: number;
  bassPc: number | null;
  bassShare: number;
}

interface Label {
  root: number;
  quality: Quality;
}

function beatLength(m: MeasureSpan): number {
  const unit = 16 / m.beatType;
  return m.beatType === 8 && m.beats % 3 === 0 ? unit * 3 : unit;
}

function topVoiceFlags(notes: TimedNote[], maxDuration: number): boolean[] {
  return notes.map((n, j) => {
    for (let k = j - 1; k >= 0 && notes[k].start + maxDuration > n.start; k--) {
      if (notes[k].pitch > n.pitch && notes[k].end > n.start) return false;
    }
    for (let k = j + 1; k < notes.length && notes[k].start === n.start; k++) {
      if (notes[k].pitch > n.pitch) return false;
    }
    return true;
  });
}

function buildWindows(notes: TimedNote[], measures: MeasureSpan[]): Window[] {
  const windows: Window[] = [];
  const maxDuration = notes.reduce((m, n) => Math.max(m, n.end - n.start), 0);
  const isTop = topVoiceFlags(notes, maxDuration);
  let i = 0;
  for (const m of measures) {
    const beat = beatLength(m);
    for (let start = m.start; start < m.start + m.length; start += beat) {
      const end = Math.min(start + beat, m.start + m.length);
      while (i < notes.length && notes[i].start + maxDuration <= start) i++;
      const weights = new Array(12).fill(0);
      const inner = new Array(12).fill(0);
      let bass: TimedNote | null = null;
      for (let k = i; k < notes.length && notes[k].start < end; k++) {
        const n = notes[k];
        const overlap = Math.min(n.end, end) - Math.max(n.start, start);
        if (overlap <= 0) continue;
        // Short melodic notes are mostly passing tones; long ones define the harmony.
        const w = overlap * Math.max(0.25, Math.min(1, (n.end - n.start) / (end - start)));
        weights[n.pitch % 12] += w;
        if (!isTop[k]) inner[n.pitch % 12] += w;
        if (!bass || n.pitch < bass.pitch) bass = n;
      }
      let bassShare = 0;
      if (bass) {
        bassShare = (Math.min(bass.end, end) - Math.max(bass.start, start)) / (end - start);
        weights[bass.pitch % 12] += (end - start) * 0.5;
      }
      const total = weights.reduce((s, w) => s + w, 0);
      windows.push({ start, end, weights, inner, total, bassPc: bass ? bass.pitch % 12 : null, bassShare });
    }
  }
  return windows;
}

const COLOR_INTERVALS = new Set([2, 5, 9, 10, 11]);

function scoreLabel(w: Window, label: Label, diatonic: Set<number>): number {
  const pcs = chordPcs(label.root, label.quality);
  // A 7th/6th/sus tone heard only in the top voice is melody, not part of the chord.
  for (const i of label.quality.intervals) {
    if (COLOR_INTERVALS.has(i) && w.inner[(label.root + i) % 12] === 0) return -Infinity;
  }
  const inside = pcs.reduce((s, pc) => s + w.weights[pc], 0);
  const outside = w.total - inside;
  const missing = label.quality.intervals.filter((i) => i !== 7 && w.weights[(label.root + i) % 12] === 0).length;
  let score = inside - 0.7 * outside - (missing * 0.6 * w.total) / pcs.length;
  if (w.bassPc === label.root) score += 0.15 * w.total;
  if (!pcs.every((pc) => diatonic.has(pc))) score -= 0.15 * w.total;
  return score - label.quality.rarity * w.total;
}

const sameLabel = (a: Label | null, b: Label | null) => !!a && !!b && a.root === b.root && a.quality === b.quality;

export function analyzeHarmony(
  notes: TimedNote[],
  measures: MeasureSpan[],
  fifths: number,
): HarmonyAnalysis {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const windows = buildWindows(sorted, measures);
  const tonicMajor = majorTonic(fifths);
  const diatonic = new Set(MAJOR_SCALE.map((d) => (tonicMajor + d) % 12));
  // Raised 7th of the relative minor (harmonic minor V/vii°) is common enough to count as diatonic.
  diatonic.add((tonicMajor + 8) % 12);

  const labels: (Label | null)[] = [];
  let prev: Label | null = null;
  for (const w of windows) {
    const distinct = w.weights.filter((x) => x > 0).length;
    if (distinct < 2) {
      labels.push(prev);
      continue;
    }
    let best: Label | null = null;
    let bestScore = -Infinity;
    for (let root = 0; root < 12; root++) {
      for (const quality of QUALITIES) {
        const s = scoreLabel(w, { root, quality }, diatonic);
        if (s > bestScore) {
          bestScore = s;
          best = { root, quality };
        }
      }
    }
    // A single voice (no simultaneous notes) only sets a chord when it is an arpeggio, not a melody.
    const monophonic = w.inner.every((x) => x === 0);
    const fit = best ? chordPcs(best.root, best.quality).reduce((s, pc) => s + w.weights[pc], 0) / w.total : 0;
    if (monophonic && fit < 0.85) best = prev;
    else if (prev && scoreLabel(w, prev, diatonic) >= bestScore - 0.12 * w.total) best = prev;
    labels.push(best);
    prev = best;
  }

  // A one-beat chord between two identical ones is usually a passing tone, unless the beat spans the whole measure.
  for (let k = 1; k < labels.length - 1; k++) {
    const fullMeasure = measures.some((m) => m.start === windows[k].start && m.length === windows[k].end - windows[k].start);
    if (fullMeasure) continue;
    if (!sameLabel(labels[k], labels[k - 1]) && sameLabel(labels[k - 1], labels[k + 1])) labels[k] = labels[k - 1];
  }

  const chords: ChordEvent[] = [];
  labels.forEach((label, k) => {
    if (!label) return;
    const w = windows[k];
    const last = chords[chords.length - 1];
    if (last && sameLabel(last, label) && last.end === w.start) {
      last.end = w.end;
      return;
    }
    const pcs = chordPcs(label.root, label.quality);
    const bass = w.bassPc !== null && w.bassPc !== label.root && pcs.includes(w.bassPc) && w.bassShare >= 0.5 ? w.bassPc : null;
    chords.push({ unit: w.start, end: w.end, root: label.root, quality: label.quality, bass });
  });

  // Header key events rarely state the mode correctly (MuseScore exports minor keys as major), so infer it.
  const mode = detectMode(chords, tonicMajor);
  return { fifths, mode, tonic: mode === "major" ? tonicMajor : (tonicMajor + 9) % 12, chords, measures };
}

function detectMode(chords: ChordEvent[], tonicMajor: number): Mode {
  const tonicMinor = (tonicMajor + 9) % 12;
  let major = 0;
  let minor = 0;
  // Tonic chords count fully; the major-quality dominant of each mode counts half.
  const add = (c: ChordEvent, weight: number) => {
    if (c.root === tonicMajor && !c.quality.minor) major += weight;
    if (c.root === tonicMinor && c.quality.minor) minor += weight;
    if (c.root === (tonicMajor + 7) % 12 && !c.quality.minor) major += weight / 2;
    if (c.root === (tonicMinor + 7) % 12 && !c.quality.minor) minor += weight / 2;
  };
  const total = chords.reduce((s, c) => s + c.end - c.unit, 0);
  chords.forEach((c) => add(c, c.end - c.unit));
  if (chords.length) {
    add(chords[0], total * 0.1);
    add(chords[chords.length - 1], total * 0.15);
  }
  return minor > major ? "minor" : "major";
}
