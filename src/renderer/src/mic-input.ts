import { loadCalibration, type FrameSource } from "./calibration";
import { FFT_SIZE, NoteDetector } from "./pitch-detect";

export interface MicHandlers {
  noteOn(pitch: number, velocity: number): void;
  noteOff(pitch: number): void;
  level(value: number): void;
}

const POLL_MS = 16;
const NOTE_MS = 180;

export class MicInput implements FrameSource {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private detector: NoteDetector | null = null;
  // While set (calibration), frames go here and note detection pauses.
  tap: ((db: Float32Array, t: number, level: number, wave: Float32Array) => void) | null = null;
  binHz = 0;
  bins = FFT_SIZE / 2;
  sampleRate = 0;
  device = "";

  constructor(
    private readonly handlers: MicHandlers,
    private readonly expected: () => number[],
    private readonly paused: () => boolean,
  ) {}

  get active(): boolean {
    return this.stream !== null;
  }

  get calibrated(): boolean {
    return this.active && loadCalibration(this.sampleRate, this.bins) !== null;
  }

  // Raw signal: browser echo cancellation and noise suppression smear piano attacks.
  async start(): Promise<string> {
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(analyser);
    this.sampleRate = ctx.sampleRate;
    this.binHz = ctx.sampleRate / FFT_SIZE;
    this.bins = analyser.frequencyBinCount;
    this.device = stream.getAudioTracks()[0]?.label || "microfone";
    this.reloadCalibration();
    const db = new Float32Array(analyser.frequencyBinCount);
    const wave = new Float32Array(FFT_SIZE);
    this.stream = stream;
    this.ctx = ctx;
    this.timer = setInterval(() => {
      analyser.getFloatFrequencyData(db);
      analyser.getFloatTimeDomainData(wave);
      let sum = 0;
      for (let i = wave.length - 1024; i < wave.length; i++) sum += wave[i] * wave[i];
      const level = Math.min(1, Math.sqrt(sum / 1024) * 5);
      this.handlers.level(level);
      const t = ctx.currentTime * 1000;
      if (this.tap) return this.tap(db, t, level, wave);
      const paused = this.paused();
      const detection = this.detector!.process(db, t, paused ? [] : this.expected(), wave, ctx.sampleRate);
      if (!detection || paused) return;
      for (const pitch of detection.pitches) {
        this.handlers.noteOn(pitch, detection.velocity);
        setTimeout(() => this.handlers.noteOff(pitch), NOTE_MS);
      }
    }, POLL_MS);
    return this.device;
  }

  // A new calibration takes effect at once; a missing one falls back to the default thresholds.
  reloadCalibration(): void {
    this.detector = new NoteDetector(this.binHz, this.bins, loadCalibration(this.sampleRate, this.bins));
  }

  stop(): void {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.tap = null;
    this.handlers.level(0);
  }
}
