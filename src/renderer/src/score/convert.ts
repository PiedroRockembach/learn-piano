import type { Midi } from "@tonejs/midi";
import { analyzeHarmony, harmonyXml, spell, type ChordEvent, type HarmonyAnalysis } from "./harmony";

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
  seconds: (unit: number) => number;
  minPitch: number;
  maxPitch: number;
  harmony: HarmonyAnalysis;
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
  const harmony = analyzeHarmony(notes, measures, fifths);
  const rhItems = buildItems(notes.filter((n) => n.hand === "rh"));
  const lhItems = buildItems(notes.filter((n) => n.hand === "lh"));
  const harmonyAt = placeHarmony(harmony.chords, rhItems, measures, fifths);
  const bpm = Math.round(midi.header.tempos[0]?.bpm ?? 120);

  const measureXml = measures.map((m, i) => {
    const parts: string[] = [];
    if (i === 0 || m.timeChanged) parts.push(attributesXml(m, i === 0 ? fifths : null));
    if (i === 0) parts.push(tempoXml(bpm));
    parts.push(staffXml(rhItems, m, 1, fifths, harmonyAt));
    parts.push(`<backup><duration>${m.length}</duration></backup>`);
    parts.push(staffXml(lhItems, m, 2, fifths, new Map()));
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
    seconds: (unit) => midi.header.ticksToSeconds(unit * unitTicks),
    minPitch: notes.reduce((m, n) => Math.min(m, n.pitch), 127),
    maxPitch: notes.reduce((m, n) => Math.max(m, n.pitch), 0),
    harmony,
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
  const weight = new Array(12).fill(0);
  for (const n of notes) weight[n.pitch % 12] += n.end - n.start;
  const fit = (f: number) => {
    const tonic = (((7 * f) % 12) + 12) % 12;
    return [0, 2, 4, 5, 7, 9, 11].reduce((s, d) => s + weight[(tonic + d) % 12], 0);
  };
  let best = 0;
  let bestScore = -1;
  for (let f = -6; f <= 6; f++) {
    const score = fit(f);
    if (score > bestScore || (score === bestScore && Math.abs(f) < Math.abs(best))) {
      best = f;
      bestScore = score;
    }
  }
  // Many MIDI files carry a default "C major" key event; trust the header only when the notes agree with it.
  const ks = midi.header.keySignatures[0];
  if (ks) {
    const table = ks.scale === "minor" ? MINOR_KEYS : MAJOR_KEYS;
    if (ks.key in table && fit(table[ks.key]) >= bestScore * 0.95) return table[ks.key];
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

// Beat length in units: a dotted quarter in compound meters (6/8, 9/8, 12/8, and 3/8 as one beat), else the
// beat-type note. Beams group notes within one beat, as engraved scores do.
function beatUnits(m: Measure): number {
  if (m.beatType === 8 && m.beats % 3 === 0) return 6;
  return UNITS_PER_WHOLE / m.beatType;
}

// Chord symbols attach to the note starting at their timestamp (OSMD ignores <offset>). Each symbol moves to
// the next right-hand attack within the same beat; only when there is none is a note cut (tied) to hold it.
function placeHarmony(chords: ChordEvent[], rh: Item[], measures: Measure[], fifths: number): Map<number, string> {
  const placed = new Map<number, string>();
  for (const c of chords) {
    const m = measures.find((x) => c.unit >= x.start && c.unit < x.start + x.length);
    const beat = m ? beatUnits(m) : UNITS_PER_QUARTER;
    const beatEnd = m ? m.start + Math.ceil((c.unit - m.start + 1) / beat) * beat : c.unit + beat;
    const onset = rh.find((it) => it.pitches && it.start >= c.unit && it.start < beatEnd);
    const unit = onset?.start ?? c.unit;
    if (!placed.has(unit)) placed.set(unit, harmonyXml(c, fifths));
  }
  return placed;
}

interface Piece {
  start: number;
  dur: number;
  pitches: number[] | null;
  tieStart: boolean;
  tieStop: boolean;
  harmony?: string;
  beams?: string[];
}

function staffXml(items: Item[], m: Measure, staff: 1 | 2, fifths: number, harmonyAt: Map<number, string>): string {
  const mEnd = m.start + m.length;
  const voice = staff === 1 ? 1 : 5;
  const inMeasure = items.filter((it) => it.start < mEnd && it.end > m.start);
  const cuts = [...harmonyAt.keys()].filter((u) => u >= m.start && u < mEnd);

  if (!inMeasure.some((it) => it.pitches) && !cuts.length) {
    return `<note><rest measure="yes"/><duration>${m.length}</duration><voice>${voice}</voice><staff>${staff}</staff></note>`;
  }

  const pieces: Piece[] = [];
  let cursor = m.start;
  const emitPiece = (start: number, end: number, pitches: number[] | null, tieIn: boolean, tieOut: boolean) => {
    const durs = splitDuration(start - m.start, end - start, m);
    let at = start;
    durs.forEach((dur, k) => {
      pieces.push({
        start: at,
        dur,
        pitches,
        tieStop: pitches !== null && (tieIn || k > 0),
        tieStart: pitches !== null && (tieOut || k < durs.length - 1),
        harmony: k === 0 ? harmonyAt.get(start) : undefined,
      });
      at += dur;
    });
  };
  const emit = (start: number, end: number, pitches: number[] | null, tieIn: boolean, tieOut: boolean) => {
    const bounds = [start, ...cuts.filter((u) => u > start && u < end), end];
    for (let k = 0; k < bounds.length - 1; k++) {
      const first = k === 0;
      const last = k === bounds.length - 2;
      const tied = pitches !== null;
      emitPiece(bounds[k], bounds[k + 1], pitches, first ? tieIn : tied, last ? tieOut : tied);
    }
  };

  for (const it of inMeasure) {
    const s = Math.max(it.start, m.start);
    const e = Math.min(it.end, mEnd);
    if (s > cursor) emit(cursor, s, null, false, false);
    emit(s, e, it.pitches, it.pitches !== null && it.start < m.start, it.pitches !== null && it.end > mEnd);
    cursor = e;
  }
  if (cursor < mEnd) emit(cursor, mEnd, null, false, false);
  addBeams(pieces, m);
  return pieces
    .map((pc) => (pc.harmony ?? "") + noteXml(pc.pitches, pc.dur, voice, staff, fifths, pc.tieStart, pc.tieStop, pc.beams))
    .join("");
}

// Beams over runs of eighths and shorter notes inside one beat; rests and longer notes break a run.
// Second-level beams join consecutive 16ths; a lone 16th gets a hook toward its neighbour.
function addBeams(pieces: Piece[], m: Measure): void {
  const beat = beatUnits(m);
  const group = (pc: Piece) => Math.floor((pc.start - m.start) / beat);
  const beamable = (pc: Piece) => pc.pitches !== null && pc.dur < UNITS_PER_QUARTER;
  let run: Piece[] = [];
  const flush = () => {
    if (run.length >= 2) {
      run.forEach((pc, i) => {
        const level1 = i === 0 ? "begin" : i === run.length - 1 ? "end" : "continue";
        pc.beams = [level1];
        if (pc.dur !== 1) return;
        const prev16 = run[i - 1]?.dur === 1;
        const next16 = run[i + 1]?.dur === 1;
        if (prev16 && next16) pc.beams.push("continue");
        else if (next16) pc.beams.push("begin");
        else if (prev16) pc.beams.push("end");
        else pc.beams.push(i === 0 ? "forward hook" : "backward hook");
      });
    }
    run = [];
  };
  for (const pc of pieces) {
    if (!beamable(pc) || (run.length && group(run[0]) !== group(pc))) flush();
    if (beamable(pc)) run.push(pc);
  }
  flush();
}

const NOTE_VALUES = [16, 12, 8, 6, 4, 3, 2, 1];
const DOTTED = new Set([12, 6, 3]);
const TYPE_NAMES: Record<number, string> = { 16: "whole", 8: "half", 4: "quarter", 2: "eighth", 1: "16th" };

function splitDuration(posInMeasure: number, dur: number, m: Measure): number[] {
  const pieces: number[] = [];
  let pos = posInMeasure;
  let left = dur;
  while (left > 0) {
    const v = NOTE_VALUES.find((v) => v <= left && v <= m.length && isAligned(pos, v, m)) ?? 1;
    pieces.push(v);
    pos += v;
    left -= v;
  }
  return pieces;
}

// Where a value may start without hiding the beat. Compound meters (dotted-quarter beat) allow a quarter
// or an eighth anywhere inside a beat and never let a note cross a beat unless it fills whole beats.
function isAligned(pos: number, value: number, m: Measure): boolean {
  if (value === 16) return pos === 0;
  if (beatUnits(m) === 6) {
    const inBeat = pos % 6;
    if (value >= 6) return inBeat === 0 && value % 6 === 0;
    return inBeat + value <= 6 && inBeat % (value === 3 ? 3 : Math.min(value, 2)) === 0;
  }
  // Simple meters: on-beat values as usual, plus the common syncopations (eighth–quarter–eighth,
  // eighth + dotted quarter, 16th + dotted eighth) as long as they stay within one half of a 4/4 bar.
  const inBeat = pos % UNITS_PER_QUARTER;
  const half = m.length === UNITS_PER_WHOLE ? UNITS_PER_WHOLE / 2 : m.length;
  const crossesHalf = Math.floor(pos / half) !== Math.floor((pos + value - 1) / half);
  if (value >= 8) return inBeat === 0;
  if (value === 4 || value === 6) return inBeat === 0 || (pos % 2 === 0 && !crossesHalf);
  return inBeat + value <= UNITS_PER_QUARTER;
}

function noteXml(
  pitches: number[] | null,
  dur: number,
  voice: number,
  staff: number,
  fifths: number,
  tieStart: boolean,
  tieStop: boolean,
  beams: string[] = [],
): string {
  const base = DOTTED.has(dur) ? (dur * 2) / 3 : dur;
  const type = `<type>${TYPE_NAMES[base]}</type>${DOTTED.has(dur) ? "<dot/>" : ""}`;
  if (!pitches) {
    return `<note><rest/><duration>${dur}</duration><voice>${voice}</voice>${type}<staff>${staff}</staff></note>`;
  }
  const ties = (tieStop ? `<tie type="stop"/>` : "") + (tieStart ? `<tie type="start"/>` : "");
  const tied = (tieStop ? `<tied type="stop"/>` : "") + (tieStart ? `<tied type="start"/>` : "");
  const beamXml = beams.map((b, i) => `<beam number="${i + 1}">${b}</beam>`).join("");
  return pitches
    .map((p, i) => {
      const { step, alter, octave } = spell(p, fifths);
      return (
        `<note>${i > 0 ? "<chord/>" : ""}` +
        `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${octave}</octave></pitch>` +
        `<duration>${dur}</duration>${ties}<voice>${voice}</voice>${type}<staff>${staff}</staff>` +
        (i === 0 ? beamXml : "") +
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
