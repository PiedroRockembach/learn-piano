// Score-informed piano note detection from AnalyserNode spectra.
//
// 1. Onset: spectral flux on the noise-cleaned spectrum, and the band energy must jump by at least the
//    calibrated gain within one settle period (a hammer attack; voices and pads rise slowly).
// 2. The energy the onset added (current frame − frame before the onset − noise floor) is tested per
//    candidate note: its partials must hold most of that energy, the odd partials must be there (else the
//    sound is the octave above), and nothing may sit between them at ½, 1½, ⅓, ⅔… of the fundamental
//    (else the sound is an octave or a twelfth below, even when the mic misses that low fundamental).

export const FFT_SIZE = 8192;

const MIN_PITCH = 28;
const MAX_PITCH = 108;
const BAND_LO_HZ = 50;
const BAND_HI_HZ = 5000;
const PARTIALS = 8;
const SETTLE_MS = 60;
const REFRACTORY_MS = 90;
const FLUX_RATIO = 2;
const FLUX_MIN = 2;
// A hammer reaches full loudness within a few ms; voices, whistles and synth pads take 80 ms or more.
const MAX_RISE_MS = 45;
// The analysis window keeps filling for ~170 ms after an attack, which can look like a second onset.
const ECHO_MS = 200;
// Without calibration: a note's partials must stand this far above the noise floor in their own bins.
const DEFAULT_MIN_GAIN_DB = 15;
const NOISE_MARGIN = 1.6;
// Fractions of f0 where the partials of a lower note (octave, twelfth, two octaves) fall between ours.
const SUB_OCTAVE = [0.5, 1.5, 2.5, 3.5];
const SUB_TWELFTH = [1 / 3, 2 / 3, 4 / 3, 5 / 3, 7 / 3, 8 / 3];
const MAX_SUB_SHARE = 0.3;
const MIN_ODD_SHARE = 0.2;
const MIN_TONALITY = 0.4;
const MIN_RELATIVE = 0.35;

export interface Detection {
  pitches: number[];
  velocity: number;
  expectedHit: boolean;
  gainDb: number;
}

// Saved per device: per-bin noise floor and the smallest attack gain a real note produced.
export interface MicCalibration {
  version: 1;
  sampleRate: number;
  noiseDb: number[];
  minGainDb: number;
  device: string;
  date: string;
}

export const hz = (pitch: number) => 440 * Math.pow(2, (pitch - 69) / 12);
const db2mag = (db: number) => (db > -200 ? Math.pow(10, db / 20) : 0);
const toDb = (power: number) => 10 * Math.log10(Math.max(power, 1e-20));

export interface Evidence {
  ok: boolean;
  energy: number;
  partials: number;
  odd: number;
  subOctave: number;
  subTwelfth: number;
}

export class SpectrumAnalyzer {
  readonly lo: number;
  readonly hi: number;

  constructor(readonly binHz: number) {
    this.lo = Math.max(1, Math.floor(BAND_LO_HZ / binHz));
    this.hi = Math.ceil(BAND_HI_HZ / binHz);
  }

  // ±1.5 % (a quarter tone is 2.9 %) leaves room for piano stretch tuning without reaching the next semitone.
  peak(mag: Float32Array, f: number): number {
    const center = f / this.binHz;
    const lo = Math.max(1, Math.min(Math.floor(center * 0.985), Math.round(center) - 1));
    const hi = Math.min(mag.length - 1, Math.max(Math.ceil(center * 1.015), Math.round(center) + 1));
    let best = 0;
    for (let k = lo; k <= hi; k++) if (mag[k] > best) best = mag[k];
    return best;
  }

  bandEnergy(mag: Float32Array): number {
    let e = 0;
    for (let k = this.lo; k <= this.hi; k++) e += mag[k] * mag[k];
    return e;
  }

  // Partial energy of `p` in the added spectrum, plus the tests that tell it apart from its neighbours.
  evidence(delta: Float32Array, p: number, others: number[]): Evidence {
    const f = hz(p);
    const nyquist = Math.min(BAND_HI_HZ, this.binHz * delta.length);
    const amps: number[] = [];
    for (let h = 1; h <= PARTIALS && h * f < nyquist; h++) amps.push(this.peak(delta, h * f));
    const max = Math.max(0, ...amps);
    if (max <= 0) return { ok: false, energy: 0, partials: 0, odd: 0, subOctave: 0, subTwelfth: 0 };
    let odd = 0;
    let even = 0;
    amps.forEach((a, i) => ((i + 1) % 2 ? (odd += a * a) : (even += a * a)));
    const energy = odd + even;
    const partials = amps.filter((a) => a >= 0.03 * max).length;
    // Fractions that land on a partial of another expected note (a chord) say nothing about this one.
    const free = (r: number) =>
      !others.some((q) => {
        const g = hz(q);
        for (let m = 1; m <= PARTIALS; m++) if (Math.abs(Math.log2((r * f) / (m * g))) < 0.015) return true;
        return false;
      });
    const sub = (fractions: number[]) =>
      fractions.filter((r) => r * f >= BAND_LO_HZ && r * f < nyquist && free(r)).reduce((s, r) => s + this.peak(delta, r * f) ** 2, 0);
    // Treble piano notes are nearly pure, but up to C6 a struck string still shows a second partial
    // above −30 dB; a whistle or a sine beep does not.
    const needed = p < 60 ? 3 : p < 84 ? 2 : 1;
    const oddOk = amps.length < 3 || odd >= MIN_ODD_SHARE * even;
    const subOctave = sub(SUB_OCTAVE) / energy;
    const subTwelfth = sub(SUB_TWELFTH) / energy;
    const ok = partials >= Math.min(needed, amps.length) && oddOk && subOctave <= MAX_SUB_SHARE && subTwelfth <= MAX_SUB_SHARE;
    return { ok, energy, partials, odd: odd / energy, subOctave, subTwelfth };
  }

  partialBins(pitches: number[]): Set<number> {
    const bins = new Set<number>();
    for (const p of pitches) {
      for (let h = 1; h <= PARTIALS; h++) {
        const center = (h * hz(p)) / this.binHz;
        const lo = Math.max(this.lo, Math.min(Math.floor(center * 0.985), Math.round(center) - 1));
        const hi = Math.min(this.hi, Math.max(Math.ceil(center * 1.015), Math.round(center) + 1));
        for (let k = lo; k <= hi; k++) bins.add(k);
      }
    }
    return bins;
  }

  // Share of the added band energy that sits on the partials of the given notes.
  tonality(delta: Float32Array, pitches: number[]): number {
    const total = this.bandEnergy(delta);
    if (total <= 0) return 0;
    let e = 0;
    for (const k of this.partialBins(pitches)) e += delta[k] * delta[k];
    return e / total;
  }

  // How far the notes' partials rise above the noise floor in their own bins: room rumble or hiss in
  // other frequencies doesn't count, a distant or quiet note does.
  snrDb(delta: Float32Array, floor: Float32Array, pitches: number[]): number {
    let signal = 0;
    let noise = 0;
    for (const k of this.partialBins(pitches)) {
      signal += delta[k] * delta[k];
      noise += floor[k] * floor[k];
    }
    return toDb(signal) - toDb(noise);
  }

  // Best explanation of the added sound as a single note, or null when nothing passes the tests.
  strongest(delta: Float32Array): { pitch: number; energy: number } | null {
    let best: { pitch: number; energy: number } | null = null;
    for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
      const e = this.evidence(delta, p, []);
      if (e.ok && (!best || e.energy > best.energy * 1.05)) best = { pitch: p, energy: e.energy };
    }
    if (!best || this.tonality(delta, [best.pitch]) < MIN_TONALITY) return null;
    return best;
  }
}

// Attack time (20 % → 80 %) of the raw signal's envelope, in 5 ms blocks over the analyser window. The
// signal is differentiated first: that drops room rumble and keeps the broadband click of a hammer.
// A sound still rising at the end of the window counts as slow.
export function attackRiseMs(wave: Float32Array, sampleRate: number): number {
  const size = Math.round(sampleRate * 0.005);
  const env: number[] = [];
  for (let i = 1; i + size <= wave.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + size; j++) sum += (wave[j] - wave[j - 1]) ** 2;
    env.push(Math.sqrt(sum / size));
  }
  let peakIdx = 0;
  env.forEach((v, i) => v > env[peakIdx] && (peakIdx = i));
  if (peakIdx >= env.length - 2) return Infinity;
  const before = env.slice(0, Math.max(1, peakIdx)).sort((a, b) => a - b);
  const base = before[before.length >> 1];
  const range = env[peakIdx] - base;
  if (range <= 0) return 0;
  const i80 = env.findIndex((v, i) => i <= peakIdx && v >= base + 0.8 * range);
  let i20 = i80;
  while (i20 > 0 && env[i20] >= base + 0.2 * range) i20--;
  return (i80 - i20) * 5;
}

export class NoteDetector {
  private readonly a: SpectrumAnalyzer;
  private readonly noise: Float32Array;
  private readonly calibratedNoise: Float32Array;
  private readonly minGainDb: number;
  private prevLog: Float32Array | null = null;
  private prevMag: Float32Array | null = null;
  private readonly fluxHistory: number[] = [];
  private lastOnset = -Infinity;
  private pending: { t: number; before: Float32Array } | null = null;
  private last: { t: number; pitches: number[] } | null = null;
  private frames = 0;
  // Last attack seen, accepted or not (the calibration measures gains with it).
  lastAttack: { t: number; gainDb: number } | null = null;

  constructor(binHz: number, bins: number, calibration: MicCalibration | null = null, minGainDb?: number) {
    this.a = new SpectrumAnalyzer(binHz);
    this.noise = new Float32Array(bins);
    this.calibratedNoise = new Float32Array(bins);
    if (calibration && calibration.noiseDb.length === bins) {
      calibration.noiseDb.forEach((d, k) => (this.calibratedNoise[k] = db2mag(d)));
    }
    this.minGainDb = minGainDb ?? calibration?.minGainDb ?? DEFAULT_MIN_GAIN_DB;
  }

  // db is AnalyserNode.getFloatFrequencyData output; t in ms. Returns a detection once an onset has settled.
  // wave (optional): the analyser's time-domain buffer, used to reject slow, non-percussive attacks.
  process(db: Float32Array, t: number, expected: number[], wave?: Float32Array, sampleRate = 48000): Detection | null {
    const mag = new Float32Array(db.length);
    const log = new Float32Array(db.length);
    this.frames++;
    for (let k = 0; k < db.length; k++) {
      const m = db2mag(db[k]);
      mag[k] = m;
      // Adaptive floor: drops at once to quieter frames, creeps up slowly so held notes don't become noise.
      // The calibrated floor (measured in silence) is the minimum it can reach.
      const n = this.noise[k];
      this.noise[k] = n === 0 || m < n ? m : n + (m - n) * 0.0015;
      log[k] = Math.log1p(1000 * Math.max(0, m - this.floor(k)));
    }
    let flux = 0;
    if (this.prevLog) for (let k = this.a.lo; k <= this.a.hi; k++) flux += Math.max(0, log[k] - this.prevLog[k]);
    const sorted = [...this.fluxHistory].sort((x, y) => x - y);
    const median = sorted.length ? sorted[sorted.length >> 1] : 0;
    this.fluxHistory.push(flux);
    if (this.fluxHistory.length > 25) this.fluxHistory.shift();

    let result: Detection | null = null;
    if (this.pending && t - this.pending.t >= SETTLE_MS) {
      const riseMs = wave ? attackRiseMs(wave, sampleRate) : 0;
      result = riseMs <= MAX_RISE_MS ? this.settle(mag, expected) : null;
      const recent = this.last !== null && this.pending.t - this.last.t < ECHO_MS;
      if (result && recent && (!result.expectedHit || result.pitches.every((p) => this.echoes(p)))) result = null;
      if (result) this.last = { t: this.pending.t, pitches: result.pitches };
      this.pending = null;
    }
    if (
      this.prevMag &&
      !this.pending &&
      flux > median * FLUX_RATIO + FLUX_MIN &&
      t - this.lastOnset > REFRACTORY_MS
    ) {
      this.lastOnset = t;
      this.pending = { t, before: this.prevMag };
    }
    this.prevLog = log;
    this.prevMag = mag;
    return result;
  }

  private floor(k: number): number {
    return Math.max(this.noise[k], this.calibratedNoise[k]) * NOISE_MARGIN;
  }

  private echoes(p: number): boolean {
    return this.last!.pitches.some((q) => p === q || [12, 19, 24, 28, 31, 36].includes(p - q));
  }

  private settle(mag: Float32Array, expected: number[]): Detection | null {
    const { before, t } = this.pending!;
    const delta = new Float32Array(mag.length);
    const floor = new Float32Array(mag.length);
    for (let k = 0; k < mag.length; k++) {
      floor[k] = this.floor(k);
      delta[k] = Math.max(0, mag[k] - Math.max(before[k], floor[k]));
    }
    const inRange = expected.filter((p) => p >= MIN_PITCH && p <= MAX_PITCH);
    const strongest = this.a.strongest(delta);
    const heard = inRange.filter((p) => {
      const e = this.a.evidence(
        delta,
        p,
        inRange.filter((q) => q !== p),
      );
      return e.ok && (!strongest || e.energy >= MIN_RELATIVE * strongest.energy);
    });
    const hit = heard.length > 0 && this.a.tonality(delta, heard) >= MIN_TONALITY;
    const pitches = hit ? heard : strongest ? [strongest.pitch] : [];
    if (!pitches.length) return null;
    const gainDb = this.a.snrDb(delta, floor, pitches);
    this.lastAttack = { t, gainDb };
    if (gainDb < this.minGainDb) return null;
    const velocity = Math.max(25, Math.min(120, Math.round(50 + 2.5 * (gainDb - this.minGainDb))));
    return { pitches, velocity, expectedHit: hit, gainDb };
  }
}
