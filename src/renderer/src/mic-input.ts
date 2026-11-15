import { FFT_SIZE, NoteDetector } from "./pitch-detect";

export interface MicHandlers {
  noteOn(pitch: number, velocity: number): void;
  noteOff(pitch: number): void;
  level(value: number): void;
}

const POLL_MS = 16;
const NOTE_MS = 180;

export class MicInput {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly handlers: MicHandlers,
    private readonly expected: () => number[],
    private readonly paused: () => boolean,
  ) {}

  get active(): boolean {
    return this.stream !== null;
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
    const detector = new NoteDetector(ctx.sampleRate / FFT_SIZE);
    const db = new Float32Array(analyser.frequencyBinCount);
    const wave = new Float32Array(FFT_SIZE);
    this.stream = stream;
    this.ctx = ctx;
    this.timer = setInterval(() => {
      analyser.getFloatFrequencyData(db);
      analyser.getFloatTimeDomainData(wave);
      let sum = 0;
      for (let i = wave.length - 1024; i < wave.length; i++) sum += wave[i] * wave[i];
      this.handlers.level(Math.min(1, Math.sqrt(sum / 1024) * 5));
      const paused = this.paused();
      const detection = detector.process(db, ctx.currentTime * 1000, paused ? [] : this.expected());
      if (!detection || paused) return;
      for (const pitch of detection.pitches) {
        this.handlers.noteOn(pitch, detection.velocity);
        setTimeout(() => this.handlers.noteOff(pitch), NOTE_MS);
      }
    }, POLL_MS);
    return stream.getAudioTracks()[0]?.label || "microfone";
  }

  stop(): void {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.handlers.level(0);
  }
}
