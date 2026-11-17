import { NoteDetector, type MicCalibration } from "./pitch-detect";

// Calibration: measure the room's noise per frequency, then have the player strike reference notes
// (one of them softly) to learn how big a real attack is with this piano, this mic and this room.

export type CalibrationStep = { kind: "silence"; ms: number } | { kind: "note"; pitch: number; label: string; soft?: boolean };

export const CALIBRATION_STEPS: CalibrationStep[] = [
  { kind: "silence", ms: 3000 },
  { kind: "note", pitch: 60, label: "Dó4 (Dó central)" },
  { kind: "note", pitch: 72, label: "Dó5" },
  { kind: "note", pitch: 48, label: "Dó3" },
  { kind: "note", pitch: 84, label: "Dó6" },
  { kind: "note", pitch: 60, label: "Dó4 bem suave", soft: true },
];

const STORAGE_KEY = "micCalibration";
const SOLFEGE = ["Dó", "Dó♯", "Ré", "Ré♯", "Mi", "Fá", "Fá♯", "Sol", "Sol♯", "Lá", "Lá♯", "Si"];
export const solfege = (p: number) => `${SOLFEGE[p % 12]}${Math.floor(p / 12) - 1}`;

export function loadCalibration(sampleRate: number, bins: number): MicCalibration | null {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as MicCalibration | null;
    return c && c.version === 1 && c.sampleRate === sampleRate && c.noiseDb.length === bins ? c : null;
  } catch {
    return null;
  }
}

export function saveCalibration(c: MicCalibration): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // storage unavailable: the calibration only lasts for this session
  }
}

export function hasCalibration(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export type NoteResult =
  | { status: "listening" }
  | { status: "ok"; gainDb: number }
  | { status: "wrong"; heard: number }
  | { status: "unclear" };

// Pure part: fed with AnalyserNode frames, no audio or DOM of its own.
export class Calibrator {
  private readonly silence: Float32Array[] = [];
  private noiseDb: number[] = [];
  private ambientGain = -Infinity;
  private readonly gains: number[] = [];
  private softGain: number | null = null;
  private detector: NoteDetector | null = null;

  constructor(
    private readonly binHz: number,
    private readonly bins: number,
    private readonly sampleRate: number,
  ) {}

  silenceFrame(db: Float32Array): void {
    this.silence.push(Float32Array.from(db));
  }

  // Noise floor per bin = 90th percentile of the silent frames; then replay them to find the biggest
  // "attack" the room makes on its own.
  finishSilence(): void {
    const n = this.silence.length;
    this.noiseDb = Array.from({ length: this.bins }, (_, k) => {
      const v = this.silence.map((f) => f[k]).sort((x, y) => x - y);
      return n ? Math.round(v[Math.min(n - 1, Math.floor(n * 0.9))] * 10) / 10 : -200;
    });
    const probe = new NoteDetector(this.binHz, this.bins, this.partial(), -Infinity);
    this.silence.forEach((f, i) => {
      probe.process(f, i * 16, []);
      if (probe.lastAttack) this.ambientGain = Math.max(this.ambientGain, probe.lastAttack.gainDb);
    });
  }

  startNote(): void {
    this.detector = new NoteDetector(this.binHz, this.bins, this.partial(), -Infinity);
  }

  noteFrame(db: Float32Array, t: number, step: Extract<CalibrationStep, { kind: "note" }>, wave?: Float32Array): NoteResult {
    const d = this.detector!.process(db, t, [step.pitch], wave, this.sampleRate);
    if (!d) return { status: "listening" };
    if (d.expectedHit) {
      if (step.soft) this.softGain = d.gainDb;
      else this.gains.push(d.gainDb);
      return { status: "ok", gainDb: d.gainDb };
    }
    return d.pitches.length ? { status: "wrong", heard: d.pitches[0] } : { status: "unclear" };
  }

  private partial(): MicCalibration {
    return { version: 1, sampleRate: this.sampleRate, noiseDb: this.noiseDb, minGainDb: 0, device: "", date: "" };
  }

  // Attacks must beat both the room (with margin) and stay below the softest real note played.
  result(device: string): MicCalibration {
    const soft = this.softGain ?? (this.gains.length ? Math.min(...this.gains) - 10 : 12);
    const ambient = Number.isFinite(this.ambientGain) ? this.ambientGain + 4 : 6;
    const minGainDb = Math.round(Math.min(25, Math.max(6, ambient, soft - 4)) * 10) / 10;
    return { ...this.partial(), minGainDb, device, date: new Date().toISOString() };
  }

  get summary(): { ambientDb: number; softDb: number | null } {
    return { ambientDb: this.ambientGain, softDb: this.softGain };
  }
}

// Interface shared by desktop and mobile: an overlay driven by frames from the microphone.
export interface FrameSource {
  readonly binHz: number;
  readonly bins: number;
  readonly sampleRate: number;
  readonly device: string;
  tap: ((db: Float32Array, t: number, level: number, wave: Float32Array) => void) | null;
}

export function runCalibration(source: FrameSource): Promise<MicCalibration | null> {
  const overlay = document.createElement("div");
  overlay.className = "calib-overlay";
  overlay.innerHTML = `
    <div class="calib-card" role="dialog" aria-label="Calibrar microfone">
      <h2>Calibrar o microfone</h2>
      <p class="calib-text"></p>
      <div class="calib-meter"><i></i></div>
      <ol class="calib-steps"></ol>
      <div class="calib-actions">
        <button type="button" class="calib-cancel">Cancelar</button>
        <button type="button" class="calib-skip" hidden>Pular nota</button>
        <button type="button" class="calib-go primary">Começar</button>
      </div>
    </div>`;
  document.body.append(overlay);
  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector(sel) as T;
  const text = $("p.calib-text");
  const meter = $(".calib-meter i");
  const go = $<HTMLButtonElement>(".calib-go");
  const skip = $<HTMLButtonElement>(".calib-skip");
  const steps = $<HTMLOListElement>(".calib-steps");
  steps.replaceChildren(
    ...CALIBRATION_STEPS.map((s) => {
      const li = document.createElement("li");
      li.textContent = s.kind === "silence" ? "Silêncio" : s.label;
      return li;
    }),
  );
  text.textContent =
    "Deixe o microfone onde ele fica durante a prática e o ambiente como costuma estar. Primeiro, 3 segundos de silêncio; depois toque cada nota pedida, uma de cada vez.";

  const cal = new Calibrator(source.binHz, source.bins, source.sampleRate);
  let index = -1;
  let stepStart = 0;
  let failures = 0;
  let advancing = false;
  let resolve!: (c: MicCalibration | null) => void;
  const done = new Promise<MicCalibration | null>((r) => (resolve = r));

  const mark = (i: number, state: "active" | "ok" | "skipped") => {
    steps.children[i]?.classList.remove("active");
    steps.children[i]?.classList.add(state);
  };
  const close = (c: MicCalibration | null) => {
    source.tap = null;
    overlay.remove();
    resolve(c);
  };

  const next = () => {
    advancing = false;
    index++;
    failures = 0;
    skip.hidden = true;
    const step = CALIBRATION_STEPS[index];
    if (!step) return finish();
    mark(index, "active");
    stepStart = performance.now();
    if (step.kind === "silence") {
      text.textContent = "Silêncio… não toque nada por 3 segundos.";
    } else {
      cal.startNote();
      text.textContent = `Toque ${step.label}${step.soft ? ", o mais suave que você costuma tocar" : ""}.`;
    }
  };

  const finish = () => {
    const c = cal.result(source.device);
    const { softDb } = cal.summary;
    text.textContent =
      `Pronto! Ataques com menos de ${c.minGainDb.toFixed(0)} dB acima do ambiente agora são ignorados` +
      (softDb === null ? "." : ` (sua nota suave deu ${softDb.toFixed(0)} dB).`);
    go.textContent = "Concluir";
    go.hidden = false;
    go.onclick = () => {
      saveCalibration(c);
      close(c);
    };
    source.tap = null;
  };

  source.tap = (db, t, level, wave) => {
    meter.style.width = `${Math.round(level * 100)}%`;
    const step = CALIBRATION_STEPS[index];
    if (!step || advancing) return;
    if (step.kind === "silence") {
      cal.silenceFrame(db);
      if (performance.now() - stepStart >= step.ms) {
        cal.finishSilence();
        mark(index, "ok");
        next();
      }
      return;
    }
    const r = cal.noteFrame(db, t, step, wave);
    if (r.status === "ok") {
      mark(index, "ok");
      text.textContent = `Ouvi ${step.label.split(" ")[0]} ✓`;
      advancing = true;
      setTimeout(next, 700);
    } else if (r.status === "wrong" || r.status === "unclear") {
      failures++;
      text.textContent =
        r.status === "wrong"
          ? `Ouvi ${solfege(r.heard)}, não ${step.label.split(" ")[0]}. Toque de novo, uma nota só.`
          : `Não reconheci. Toque ${step.label} de novo, sem outras notas soando.`;
      skip.hidden = failures < 2;
    }
  };

  go.onclick = () => {
    go.hidden = true;
    next();
  };
  skip.onclick = () => {
    mark(index, "skipped");
    next();
  };
  $<HTMLButtonElement>(".calib-cancel").onclick = () => close(null);
  return done;
}
