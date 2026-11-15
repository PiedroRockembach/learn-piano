import { Midi } from "@tonejs/midi";

// The site pages sit behind a Cloudflare challenge, but the editor's data endpoint does not.
const PROTO_URL = "https://onlinesequencer.net/app/api/get_proto.php?id=";

// Names and ids from the site's wiki "Instruments" page, mapped to the closest General MIDI program.
// Clones of an instrument use id + 10000·n.
const INSTRUMENTS: Record<number, [name: string, program: number]> = {
  0: ["Electric Piano (Classic)", 4],
  1: ["Acoustic Guitar (Classic)", 25],
  2: ["Drum Kit", 0],
  3: ["Smooth Synth (Classic)", 89],
  4: ["Electric Guitar", 27],
  5: ["Bass Guitar (Classic)", 33],
  6: ["Synth Pluck", 81],
  7: ["Scifi", 99],
  8: ["Grand Piano (Classic)", 0],
  9: ["French Horn (Classic)", 60],
  10: ["Trombone (Classic)", 57],
  11: ["Violin (Classic)", 40],
  12: ["Cello (Classic)", 42],
  13: ["8-Bit Sine", 80],
  14: ["8-Bit Square", 80],
  15: ["8-Bit Sawtooth", 81],
  16: ["8-Bit Triangle", 80],
  17: ["Harpsichord", 6],
  18: ["Concert Harp", 46],
  19: ["Xylophone", 13],
  20: ["Pizzicato", 45],
  21: ["Steel Drums", 114],
  22: ["Sitar", 104],
  23: ["Flute", 73],
  24: ["Saxophone", 65],
  25: ["Ragtime Piano", 3],
  26: ["Music Box", 10],
  27: ["Synth Bass (Classic)", 38],
  28: ["Church Organ", 19],
  29: ["Slap Bass", 36],
  30: ["Pop Synth (Classic)", 81],
  31: ["Electric Drum Kit (Classic)", 0],
  32: ["Jazz Guitar", 26],
  33: ["Koto", 107],
  34: ["Vibraphone", 11],
  35: ["Muted E-Guitar", 28],
  36: ["808 Drum Kit", 0],
  37: ["808 Bass", 38],
  38: ["Distortion Guitar (Classic)", 30],
  39: ["8-Bit Drum Kit", 0],
  40: ["2013 Drum Kit", 0],
  41: ["Grand Piano", 0],
  42: ["909 Drum Kit", 0],
  43: ["Electric Piano", 4],
  44: ["Distortion Guitar", 30],
  45: ["Cello", 42],
  46: ["Violin", 40],
  47: ["Strings", 48],
  48: ["Bass", 32],
  49: ["Clean Guitar", 27],
  50: ["French Horn", 60],
  51: ["Trombone", 57],
  52: ["Smooth Synth", 89],
  53: ["2023 Drum Kit", 0],
  54: ["Bass Guitar", 33],
  55: ["Synthesizer", 81],
  56: ["Synth Bass", 38],
  57: ["Pop Synth", 81],
  58: ["Acoustic Guitar", 25],
  59: ["Lucent Choir", 52],
  60: ["EDM Kit", 0],
  61: ["Brass", 61],
  62: ["Rhodes", 4],
};
const DRUM_KITS = new Set([2, 31, 36, 39, 40, 42, 53, 60]);

interface Field {
  num: number;
  value: number | Uint8Array;
}

// Minimal protobuf wire-format reader: enough for the Sequence message (varints, floats, nested messages).
function fields(buf: Uint8Array): Field[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Field[] = [];
  let pos = 0;
  const varint = () => {
    let result = 0;
    let scale = 1;
    for (;;) {
      const byte = buf[pos++];
      if (byte === undefined) throw new Error("Sequência corrompida");
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) return result;
      scale *= 128;
    }
  };
  while (pos < buf.length) {
    const key = varint();
    const num = Math.floor(key / 8);
    switch (key % 8) {
      case 0:
        out.push({ num, value: varint() });
        break;
      case 1:
        out.push({ num, value: view.getFloat64(pos, true) });
        pos += 8;
        break;
      case 2: {
        const length = varint();
        out.push({ num, value: buf.subarray(pos, pos + length) });
        pos += length;
        break;
      }
      case 5:
        out.push({ num, value: view.getFloat32(pos, true) });
        pos += 4;
        break;
      default:
        throw new Error("Sequência corrompida");
    }
  }
  return out;
}

// proto3: absent fields are zero.
function record(buf: Uint8Array): Map<number, number | Uint8Array> {
  return new Map(fields(buf).map((f) => [f.num, f.value]));
}
const num = (r: Map<number, number | Uint8Array>, n: number) => {
  const v = r.get(n);
  return typeof v === "number" ? v : 0;
};

interface SequenceNote {
  pitch: number;
  step: number;
  steps: number;
  instrument: number;
  volume: number;
}

function decodeSequence(buf: Uint8Array) {
  let bpm = 110;
  let beats = 4;
  const muted = new Set<number>();
  const notes: SequenceNote[] = [];
  const tempos: { step: number; bpm: number }[] = [];
  for (const f of fields(buf)) {
    if (!(f.value instanceof Uint8Array)) continue;
    const r = record(f.value);
    if (f.num === 1) {
      bpm = num(r, 1) || bpm;
      beats = num(r, 2) || beats;
      for (const entry of fields(f.value)) {
        if (entry.num !== 3 || !(entry.value instanceof Uint8Array)) continue;
        const kv = record(entry.value);
        const settings = kv.get(2);
        if (settings instanceof Uint8Array && num(record(settings), 1) === 0) muted.add(num(kv, 1));
      }
    } else if (f.num === 2) {
      // Note type is an enum starting at C0, so MIDI = type + 12; time and length count 16th notes.
      notes.push({
        pitch: num(r, 1) + 12,
        step: num(r, 2),
        steps: num(r, 3),
        instrument: num(r, 4),
        volume: num(r, 5),
      });
    } else if (f.num === 3 && num(r, 2) === 0 && num(r, 4) > 0) {
      tempos.push({ step: num(r, 1), bpm: num(r, 4) });
    }
  }
  return { bpm, beats, muted, notes, tempos };
}

export function sequenceToMidi(buf: Uint8Array): Uint8Array {
  const seq = decodeSequence(buf);
  // Silent notes are common: people draw pictures on the piano roll with them.
  const audible = seq.notes.filter(
    (n) => n.volume > 0 && n.steps > 0 && n.pitch >= 0 && n.pitch <= 127 && !seq.muted.has(n.instrument),
  );
  if (!audible.length) throw new Error("a sequência não tem notas audíveis");

  const midi = new Midi();
  const stepTicks = midi.header.ppq / 4;
  const tempoAt = new Map<number, number>([[0, seq.bpm]]);
  for (const t of seq.tempos) tempoAt.set(Math.round(t.step * stepTicks), t.bpm);
  midi.header.tempos = [...tempoAt].sort((a, b) => a[0] - b[0]).map(([ticks, bpm]) => ({ ticks, bpm }));
  midi.header.timeSignatures = [{ ticks: 0, timeSignature: [seq.beats, 4], measures: 0 }];
  midi.header.update();

  const byInstrument = new Map<number, SequenceNote[]>();
  for (const n of audible) byInstrument.set(n.instrument, [...(byInstrument.get(n.instrument) ?? []), n]);
  let channel = 0;
  for (const [id, notes] of [...byInstrument].sort((a, b) => b[1].length - a[1].length)) {
    const base = id % 10000;
    const clone = Math.floor(id / 10000);
    const [name, program] = INSTRUMENTS[base] ?? [`Instrumento ${base}`, 0];
    const track = midi.addTrack();
    track.name = clone ? `${name} ${clone + 1}` : name;
    if (DRUM_KITS.has(base)) {
      track.channel = 9;
    } else {
      track.channel = channel;
      channel = channel === 15 ? 0 : channel === 8 ? 10 : channel + 1;
      track.instrument.number = program;
    }
    for (const n of notes) {
      track.addNote({
        midi: n.pitch,
        ticks: Math.round(n.step * stepTicks),
        durationTicks: Math.max(1, Math.round(n.steps * stepTicks)),
        velocity: Math.min(1, n.volume) * 0.8,
      });
    }
  }
  return midi.toArray();
}

export async function fetchSequenceMidi(id: string): Promise<Uint8Array> {
  const res = await fetch(PROTO_URL + encodeURIComponent(id));
  if (!res.ok) throw new Error(`a Online Sequencer respondeu ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length || bytes[0] === 0x3c) throw new Error("sequência não encontrada");
  return sequenceToMidi(bytes);
}
