export interface MidiHandlers {
  noteOn(pitch: number, velocity: number): void;
  noteOff(pitch: number): void;
  sustain(down: boolean): void;
  devicesChanged(names: string[]): void;
}

const IGNORED_PORTS = /midi through/i;

export async function startMidiInput(handlers: MidiHandlers): Promise<void> {
  const access = await navigator.requestMIDIAccess();

  const onMessage = (e: MIDIMessageEvent) => {
    const data = e.data;
    if (!data || data.length < 2) return;
    const kind = data[0] & 0xf0;
    const a = data[1];
    const b = data[2] ?? 0;
    if (kind === 0x90 && b > 0) handlers.noteOn(a, b);
    else if (kind === 0x80 || (kind === 0x90 && b === 0)) handlers.noteOff(a);
    else if (kind === 0xb0 && a === 64) handlers.sustain(b >= 64);
  };

  const bind = () => {
    const names: string[] = [];
    access.inputs.forEach((input) => {
      if (IGNORED_PORTS.test(input.name ?? "")) return;
      input.onmidimessage = onMessage;
      names.push(input.name ?? input.id);
    });
    handlers.devicesChanged(names);
  };

  access.onstatechange = bind;
  bind();
}

// Fallback for testing without a MIDI keyboard: a row of computer keys mapped from C4.
const COMPUTER_KEYS = "awsedftgyhujkolp;";

export function startComputerKeyboard(handlers: Pick<MidiHandlers, "noteOn" | "noteOff">): void {
  const held = new Set<string>();
  const pitchOf = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.ctrlKey || e.altKey || e.metaKey) return -1;
    const i = COMPUTER_KEYS.indexOf(e.key.toLowerCase());
    return i < 0 ? -1 : 60 + i;
  };
  window.addEventListener("keydown", (e) => {
    const p = pitchOf(e);
    if (p < 0 || held.has(e.key)) return;
    held.add(e.key);
    handlers.noteOn(p, 90);
  });
  window.addEventListener("keyup", (e) => {
    const p = pitchOf(e);
    if (p < 0) return;
    held.delete(e.key);
    handlers.noteOff(p);
  });
}
