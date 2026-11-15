import { CursorType, OpenSheetMusicDisplay, type GraphicalNote } from "opensheetmusicdisplay";
import type { PianoSound } from "./audio";
import type { VirtualKeyboard } from "./keyboard";
import { UNITS_PER_QUARTER, type Attack, type ConvertedScore, type Hand } from "./score/convert";

export type HandMode = "both" | "rh" | "lh";
export type ScoreLayout = "line" | "page";

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
// Notes are handed to the audio clock this far ahead, so timing never depends on the JS timer.
const PLAY_LOOKAHEAD_SEC = 0.15;
const PLAY_TICK_MS = 25;

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
  private layout: ScoreLayout = "line";
  private readonly scroller: HTMLElement;
  private playing = false;
  // Off in microphone mode: the speakers would be heard as the player's own notes.
  autoPlayOtherHand = true;
  private playTimer: ReturnType<typeof setInterval> | undefined;
  private playVoices: { end: number; stop: () => void }[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly sound: PianoSound,
    private readonly keyboard: VirtualKeyboard,
    private readonly onStats: (s: PracticeStats) => void,
    private readonly onPlayState: (playing: boolean) => void,
  ) {
    this.scroller = container.parentElement!;
    // "line": one endless system scrolled sideways, zoomed to fill the height; "page": wrapped systems at zoom 1.
    this.osmd = new OpenSheetMusicDisplay(container, {
      backend: "svg",
      autoResize: false,
      autoBeam: true,
      drawTitle: false,
      drawComposer: false,
      drawPartNames: false,
      renderSingleHorizontalStaffline: true,
      followCursor: false,
      cursorsOptions: [{ type: CursorType.Standard, color: "#4f9dff", alpha: 0.35, follow: false }],
    });
    // In single-line mode OSMD wraps into a new system once the line exceeds SheetMaximumWidth / zoom
    // (32767 px by default, a Canvas limit); the SVG backend has no such limit, so the line never wraps.
    this.osmd.EngravingRules.SheetMaximumWidth = 50_000_000;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.refit(), 200);
    }).observe(this.scroller);
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (this.layout !== "line" || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        this.scroller.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
  }

  // OSMD units above the treble staff (chord symbols, tempo) and below the bass staff kept in view.
  private static readonly MARGIN_TOP = 8;
  private static readonly MARGIN_BOTTOM = 5;
  private static readonly UNIT_PX = 10;

  // Fit the two staves, not the whole drawing: one extreme note would otherwise shrink the entire line.
  private fitZoom(): void {
    this.osmd.Zoom = 1;
    this.osmd.render();
    const lines = this.osmd.GraphicSheet?.MusicPages[0]?.MusicSystems[0]?.StaffLines;
    const available = this.scroller.clientHeight;
    if (!lines?.length || available <= 0) return;
    const last = lines[lines.length - 1];
    const top = lines[0].PositionAndShape.AbsolutePosition.y - Practice.MARGIN_TOP;
    const bottom = last.PositionAndShape.AbsolutePosition.y + last.StaffHeight + Practice.MARGIN_BOTTOM;
    const zoom = Math.max(0.5, Math.min(3, available / ((bottom - top) * Practice.UNIT_PX)));
    this.osmd.Zoom = zoom;
    this.osmd.render();
    const svg = this.container.querySelector("svg");
    if (!svg) return;
    const svgTop = svg.getBoundingClientRect().top - this.container.getBoundingClientRect().top;
    const bandTop = svgTop + top * Practice.UNIT_PX * zoom;
    const bandHeight = (bottom - top) * Practice.UNIT_PX * zoom;
    this.scroller.scrollTop = bandTop - (available - bandHeight) / 2;
  }

  private lastSize = "";

  setLayout(layout: ScoreLayout): void {
    this.layout = layout;
    this.scroller.classList.toggle("page-view", layout === "page");
    this.osmd.setOptions({ renderSingleHorizontalStaffline: layout === "line", drawTitle: layout === "page" });
    if (!this.score) return;
    this.relayout();
    this.scrollToCursor(false);
  }

  private relayout(): void {
    this.lastSize = `${this.scroller.clientWidth}x${this.scroller.clientHeight}`;
    if (this.layout === "line") {
      this.fitZoom();
      return;
    }
    this.osmd.Zoom = 1;
    this.osmd.render();
    this.scroller.scrollLeft = 0;
  }

  // Line view depends on the height (zoom), page view on the width (line breaks).
  private refit(): void {
    const { clientWidth: width, clientHeight: height } = this.scroller;
    if (!this.score || width === 0 || height === 0) return;
    const [lastWidth, lastHeight] = this.lastSize.split("x").map(Number);
    const changed = this.layout === "line" ? height !== lastHeight : width !== lastWidth;
    if (!changed) return;
    this.relayout();
    this.scrollToCursor(false);
  }

  private scrollToCursor(smooth = true): void {
    const el = this.osmd.cursor.cursorElement;
    if (!el) return;
    const behavior = smooth ? "smooth" : "auto";
    if (this.layout === "line") {
      this.scroller.scrollTo({ left: Math.max(0, el.offsetLeft - this.scroller.clientWidth * 0.3), behavior });
    } else {
      this.scroller.scrollTo({ top: Math.max(0, el.offsetTop - this.scroller.clientHeight * 0.25), behavior });
    }
  }

  async load(score: ConvertedScore, mode: HandMode): Promise<void> {
    this.stopPlayback(true);
    this.score = score;
    await this.osmd.load(score.musicXml);
    this.relayout();
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
    this.stopPlayback(true);
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
    if (!step || this.stats.finished || this.playing) return;
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
    this.stopPlayback(true);
    const target = Math.max(0, Math.min(this.steps.length - 1, this.stepIndex + delta));
    this.stats.finished = false;
    this.enterStep(target);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  expectedPitches(): number[] {
    return this.expectedNotes().map((a) => a.pitch);
  }

  expectedNotes(): { pitch: number; hand: Hand }[] {
    const step = this.steps[this.stepIndex];
    return step && !this.stats.finished && !this.playing ? step.expected.map(({ pitch, hand }) => ({ pitch, hand })) : [];
  }

  // Score position of the blue cursor, in converter units.
  currentUnit(): number | null {
    return this.cursorUnits[this.cursorIndex] ?? null;
  }

  togglePlay(): void {
    if (this.playing) {
      this.stopPlayback(true);
      this.resumeAtCursor();
    } else {
      this.startPlayback();
    }
  }

  // Plays every staff from the blue cursor on, following the MIDI tempo map, and drags the cursor along.
  private startPlayback(): void {
    const score = this.score;
    const startUnit = this.cursorUnits[this.cursorIndex];
    if (!score || startUnit === undefined) return;
    const notes = [...score.positions.values()]
      .filter((p) => p.unit >= startUnit)
      .sort((a, b) => a.unit - b.unit)
      .flatMap((p) => [...p.rh, ...p.lh].map((a) => ({ ...a, unit: p.unit })));
    if (!notes.length) return;
    this.sound.stopAll();
    this.clearStepMarks();
    const t0 = this.sound.now() + 0.1;
    const origin = score.seconds(startUnit);
    const at = (unit: number) => t0 + score.seconds(unit) - origin;
    const end = Math.max(...notes.map((n) => at(n.unit + n.durationUnits)));
    let next = 0;
    const tick = () => {
      const now = this.sound.now();
      while (next < notes.length && at(notes[next].unit) <= now + PLAY_LOOKAHEAD_SEC) {
        const n = notes[next++];
        const start = at(n.unit);
        const finish = at(n.unit + n.durationUnits);
        const stop = this.sound.schedule(n.pitch, n.velocity, start, finish - start);
        if (stop) this.playVoices.push({ end: finish, stop });
      }
      this.playVoices = this.playVoices.filter((v) => v.end > now);
      let target = this.cursorIndex;
      while (target + 1 < this.cursorUnits.length && at(this.cursorUnits[target + 1]) <= now) target++;
      if (target !== this.cursorIndex) this.moveCursorTo(target);
      if (now >= end) {
        this.stopPlayback(false);
        this.resumeAtCursor();
      }
    };
    this.playing = true;
    this.onPlayState(true);
    tick();
    this.playTimer = setInterval(tick, PLAY_TICK_MS);
  }

  private stopPlayback(cut: boolean): void {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.playTimer);
    if (cut) for (const v of this.playVoices) v.stop();
    this.playVoices = [];
    this.onPlayState(false);
  }

  // Practice picks up at the first step at or after where playback left the cursor.
  private resumeAtCursor(): void {
    if (!this.steps.length) return;
    const index = this.steps.findIndex((s) => s.cursorIndex >= this.cursorIndex);
    this.stats.finished = false;
    this.enterStep(index === -1 ? this.steps.length - 1 : index);
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
    if (this.mode === "both" || !this.score || !this.autoPlayOtherHand) return;
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
    this.scrollToCursor();
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
