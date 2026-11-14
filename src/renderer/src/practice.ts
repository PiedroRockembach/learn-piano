import { CursorType, OpenSheetMusicDisplay, type GraphicalNote } from "opensheetmusicdisplay";
import type { PianoSound } from "./audio";
import type { VirtualKeyboard } from "./keyboard";
import { UNITS_PER_QUARTER, type Attack, type ConvertedScore, type Hand } from "./score/convert";

export type HandMode = "both" | "rh" | "lh";

export interface PracticeStats {
  done: number;
  total: number;
  clean: number;
  errors: number;
  finished: boolean;
}

interface Step {
  cursorIndex: number;
  unit: number;
  expected: (Attack & { hand: Hand })[];
}

const COLOR_CLEAN = "#1f9d55";
const COLOR_FIXED = "#d9822b";

export class Practice {
  private readonly osmd: OpenSheetMusicDisplay;
  private score: ConvertedScore | null = null;
  private cursorUnits: number[] = [];
  private steps: Step[] = [];
  private stepIndex = 0;
  private cursorIndex = 0;
  private hits = new Set<number>();
  private stepHadError = false;
  private stats: PracticeStats = { done: 0, total: 0, clean: 0, errors: 0, finished: false };
  private mode: HandMode = "both";

  constructor(
    container: HTMLElement,
    private readonly sound: PianoSound,
    private readonly keyboard: VirtualKeyboard,
    private readonly onStats: (s: PracticeStats) => void,
  ) {
    this.osmd = new OpenSheetMusicDisplay(container, {
      backend: "svg",
      autoResize: true,
      autoBeam: true,
      drawTitle: true,
      drawComposer: false,
      drawPartNames: false,
      followCursor: true,
      cursorsOptions: [{ type: CursorType.Standard, color: "#4f9dff", alpha: 0.35, follow: true }],
    });
  }

  async load(score: ConvertedScore, mode: HandMode): Promise<void> {
    this.score = score;
    await this.osmd.load(score.musicXml);
    this.osmd.render();
    this.cursorUnits = this.collectCursorUnits();
    this.keyboard.setRange(Math.min(36, score.minPitch), Math.max(96, score.maxPitch));
    this.setMode(mode);
  }

  setMode(mode: HandMode): void {
    this.mode = mode;
    if (!this.score) return;
    const positions = this.score.positions;
    this.steps = [];
    this.cursorUnits.forEach((unit, cursorIndex) => {
      const pos = positions.get(unit);
      if (!pos) return;
      const expected = this.handsFor(mode).flatMap((h) => pos[h].map((a) => ({ ...a, hand: h })));
      if (expected.length) this.steps.push({ cursorIndex, unit, expected });
    });
    this.restart();
  }

  restart(): void {
    if (!this.score) return;
    this.sound.stopAll();
    this.osmd.render();
    this.osmd.cursor.reset();
    this.osmd.cursor.show();
    this.cursorIndex = 0;
    this.stats = { done: 0, total: this.steps.length, clean: 0, errors: 0, finished: false };
    this.enterStep(0);
  }

  noteOn(pitch: number): void {
    const step = this.steps[this.stepIndex];
    if (!step || this.stats.finished) return;
    if (step.expected.some((a) => a.pitch === pitch)) {
      this.hits.add(pitch);
      this.keyboard.set(pitch, "correct", true);
      if (step.expected.every((a) => this.hits.has(a.pitch))) this.completeStep();
    } else {
      this.stats.errors++;
      this.stepHadError = true;
      this.keyboard.flash(pitch, "wrong");
      this.onStats(this.stats);
    }
  }

  skip(delta: number): void {
    const target = Math.max(0, Math.min(this.steps.length - 1, this.stepIndex + delta));
    this.stats.finished = false;
    this.enterStep(target);
  }

  private completeStep(): void {
    const step = this.steps[this.stepIndex];
    this.colorCurrentNotes(this.stepHadError ? COLOR_FIXED : COLOR_CLEAN);
    this.stats.done++;
    if (!this.stepHadError) this.stats.clean++;
    this.playOtherHand(step);
    if (this.stepIndex + 1 >= this.steps.length) {
      this.stats.finished = true;
      this.clearStepMarks();
      this.onStats(this.stats);
      return;
    }
    this.enterStep(this.stepIndex + 1);
  }

  private enterStep(index: number): void {
    this.clearStepMarks();
    this.stepIndex = index;
    this.hits.clear();
    this.stepHadError = false;
    const step = this.steps[index];
    if (step) {
      this.moveCursorTo(step.cursorIndex);
      for (const a of step.expected) this.keyboard.set(a.pitch, a.hand === "rh" ? "expected-rh" : "expected-lh", true);
    }
    this.onStats(this.stats);
  }

  private clearStepMarks(): void {
    this.keyboard.clear("expected-rh");
    this.keyboard.clear("expected-lh");
    this.keyboard.clear("correct");
  }

  // In single-hand mode, the other hand plays by itself between this step and the next one.
  private playOtherHand(step: Step): void {
    if (this.mode === "both" || !this.score) return;
    const other: Hand = this.mode === "rh" ? "lh" : "rh";
    const nextUnit = this.steps[this.stepIndex + 1]?.unit ?? Infinity;
    const secPerUnit = 60 / this.score.bpm / UNITS_PER_QUARTER;
    for (const [unit, pos] of this.score.positions) {
      if (unit < step.unit || unit >= nextUnit) continue;
      for (const a of pos[other]) {
        this.sound.play(a.pitch, a.velocity, (unit - step.unit) * secPerUnit, a.durationUnits * secPerUnit);
      }
    }
  }

  private moveCursorTo(target: number): void {
    const cursor = this.osmd.cursor;
    while (this.cursorIndex < target && !cursor.Iterator.EndReached) {
      cursor.next();
      this.cursorIndex++;
    }
    while (this.cursorIndex > target) {
      cursor.previous();
      this.cursorIndex--;
    }
  }

  private collectCursorUnits(): number[] {
    const cursor = this.osmd.cursor;
    cursor.reset();
    const units: number[] = [];
    while (!cursor.Iterator.EndReached) {
      units.push(Math.round(cursor.Iterator.currentTimeStamp.RealValue * UNITS_PER_QUARTER * 4));
      cursor.next();
    }
    cursor.reset();
    return units;
  }

  private colorCurrentNotes(color: string): void {
    const staves: number[] = this.handsFor(this.mode).map((h) => (h === "rh" ? 0 : 1));
    for (const gn of this.osmd.cursor.GNotesUnderCursor()) {
      if (gn.sourceNote.isRest()) continue;
      if (!staves.includes(gn.sourceNote.ParentStaff.idInMusicSheet)) continue;
      const el = (gn as GraphicalNote & { getSVGGElement?: () => SVGGElement }).getSVGGElement?.();
      el?.querySelectorAll("path, rect").forEach((p) => {
        p.setAttribute("fill", color);
        p.setAttribute("stroke", color);
      });
    }
  }

  private handsFor(mode: HandMode): Hand[] {
    return mode === "both" ? ["rh", "lh"] : [mode];
  }
}
