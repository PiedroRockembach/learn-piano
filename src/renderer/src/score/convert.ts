import type { Midi } from "@tonejs/midi";

export const UNITS_PER_QUARTER = 4;
const UNITS_PER_WHOLE = UNITS_PER_QUARTER * 4;

export type Hand = "rh" | "lh";
export type SplitMode = "auto" | "tracks" | "pitch";

export interface TrackInfo {
  index: number;
  name: string;
  instrument: string;
  channel: number;
  noteCount: number;
  isPercussion: boolean;
  isPiano: boolean;
  avgPitch: number;
  signature: string;
}

export interface ConvertOptions {
  tracks: number[];
  split: SplitMode;
  splitPoint: number;
}

export interface Attack {
  pitch: number;
  velocity: number;
  durationUnits: number;
}

export interface Position {
  unit: number;
  rh: Attack[];
  lh: Attack[];
}

export interface ConvertedScore {
  musicXml: string;
  positions: Map<number, Position>;
  bpm: number;
  minPitch: number;
  maxPitch: number;
}

interface QNote {
  pitch: number;
  start: number;
  end: number;
  velocity: number;
  hand: Hand;
}

interface Measure {
  start: number;
  length: number;
  beats: number;
  beatType: number;
  timeChanged: boolean;
}

interface Item {
  start: number;
  end: number;
  pitches: number[] | null;
}

export function describeTracks(midi: Midi): TrackInfo[] {
  return midi.tracks.map((t, index) => {
    const notes = t.notes;
    const avg = notes.length ? notes.reduce((s, n) => s + n.midi, 0) / notes.length : 0;
    const program = t.instrument.number;
    return {
      index,
      name: t.name.replace(/\0/g, "").trim() || `Trilha ${index + 1}`,
      instrument: t.instrument.name,
      channel: t.channel,
      noteCount: notes.length,
      isPercussion: t.instrument.percussion || t.channel === 9,
      isPiano: !t.instrument.percussion && program >= 0 && program <= 7,
      avgPitch: avg,
      signature: notes.map((n) => `${n.ticks}:${n.midi}`).join(","),
    };
  });
}

export function defaultTrackSelection(tracks: TrackInfo[]): number[] {
  const seen = new Set<string>();
  const melodic = tracks.filter((t) => {
    if (t.noteCount < 8 || t.isPercussion || seen.has(t.signature)) return false;
    seen.add(t.signature);
    return true;
  });
  const pianos = melodic.filter((t) => t.isPiano);
  if (pianos.length > 0) return pianos.map((t) => t.index);
  if (melodic.length <= 2) return melodic.map((t) => t.index);
  const biggest = [...melodic].sort((a, b) => b.noteCount - a.noteCount)[0];
  return biggest ? [biggest.index] : [];
}

export function midiToScore(midi: Midi, title: string, opts: ConvertOptions): ConvertedScore {
  const unitTicks = midi.header.ppq / UNITS_PER_QUARTER;
  const q = (ticks: number) => Math.round(ticks / unitTicks);

  const notes = collectNotes(midi, opts, q);
  const lastEnd = notes.reduce((m, n) => Math.max(m, n.end), 0);
  const measures = buildMeasures(midi, q, Math.max(lastEnd, 1));
  const fifths = detectKey(midi, notes);
  const bpm = Math.round(midi.header.tempos[0]?.bpm ?? 120);

  const rhItems = buildItems(notes.filter((n) => n.hand === "rh"));
  const lhItems = buildItems(notes.filter((n) => n.hand === "lh"));

  const measureXml = measures.map((m, i) => {
    const parts: string[] = [];
    if (i === 0 || m.timeChanged) parts.push(attributesXml(m, i === 0 ? fifths : null));
    if (i === 0) parts.push(tempoXml(bpm));
    parts.push(staffXml(rhItems, m, 1, fifths));
    parts.push(`<backup><duration>${m.length}</duration></backup>`);
    parts.push(staffXml(lhItems, m, 2, fifths));
    return `<measure number="${i + 1}">${parts.join("")}</measure>`;
  });

  const musicXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<score-partwise version="3.1">` +
    `<work><work-title>${escapeXml(title)}</work-title></work>` +
    `<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>` +
    `<part id="P1">${measureXml.join("")}</part></score-partwise>`;

  return {
    musicXml,
    positions: buildPositions(notes),
    bpm,
    minPitch: notes.reduce((m, n) => Math.min(m, n.pitch), 127),
    maxPitch: notes.reduce((m, n) => Math.max(m, n.pitch), 0),
  };
}

function collectNotes(midi: Midi, opts: ConvertOptions, q: (t: number) => number): QNote[] {
  const selected = opts.tracks.filter((i) => midi.tracks[i]);
  const byTracks = opts.split === "tracks" || (opts.split === "auto" && selected.length === 2);

  const trackHand = new Map<number, Hand>();
  if (byTracks && selected.length >= 2) {
    const avg = (i: number) => {
      const ns = midi.tracks[i].notes;
      return ns.length ? ns.reduce((s, n) => s + n.midi, 0) / ns.length : 0;
    };
    const sorted = [...selected].sort((a, b) => avg(b) - avg(a));
    sorted.forEach((idx, k) => trackHand.set(idx, k === 0 ? "rh" : "lh"));
  }

  const dedupe = new Map<string, QNote>();
  for (const ti of selected) {
    for (const n of midi.tracks[ti].notes) {
      const start = q(n.ticks);
      const end = Math.max(start + 1, q(n.ticks + n.durationTicks));
      const hand = trackHand.get(ti) ?? (n.midi >= opts.splitPoint ? "rh" : "lh");
      const key = `${hand}:${start}:${n.midi}`;
      const prev = dedupe.get(key);
      if (!prev || prev.end < end) {
        dedupe.set(key, { pitch: n.midi, start, end, velocity: Math.round(n.velocity * 127), hand });
      }
    }
  }
  return [...dedupe.values()].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function buildMeasures(midi: Midi, q: (t: number) => number, lastEnd: number): Measure[] {
  const sigs = midi.header.timeSignatures
    .map((s) => ({ unit: q(s.ticks), beats: s.timeSignature[0], beatType: s.timeSignature[1] }))
    .filter((s) => Number.isInteger((s.beats * UNITS_PER_WHOLE) / s.beatType) && s.beats > 0)
    .sort((a, b) => a.unit - b.unit);
  if (!sigs.length || sigs[0].unit > 0) sigs.unshift({ unit: 0, beats: 4, beatType: 4 });

  const measures: Measure[] = [];
  let start = 0;
  let prevKey = "";
  while (start < lastEnd) {
    const sig = [...sigs].reverse().find((s) => s.unit <= start)!;
    const length = (sig.beats * UNITS_PER_WHOLE) / sig.beatType;
    const key = `${sig.beats}/${sig.beatType}`;
    measures.push({ start, length, beats: sig.beats, beatType: sig.beatType, timeChanged: key !== prevKey });
    prevKey = key;
    start += length;
  }
  return measures;
}

const MAJOR_KEYS: Record<string, number> = {
  Cb: -7, Gb: -6, Db: -5, Ab: -4, Eb: -3, Bb: -2, F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7,
};
const MINOR_KEYS: Record<string, number> = {
  Ab: -7, Eb: -6, Bb: -5, F: -4, C: -3, G: -2, D: -1, A: 0, E: 1, B: 2, "F#": 3, "C#": 4, "G#": 5, "D#": 6, "A#": 7,
};

function detectKey(midi: Midi, notes: QNote[]): number {
  const ks = midi.header.keySignatures[0];
  if (ks) {
    const table = ks.scale === "minor" ? MINOR_KEYS : MAJOR_KEYS;
    if (ks.key in table) return table[ks.key];
  }
  const weight = new Array(12).fill(0);
  for (const n of notes) weight[n.pitch % 12] += n.end - n.start;
  let best = 0;
  let bestScore = -1;
  for (let f = -6; f <= 6; f++) {
    const tonic = (((7 * f) % 12) + 12) % 12;
    const score = [0, 2, 4, 5, 7, 9, 11].reduce((s, d) => s + weight[(tonic + d) % 12], 0);
    if (score > bestScore || (score === bestScore && Math.abs(f) < Math.abs(best))) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

// One chord stream per hand: simultaneous onsets form a chord, sustained notes are cut at the next onset.
function buildItems(notes: QNote[]): Item[] {
  const byStart = new Map<number, QNote[]>();
  for (const n of notes) {
    const list = byStart.get(n.start) ?? [];
    list.push(n);
    byStart.set(n.start, list);
  }
  const starts = [...byStart.keys()].sort((a, b) => a - b);
  const items: Item[] = [];
  starts.forEach((start, i) => {
    const chord = byStart.get(start)!;
    const next = starts[i + 1] ?? Infinity;
    let end = Math.min(Math.max(...chord.map((n) => n.end)), next);
    const gap = next - end;
    if (next !== Infinity && gap > 0 && gap <= 2 && gap < end - start) end = next;
    items.push({ start, end, pitches: [...new Set(chord.map((n) => n.pitch))].sort((a, b) => a - b) });
  });
  return items;
}

function buildPositions(notes: QNote[]): Map<number, Position> {
  const positions = new Map<number, Position>();
  for (const n of notes) {
    const p = positions.get(n.start) ?? { unit: n.start, rh: [], lh: [] };
    p[n.hand].push({ pitch: n.pitch, velocity: n.velocity, durationUnits: n.end - n.start });
    positions.set(n.start, p);
  }
  return positions;
}

function staffXml(items: Item[], m: Measure, staff: 1 | 2, fifths: number): string {
  const mEnd = m.start + m.length;
  const voice = staff === 1 ? 1 : 5;
  const inMeasure = items.filter((it) => it.start < mEnd && it.end > m.start);

  if (!inMeasure.some((it) => it.pitches)) {
    return `<note><rest measure="yes"/><duration>${m.length}</duration><voice>${voice}</voice><staff>${staff}</staff></note>`;
  }

  const out: string[] = [];
  let cursor = m.start;
  const emit = (start: number, end: number, pitches: number[] | null, tieIn: boolean, tieOut: boolean) => {
    const pieces = splitDuration(start - m.start, end - start);
    pieces.forEach((dur, k) => {
      const tStop = tieIn || k > 0;
      const tStart = tieOut || k < pieces.length - 1;
      out.push(noteXml(pitches, dur, voice, staff, fifths, tStart, tStop));
    });
  };

  for (const it of inMeasure) {
    const s = Math.max(it.start, m.start);
    const e = Math.min(it.end, mEnd);
    if (s > cursor) emit(cursor, s, null, false, false);
    emit(s, e, it.pitches, it.pitches !== null && it.start < m.start, it.pitches !== null && it.end > mEnd);
    cursor = e;
  }
  if (cursor < mEnd) emit(cursor, mEnd, null, false, false);
  return out.join("");
}

const NOTE_VALUES = [16, 12, 8, 6, 4, 3, 2, 1];
const DOTTED = new Set([12, 6, 3]);
const TYPE_NAMES: Record<number, string> = { 16: "whole", 8: "half", 4: "quarter", 2: "eighth", 1: "16th" };

function splitDuration(posInMeasure: number, dur: number): number[] {
  const pieces: number[] = [];
  let pos = posInMeasure;
  let left = dur;
  while (left > 0) {
    const v = NOTE_VALUES.find((v) => v <= left && isAligned(pos, v)) ?? 1;
    pieces.push(v);
    pos += v;
    left -= v;
  }
  return pieces;
}

function isAligned(pos: number, value: number): boolean {
  if (value === 16) return pos === 0;
  const base = DOTTED.has(value) ? (value * 2) / 3 : value;
  return pos % Math.min(base, UNITS_PER_QUARTER) === 0;
}

const SHARP_SPELLING: [string, number][] = [
  ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];
const FLAT_SPELLING: [string, number][] = [
  ["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0],
];

function spell(pitch: number, fifths: number): { step: string; alter: number; octave: number } {
  const pc = pitch % 12;
  let octave = Math.floor(pitch / 12) - 1;
  if (fifths >= 6 && pc === 5) return { step: "E", alter: 1, octave };
  if (fifths <= -6 && pc === 11) return { step: "C", alter: -1, octave: octave + 1 };
  const [step, alter] = (fifths >= 0 ? SHARP_SPELLING : FLAT_SPELLING)[pc];
  return { step, alter, octave };
}

function noteXml(
  pitches: number[] | null,
  dur: number,
  voice: number,
  staff: number,
  fifths: number,
  tieStart: boolean,
  tieStop: boolean,
): string {
  const base = DOTTED.has(dur) ? (dur * 2) / 3 : dur;
  const type = `<type>${TYPE_NAMES[base]}</type>${DOTTED.has(dur) ? "<dot/>" : ""}`;
  if (!pitches) {
    return `<note><rest/><duration>${dur}</duration><voice>${voice}</voice>${type}<staff>${staff}</staff></note>`;
  }
  const ties = (tieStop ? `<tie type="stop"/>` : "") + (tieStart ? `<tie type="start"/>` : "");
  const tied = (tieStop ? `<tied type="stop"/>` : "") + (tieStart ? `<tied type="start"/>` : "");
  return pitches
    .map((p, i) => {
      const { step, alter, octave } = spell(p, fifths);
      return (
        `<note>${i > 0 ? "<chord/>" : ""}` +
        `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>` +
        `<duration>${dur}</duration>${ties}<voice>${voice}</voice>${type}<staff>${staff}</staff>` +
        (tied ? `<notations>${tied}</notations>` : "") +
        `</note>`
      );
    })
    .join("");
}

function attributesXml(m: Measure, fifths: number | null): string {
  const key = fifths === null ? "" : `<key><fifths>${fifths}</fifths></key>`;
  const head = fifths === null ? "" : `<divisions>${UNITS_PER_QUARTER}</divisions>`;
  const staves =
    fifths === null
      ? ""
      : `<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>`;
  return `<attributes>${head}${key}<time><beats>${m.beats}</beats><beat-type>${m.beatType}</beat-type></time>${staves}</attributes>`;
}

function tempoXml(bpm: number): string {
  return (
    `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>` +
    `<per-minute>${bpm}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${bpm}"/></direction>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
