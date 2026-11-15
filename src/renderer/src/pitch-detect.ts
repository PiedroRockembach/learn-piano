// Score-informed note detection from AnalyserNode spectra: find note onsets by spectral flux, then
// check which of the expected pitches appear in the energy that the onset added.

export const FFT_SIZE = 8192;

const MIN_PITCH = 28;
const MAX_PITCH = 108;
const BAND_LO_HZ = 50;
const BAND_HI_HZ = 5000;
const HARMONIC_WEIGHTS = [1, 0.8, 0.6, 0.5, 0.4, 0.3];
// Pitch offsets (semitones) at which a note's own harmonics fall: 2nd, 3rd, 4th, 5th, 6th, 8th.
const HARMONIC_OFFSETS = [12, 19, 24, 28, 31, 36];
const SETTLE_MS = 60;
const REFRACTORY_MS = 90;
const FLUX_RATIO = 2;
const FLUX_MIN = 4;
const ACCEPT_RATIO = 0.3;
const MIN_TONALITY = 0.25;
// The analysis window keeps filling for ~170 ms after an attack, which can look like a second onset.
const ECHO_MS = 200;

export interface Detection {
  pitches: number[];
  velocity: number;
  expectedHit: boolean;
}

const hz = (pitch: number) => 440 * Math.pow(2, (pitch - 69) / 12);

export class NoteDetector {
  private readonly lo: number;
  private readonly hi: number;
  private prevLog: Float32Array | null = null;
  private prevMag: Float32Array | null = null;
  private readonly fluxHistory: number[] = [];
  private noise = 0;
  private lastOnset = -Infinity;
  private pending: { t: number; before: Float32Array; gain: number } | null = null;
  private last: { t: number; pitches: number[] } | null = null;

  constructor(private readonly binHz: number) {
    this.lo = Math.max(1, Math.floor(BAND_LO_HZ / binHz));
    this.hi = Math.ceil(BAND_HI_HZ / binHz);
  }

  // db is AnalyserNode.getFloatFrequencyData output; t in ms. Returns a detection once an onset has settled.
  process(db: Float32Array, t: number, expected: number[]): Detection | null {
    const mag = new Float32Array(db.length);
    const log = new Float32Array(db.length);
    let energy = 0;
    for (let k = 0; k < db.length; k++) {
      const m = db[k] > -200 ? Math.pow(10, db[k] / 20) : 0;
      mag[k] = m;
      log[k] = Math.log1p(1000 * m);
      if (k >= this.lo && k <= this.hi) energy += m * m;
    }
    let flux = 0;
    if (this.prevLog) for (let k = this.lo; k <= this.hi; k++) flux += Math.max(0, log[k] - this.prevLog[k]);

    // Noise floor follows quiet stretches quickly and loud ones slowly.
    this.noise = this.noise === 0 ? energy : energy < this.noise ? energy : this.noise + (energy - this.noise) * 0.002;
    const sorted = [...this.fluxHistory].sort((a, b) => a - b);
    const median = sorted.length ? sorted[sorted.length >> 1] : 0;
    this.fluxHistory.push(flux);
    if (this.fluxHistory.length > 25) this.fluxHistory.shift();

    let result: Detection | null = null;
    if (this.pending && t - this.pending.t >= SETTLE_MS) {
      const delta = new Float32Array(mag.length);
      for (let k = 0; k < mag.length; k++) delta[k] = Math.max(0, mag[k] - this.pending.before[k]);
      result = this.decide(delta, expected, this.pending.gain);
      const recent = this.last !== null && this.pending.t - this.last.t < ECHO_MS;
      if (result && recent && (!result.expectedHit || result.pitches.every((p) => this.echoes(p)))) result = null;
      if (result) this.last = { t: this.pending.t, pitches: result.pitches };
      this.pending = null;
    }
    const isOnset =
      this.prevMag !== null &&
      flux > median * FLUX_RATIO + FLUX_MIN &&
      t - this.lastOnset > REFRACTORY_MS &&
      energy > this.noise * 4;
    if (isOnset && !this.pending) {
      this.lastOnset = t;
      this.pending = { t, before: this.prevMag!, gain: energy };
    }
    this.prevLog = log;
    this.prevMag = mag;
    return result;
  }

  private echoes(p: number): boolean {
    return this.last!.pitches.some((q) => p === q || HARMONIC_OFFSETS.includes(p - q));
  }

  private window(f: number, length: number): [number, number] {
    return [Math.max(1, Math.floor((f * 0.98) / this.binHz)), Math.min(length - 1, Math.ceil((f * 1.02) / this.binHz))];
  }

  private peak(mag: Float32Array, f: number): number {
    const [lo, hi] = this.window(f, mag.length);
    let best = 0;
    for (let k = lo; k <= hi; k++) if (mag[k] > best) best = mag[k];
    return best;
  }

  private decide(delta: Float32Array, expected: number[], gain: number): Detection | null {
    const nyquist = this.binHz * delta.length;
    const sal = new Map<number, number>();
    const fundamental = new Map<number, number>();
    let best = -1;
    for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
      let s = 0;
      HARMONIC_WEIGHTS.forEach((w, i) => {
        const f = hz(p) * (i + 1);
        if (f < nyquist) s += w * this.peak(delta, f);
      });
      sal.set(p, s);
      fundamental.set(p, this.peak(delta, hz(p)));
      if (best < 0 || s > sal.get(best)!) best = p;
    }
    const top = sal.get(best) ?? 0;
    if (top <= 0) return null;
    const expectedSet = new Set(expected);
    const s = (p: number) => sal.get(p) ?? 0;
    const f0 = (p: number) => fundamental.get(p) ?? 0;

    // A candidate is rejected when a stronger, unexpected note explains its energy: as one of that
    // note's harmonics (octave, twelfth…) or as spectral leakage from a neighbouring semitone.
    const explained = (p: number) =>
      HARMONIC_OFFSETS.some((d) => {
        const q = p - d;
        return !expectedSet.has(q) && s(q) > s(p) && f0(q) >= 0.5 * f0(p);
      }) || [p - 1, p + 1].some((q) => !expectedSet.has(q) && s(q) > 2 * s(p));

    const velocity = Math.max(25, Math.min(120, Math.round(40 + 12 * Math.log10(gain / Math.max(this.noise, 1e-12)))));
    const heard = expected.filter((p) => p >= MIN_PITCH && p <= MAX_PITCH && s(p) >= ACCEPT_RATIO * top && !explained(p));
    if (heard.length) {
      return this.tonality(delta, heard) >= MIN_TONALITY ? { pitches: heard, velocity, expectedHit: true } : null;
    }

    // Nothing expected: report the strongest note, moved down while its lower octave has a real fundamental.
    let wrong = best;
    while (wrong - 12 >= MIN_PITCH && s(wrong - 12) >= 0.5 * s(wrong) && f0(wrong - 12) >= 0.3 * f0(wrong)) wrong -= 12;
    return this.tonality(delta, [wrong]) >= MIN_TONALITY ? { pitches: [wrong], velocity, expectedHit: false } : null;
  }

  // Share of the added energy that sits on the given notes' harmonics: clicks and speech spread it out.
  private tonality(delta: Float32Array, pitches: number[]): number {
    let total = 0;
    for (let k = this.lo; k <= this.hi; k++) total += delta[k] * delta[k];
    const bins = new Set<number>();
    for (const p of pitches) {
      for (let i = 1; i <= HARMONIC_WEIGHTS.length; i++) {
        const [lo, hi] = this.window(hz(p) * i, delta.length);
        for (let k = Math.max(lo, this.lo); k <= Math.min(hi, this.hi); k++) bins.add(k);
      }
    }
    let harmonic = 0;
    for (const k of bins) harmonic += delta[k] * delta[k];
    return total > 0 ? harmonic / total : 0;
  }
}
