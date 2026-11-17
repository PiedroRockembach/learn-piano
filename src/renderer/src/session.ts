import { Midi } from "@tonejs/midi";
import { PianoSound } from "./audio";
import { VirtualKeyboard } from "./keyboard";
import { runCalibration } from "./calibration";
import { MicInput } from "./mic-input";
import type { MidiHandlers } from "./midi-input";
import { Practice, type HandMode, type PracticeStats } from "./practice";
import { midiToScore, type ConvertedScore, type SplitMode } from "./score/convert";

export type InputMode = "midi" | "mic";
export type MidiStarter = (handlers: MidiHandlers) => Promise<void>;
export interface TrackChoice {
  tracks: number[];
  split: SplitMode;
}

// What each platform's interface shows; the session owns the logic shared by desktop and mobile.
export interface SessionView {
  stats(s: PracticeStats): void;
  playState(playing: boolean): void;
  inputStatus(mode: InputMode, ok: boolean, text: string): void;
  level(value: number): void;
  octave(value: number): void;
}

// The AZ Keys KS61BT has 61 keys: MIDI 36 (C2) to 96 (C7) with no octave shift.
export const PHYSICAL_LOW = 36;
export const PHYSICAL_HIGH = 96;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteLabel = (p: number) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
}

export class Session {
  readonly sound = new PianoSound();
  readonly keyboard: VirtualKeyboard;
  readonly practice: Practice;
  private readonly mic: MicInput;
  private octaveShift = 0;
  private readonly held = new Map<number, number>();
  private mode: InputMode;
  private midiNames: string[] = [];
  private micLabel = "";
  private midiError = "";
  // Playback through the speakers keeps echoing for a moment after it stops.
  private micQuietUntil = 0;

  constructor(
    sheet: HTMLElement,
    keyboardEl: HTMLElement,
    private readonly view: SessionView,
    defaultInput: InputMode,
  ) {
    this.keyboard = new VirtualKeyboard(keyboardEl);
    this.practice = new Practice(sheet, this.sound, this.keyboard, view.stats, (playing) => {
      if (!playing) this.micQuietUntil = performance.now() + 800;
      view.playState(playing);
    });
    this.mic = new MicInput(
      { noteOn: (p) => this.heardOn(p), noteOff: (p) => this.heardOff(p), level: view.level },
      () => this.practice.expectedPitches(),
      () => this.practice.isPlaying || performance.now() < this.micQuietUntil,
    );
    const saved = remembered("inputMode");
    this.mode = saved === "mic" || saved === "midi" ? saved : defaultInput;
    this.setOctave(0);
  }

  get inputMode(): InputMode {
    return this.mode;
  }

  get octave(): number {
    return this.octaveShift;
  }

  // Starts the remembered input; resolves to an error message when the microphone could not open.
  async start(midi: MidiStarter): Promise<string | null> {
    midi({
      noteOn: (pitch, velocity) => this.mode === "midi" && this.noteOn(pitch, velocity),
      noteOff: (pitch) => this.noteOff(pitch),
      sustain: (down) => this.sound.sustain(down),
      devicesChanged: (names) => {
        this.midiNames = names;
        this.renderInput();
      },
    }).catch((e) => {
      this.midiError = (e as Error).message;
      this.renderInput();
    });
    return this.setInputMode(this.mode);
  }

  async setInputMode(mode: InputMode): Promise<string | null> {
    this.mode = mode;
    this.practice.autoPlayOtherHand = mode === "midi";
    remember("inputMode", mode);
    let error: string | null = null;
    // Reach only limits a physical MIDI keyboard; the microphone hears any key.
    if (mode === "mic") this.keyboard.setReach(0, 127);
    else this.setOctave(this.octaveShift);
    if (mode === "mic") {
      try {
        this.micLabel = await this.mic.start();
      } catch (e) {
        error = `Microfone indisponível: ${(e as Error).message}`;
      }
    } else {
      this.mic.stop();
    }
    this.renderInput();
    return error;
  }

  // Releases the microphone without forgetting the chosen input (app sent to the background).
  pauseInput(): void {
    if (this.mode === "mic") this.mic.stop();
  }

  async resumeInput(): Promise<string | null> {
    return this.mode === "mic" && !this.mic.active ? this.setInputMode("mic") : null;
  }

  // Whether the open microphone has a saved calibration (thresholds measured for this device and room).
  get micCalibrated(): boolean {
    return this.mic.calibrated;
  }

  // Runs the calibration overlay on the open microphone; resolves to whether a new one was saved.
  async calibrateMic(): Promise<boolean> {
    if (!this.mic.active) return false;
    if (this.practice.isPlaying) this.practice.togglePlay();
    const result = await runCalibration(this.mic);
    if (result) this.mic.reloadCalibration();
    this.renderInput();
    return result !== null;
  }

  private renderInput(): void {
    if (this.mode === "mic") {
      const label = this.mic.active ? `Mic: ${this.micLabel}${this.mic.calibrated ? "" : " (não calibrado)"}` : "Mic: desligado";
      this.view.inputStatus("mic", this.mic.active, label);
    } else if (this.midiError) {
      this.view.inputStatus("midi", false, `MIDI indisponível: ${this.midiError}`);
    } else {
      const ok = this.midiNames.length > 0;
      this.view.inputStatus("midi", ok, ok ? `MIDI: ${this.midiNames.join(", ")}` : "MIDI: nenhum teclado");
    }
  }

  setOctave(next: number): void {
    this.octaveShift = Math.max(-3, Math.min(3, next));
    this.keyboard.setReach(PHYSICAL_LOW + 12 * this.octaveShift, PHYSICAL_HIGH + 12 * this.octaveShift);
    this.view.octave(this.octaveShift);
  }

  noteOn(raw: number, velocity: number): void {
    const pitch = raw + 12 * this.octaveShift;
    this.held.set(raw, pitch);
    this.sound.noteOn(pitch, velocity);
    this.keyboard.set(pitch, "pressed", true);
    this.practice.noteOn(pitch);
  }

  // Releases use the pitch the key was pressed with, so changing octave mid-hold never leaves a stuck note.
  noteOff(raw: number): void {
    const pitch = this.held.get(raw) ?? raw + 12 * this.octaveShift;
    this.held.delete(raw);
    this.sound.noteOff(pitch);
    this.keyboard.set(pitch, "pressed", false);
    this.keyboard.set(pitch, "correct", false);
  }

  // The microphone hears real pitches and the instrument makes its own sound: no octave shift, no echo.
  private heardOn(pitch: number): void {
    this.keyboard.set(pitch, "pressed", true);
    this.practice.noteOn(pitch);
  }

  private heardOff(pitch: number): void {
    this.keyboard.set(pitch, "pressed", false);
    this.keyboard.set(pitch, "correct", false);
  }

  // Returns null when the user cancels the track choice.
  async openSong(
    bytes: Uint8Array,
    title: string,
    hands: HandMode,
    choose: (midi: Midi) => Promise<TrackChoice | null>,
  ): Promise<ConvertedScore | null> {
    const midi = new Midi(bytes);
    const choice = await choose(midi);
    if (!choice) return null;
    const score = midiToScore(midi, title, { tracks: choice.tracks, split: choice.split, splitPoint: 60 });
    await this.practice.load(score, hands);
    return score;
  }

  outOfReach(score: ConvertedScore): boolean {
    return this.mode === "midi" && (score.minPitch < PHYSICAL_LOW || score.maxPitch > PHYSICAL_HIGH);
  }
}
