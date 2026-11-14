import { CacheStorage, SplendidGrandPiano, type StopFn } from "smplr";

export class PianoSound {
  enabled = true;
  private readonly ctx = new AudioContext({ latencyHint: "interactive" });
  private readonly piano = SplendidGrandPiano(this.ctx, { storage: CacheStorage("learn-piano") });
  private readonly voices = new Map<number, StopFn>();
  private readonly sustained = new Set<number>();
  private pedal = false;

  readonly ready: Promise<unknown> = this.piano.load;

  noteOn(pitch: number, velocity: number): void {
    if (!this.enabled) return;
    void this.ctx.resume();
    this.voices.get(pitch)?.();
    this.sustained.delete(pitch);
    this.voices.set(pitch, this.piano.start({ note: pitch, velocity }));
  }

  noteOff(pitch: number): void {
    if (this.pedal) {
      this.sustained.add(pitch);
      return;
    }
    this.voices.get(pitch)?.();
    this.voices.delete(pitch);
  }

  sustain(down: boolean): void {
    this.pedal = down;
    if (down) return;
    for (const p of this.sustained) this.noteOff(p);
    this.sustained.clear();
  }

  play(pitch: number, velocity: number, delaySec: number, durationSec: number): void {
    if (!this.enabled) return;
    void this.ctx.resume();
    this.piano.start({ note: pitch, velocity, time: this.ctx.currentTime + delaySec, duration: durationSec });
  }

  stopAll(): void {
    this.piano.stop();
    this.voices.clear();
    this.sustained.clear();
  }
}
