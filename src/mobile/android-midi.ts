import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { MidiHandlers } from "../renderer/src/midi-input";
import { startMidiInput } from "../renderer/src/midi-input";
import { isNative } from "./platform";

interface MidiInputPlugin {
  start(): Promise<void>;
  addListener(event: "message", cb: (e: { data: number[] }) => void): Promise<PluginListenerHandle>;
  addListener(event: "devices", cb: (e: { names: string[] }) => void): Promise<PluginListenerHandle>;
}

const MidiInput = registerPlugin<MidiInputPlugin>("MidiInput");

// The Android WebView has no Web MIDI, so USB devices come through a small native plugin (android.media.midi).
export async function startAndroidMidi(handlers: MidiHandlers): Promise<void> {
  if (!isNative) return startMidiInput(handlers);
  await MidiInput.addListener("devices", (e) => handlers.devicesChanged(e.names));
  await MidiInput.addListener("message", ({ data }) => {
    if (data.length < 2) return;
    const kind = data[0] & 0xf0;
    const a = data[1];
    const b = data[2] ?? 0;
    if (kind === 0x90 && b > 0) handlers.noteOn(a, b);
    else if (kind === 0x80 || (kind === 0x90 && b === 0)) handlers.noteOff(a);
    else if (kind === 0xb0 && a === 64) handlers.sustain(b >= 64);
  });
  await MidiInput.start();
}
