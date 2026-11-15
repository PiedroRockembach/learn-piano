const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export type KeyMark = "expected-rh" | "expected-lh" | "pressed" | "wrong" | "correct";

export class VirtualKeyboard {
  private keys = new Map<number, HTMLElement>();
  private reach: [number, number] | null = null;

  constructor(private readonly root: HTMLElement) {
    this.setRange(36, 96);
  }

  setRange(low: number, high: number): void {
    while (BLACK.has(low % 12)) low--;
    while (BLACK.has(high % 12)) high++;
    this.root.replaceChildren();
    this.keys.clear();
    const whites: number[] = [];
    for (let p = low; p <= high; p++) if (!BLACK.has(p % 12)) whites.push(p);
    const w = 100 / whites.length;
    for (let p = low; p <= high; p++) {
      const el = document.createElement("div");
      const black = BLACK.has(p % 12);
      el.className = black ? "key black" : "key white";
      const whiteIndex = whites.filter((x) => x < p).length;
      el.style.left = black ? `${whiteIndex * w - w * 0.3}%` : `${whiteIndex * w}%`;
      el.style.width = black ? `${w * 0.6}%` : `${w}%`;
      if (p % 12 === 0) el.dataset.label = `${NAMES[0]}${Math.floor(p / 12) - 1}`;
      this.root.appendChild(el);
      this.keys.set(p, el);
    }
    if (this.reach) this.setReach(...this.reach);
  }

  // Keys the physical keyboard cannot reach at the current octave shift are dimmed.
  setReach(low: number, high: number): void {
    this.reach = [low, high];
    this.keys.forEach((el, p) => el.classList.toggle("out", p < low || p > high));
  }

  set(pitch: number, mark: KeyMark, on: boolean): void {
    this.keys.get(pitch)?.classList.toggle(mark, on);
  }

  flash(pitch: number, mark: KeyMark, ms = 350): void {
    this.set(pitch, mark, true);
    setTimeout(() => this.set(pitch, mark, false), ms);
  }

  clear(mark: KeyMark): void {
    this.keys.forEach((el) => el.classList.remove(mark));
  }
}
