import { Midi } from "@tonejs/midi";
import { parseSequenceId } from "../../shared/onlinesequencer";
import type { LibraryEntry, SongRef } from "../../shared/types";
import { PianoSound } from "./audio";
import { VirtualKeyboard } from "./keyboard";
import { MicInput } from "./mic-input";
import { startComputerKeyboard, startMidiInput } from "./midi-input";
import { Practice, type HandMode, type PracticeStats, type ScoreLayout } from "./practice";
import { defaultTrackSelection, describeTracks, midiToScore, type SplitMode } from "./score/convert";
import { renderTheory } from "./theory";

const api = window.learnPiano;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const sound = new PianoSound();
const keyboard = new VirtualKeyboard($("keyboard"));
const practice = new Practice($("sheet"), sound, keyboard, renderStats, renderPlayState);
const handMode = $<HTMLSelectElement>("hand-mode");
const songList = $<HTMLUListElement>("song-list");

// The AZ Keys KS61BT has 61 keys: MIDI 36 (C2) to 96 (C7) with no octave shift.
const PHYSICAL_LOW = 36;
const PHYSICAL_HIGH = 96;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteLabel = (p: number) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

let octave = 0;
const held = new Map<number, number>();

type InputMode = "midi" | "mic";
let inputMode: InputMode = "midi";
let midiNames: string[] = [];
let micLabel = "";
// Playback through the speakers keeps echoing for a moment after it stops.
let micQuietUntil = 0;

let tab: "results" | "library" = "results";
let lastQuery = "";
let page = 0;
let pageTotal = 0;

function setStatus(text: string, isError = false): void {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function renderStats(s: PracticeStats): void {
  const pct = s.done ? Math.round((s.clean / s.done) * 100) : 100;
  const text = s.finished
    ? `Fim! ${s.clean}/${s.total} notas de primeira (${pct}%) · ${s.errors} erros`
    : `${s.done}/${s.total} · precisão ${pct}% · ${s.errors} erros`;
  $("stats-text").textContent = text;
  $("stats").classList.toggle("finished", s.finished);
}

function renderPlayState(playing: boolean): void {
  if (!playing) micQuietUntil = performance.now() + 800;
  const button = $("play");
  button.textContent = playing ? "■ Parar" : "▶ Tocar";
  button.classList.toggle("primary", playing);
}

function setOctave(next: number): void {
  octave = Math.max(-3, Math.min(3, next));
  $("octave-label").textContent = `Oitava ${octave > 0 ? "+" : ""}${octave}`;
  keyboard.setReach(PHYSICAL_LOW + 12 * octave, PHYSICAL_HIGH + 12 * octave);
}

function onNoteOn(raw: number, velocity: number): void {
  const pitch = raw + 12 * octave;
  held.set(raw, pitch);
  sound.noteOn(pitch, velocity);
  keyboard.set(pitch, "pressed", true);
  practice.noteOn(pitch);
}

// Releases use the pitch the key was pressed with, so changing octave mid-hold never leaves a stuck note.
function onNoteOff(raw: number): void {
  const pitch = held.get(raw) ?? raw + 12 * octave;
  held.delete(raw);
  sound.noteOff(pitch);
  keyboard.set(pitch, "pressed", false);
  keyboard.set(pitch, "correct", false);
}

// The microphone hears real pitches and the instrument makes its own sound: no octave shift, no echo.
function onHeardNoteOn(pitch: number): void {
  keyboard.set(pitch, "pressed", true);
  practice.noteOn(pitch);
}

function onHeardNoteOff(pitch: number): void {
  keyboard.set(pitch, "pressed", false);
  keyboard.set(pitch, "correct", false);
}

const mic = new MicInput(
  {
    noteOn: onHeardNoteOn,
    noteOff: onHeardNoteOff,
    level: (v) => {
      $("mic-level").firstElementChild!.setAttribute("style", `width:${Math.round(v * 100)}%`);
    },
  },
  () => practice.expectedPitches(),
  () => practice.isPlaying || performance.now() < micQuietUntil,
);

function renderInputStatus(): void {
  const el = $("midi-status");
  $("mic-level").hidden = inputMode !== "mic";
  if (inputMode === "mic") {
    el.textContent = mic.active ? `Mic: ${micLabel}` : "Mic: desligado";
    el.classList.toggle("ok", mic.active);
  } else {
    el.textContent = midiNames.length ? `MIDI: ${midiNames.join(", ")}` : "MIDI: nenhum teclado";
    el.classList.toggle("ok", midiNames.length > 0);
  }
}

async function setInputMode(mode: InputMode): Promise<void> {
  inputMode = mode;
  $<HTMLSelectElement>("input-mode").value = mode;
  practice.autoPlayOtherHand = mode === "midi";
  try {
    localStorage.setItem("inputMode", mode);
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
  if (mode === "mic") {
    try {
      micLabel = await mic.start();
    } catch (e) {
      setStatus(`Microfone indisponível: ${(e as Error).message}`, true);
      await setInputMode("midi");
      return;
    }
  } else {
    mic.stop();
  }
  renderInputStatus();
}

function renderList(items: (SongRef | LibraryEntry)[]): void {
  songList.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = item.title;
      const detail = document.createElement("small");
      detail.textContent = item.detail ?? item.source;
      li.append(title, detail);
      if ("fileName" in item) li.append(removeButton(item));
      li.addEventListener("click", () => void openSong(item, li));
      return li;
    }),
  );
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = tab === "library" ? "Biblioteca vazia." : "Nada encontrado.";
    songList.append(li);
  }
  if (tab === "results" && lastQuery) {
    for (const site of ["onlinesequencer", "midishow"] as const) {
      const li = document.createElement("li");
      li.className = "browser-link";
      li.textContent = `Não achou? Procurar “${lastQuery}” na ${SITES[site].name} →`;
      li.addEventListener("click", () => void openBrowser(site, lastQuery));
      songList.append(li);
    }
  }
}

function removeButton(entry: LibraryEntry): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "remove";
  button.title = "Remover da biblioteca";
  button.textContent = "×";
  button.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Remover “${entry.title}” da biblioteca?`)) return;
    try {
      await api.removeFromLibrary(entry.fileName);
      await showLibrary();
      setStatus(`“${entry.title}” removida da biblioteca.`);
    } catch (err) {
      setStatus(`Não foi possível remover: ${(err as Error).message}`, true);
    }
  });
  return button;
}

// Online Sequencer comes first: it has more covers and its sequences import straight from a pasted link.
const SITES = {
  onlinesequencer: {
    name: "Online Sequencer",
    search: (q: string) => `https://onlinesequencer.net/sequences?search=${encodeURIComponent(q)}`,
    home: "https://onlinesequencer.net/sequences",
    hint: "Abrindo a Online Sequencer no seu navegador. Abra a sequência, copie o endereço (Ctrl+L, Ctrl+C) e cole na busca daqui.",
  },
  midishow: {
    name: "MidiShow",
    search: (q: string) => `https://www.midishow.com/en/search/result?q=${encodeURIComponent(q)}`,
    home: "https://www.midishow.com/en",
    hint: "Abrindo a MidiShow no seu navegador. Baixe o arquivo em MIDI (.mid): ao terminar em ~/Downloads, ele abre aqui sozinho.",
  },
};

function openBrowser(site: keyof typeof SITES, query: string): Promise<void> {
  const s = SITES[site];
  setStatus(s.hint);
  return api.openBrowser(query ? s.search(query) : s.home);
}

function askTitle(suggestion: string): Promise<string | null> {
  const dialog = $<HTMLDialogElement>("title-dialog");
  const input = $<HTMLInputElement>("title-input");
  input.value = suggestion;
  dialog.returnValue = "";
  dialog.showModal();
  input.select();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok" ? input.value.trim() : null), {
      once: true,
    });
  });
}

async function importSequence(link: string, id: string): Promise<void> {
  const title = await askTitle(lastQuery || `Online Sequencer #${id}`);
  if (!title) return;
  setStatus("Baixando a sequência da Online Sequencer…");
  try {
    const entry = await api.importOnlineSequence(link, title);
    $<HTMLInputElement>("search-input").value = "";
    openImported(entry);
  } catch (e) {
    const message = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    setStatus(`Não foi possível importar: ${message}`, true);
  }
}

async function runSearch(query: string, newPage: number): Promise<void> {
  if (!query) return;
  setStatus("Buscando…");
  try {
    const res = await api.search(query, newPage);
    lastQuery = query;
    page = newPage;
    pageTotal = res.pageTotal;
    switchTab("results", false);
    renderList(res.items);
    $("pager").hidden = pageTotal <= 1;
    $("page-label").textContent = `${page + 1}/${pageTotal}`;
    setStatus(`${res.total} resultados`);
  } catch (e) {
    setStatus(`Erro na busca: ${(e as Error).message}`, true);
  }
}

async function showLibrary(): Promise<void> {
  renderList(await api.listLibrary());
  $("pager").hidden = true;
}

function switchTab(next: "results" | "library", reload = true): void {
  tab = next;
  document.querySelectorAll<HTMLButtonElement>("aside nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === next);
  });
  if (!reload) return;
  if (next === "library") void showLibrary();
  else if (lastQuery) void runSearch(lastQuery, page);
  else renderList([]);
}

async function openSong(ref: SongRef | LibraryEntry, li: HTMLElement): Promise<void> {
  songList.querySelectorAll("li").forEach((x) => x.classList.toggle("selected", x === li));
  setStatus(`Baixando “${ref.title}”…`);
  try {
    const bytes = "fileName" in ref ? await api.readLibrary(ref.fileName) : (await api.download(ref)).bytes;
    const midi = new Midi(bytes);
    const choice = await chooseTracks(midi);
    if (!choice) {
      setStatus("");
      return;
    }
    setStatus("Gerando partitura…");
    const score = midiToScore(midi, ref.title, { tracks: choice.tracks, split: choice.split, splitPoint: 60 });
    await practice.load(score, handMode.value as HandMode);
    renderTheory($("theory"), score);
    $("song-title").textContent = ref.title;
    const outOfReach = score.minPitch < PHYSICAL_LOW || score.maxPitch > PHYSICAL_HIGH;
    setStatus(
      outOfReach
        ? `A música vai de ${noteLabel(score.minPitch)} a ${noteLabel(score.maxPitch)}, além das 61 teclas: use Oitava − / + (Z / X) quando a nota pedida cair na área escura.`
        : "",
    );
  } catch (e) {
    setStatus(`Não foi possível abrir: ${(e as Error).message}`, true);
  }
}

function chooseTracks(midi: Midi): Promise<{ tracks: number[]; split: SplitMode } | null> {
  const dialog = $<HTMLDialogElement>("track-dialog");
  const list = $<HTMLUListElement>("track-list");
  const tracks = describeTracks(midi);
  const selected = new Set(defaultTrackSelection(tracks));
  list.replaceChildren(
    ...tracks
      .filter((t) => t.noteCount > 0)
      .map((t) => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = String(t.index);
        box.checked = selected.has(t.index);
        const text = document.createElement("span");
        text.textContent = `${t.name} — ${t.isPercussion ? "bateria" : t.instrument} (${t.noteCount} notas)`;
        label.append(box, text);
        li.append(label);
        return li;
      }),
  );
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        if (dialog.returnValue !== "ok") return resolve(null);
        const chosen = [...list.querySelectorAll<HTMLInputElement>("input:checked")].map((b) => Number(b.value));
        resolve(chosen.length ? { tracks: chosen, split: $<HTMLSelectElement>("split-mode").value as SplitMode } : null);
      },
      { once: true },
    );
  });
}

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const query = $<HTMLInputElement>("search-input").value.trim();
  const sequenceId = parseSequenceId(query);
  if (sequenceId) void importSequence(query, sequenceId);
  else void runSearch(query, 0);
});
$("prev-page").addEventListener("click", () => page > 0 && void runSearch(lastQuery, page - 1));
$("next-page").addEventListener("click", () => page + 1 < pageTotal && void runSearch(lastQuery, page + 1));
document.querySelectorAll<HTMLButtonElement>("aside nav button").forEach((b) => {
  b.addEventListener("click", () => switchTab(b.dataset.tab as "results" | "library"));
});
document.querySelectorAll<HTMLButtonElement>("#view-tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#view-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $("theory").hidden = b.dataset.view !== "theory";
  });
});
renderTheory($("theory"), null);
$("octave-down").addEventListener("click", () => setOctave(octave - 1));
$("octave-up").addEventListener("click", () => setOctave(octave + 1));
setOctave(0);
handMode.addEventListener("change", () => practice.setMode(handMode.value as HandMode));
$("restart").addEventListener("click", () => practice.restart());
$("play").addEventListener("click", () => practice.togglePlay());
const scoreLayout = $<HTMLSelectElement>("score-layout");
try {
  if (localStorage.getItem("scoreLayout") === "page") scoreLayout.value = "page";
} catch {
  // storage unavailable: default to line view
}
practice.setLayout(scoreLayout.value as ScoreLayout);
scoreLayout.addEventListener("change", () => {
  practice.setLayout(scoreLayout.value as ScoreLayout);
  try {
    localStorage.setItem("scoreLayout", scoreLayout.value);
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
});
const keyboardToggle = $<HTMLInputElement>("keyboard-toggle");
const showKeyboard = (on: boolean) => {
  keyboardToggle.checked = on;
  document.body.classList.toggle("no-keyboard", !on);
  try {
    localStorage.setItem("showKeyboard", on ? "1" : "0");
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
};
try {
  showKeyboard(localStorage.getItem("showKeyboard") !== "0");
} catch {
  showKeyboard(true);
}
keyboardToggle.addEventListener("change", () => showKeyboard(keyboardToggle.checked));
$<HTMLInputElement>("sound-toggle").addEventListener("change", (e) => {
  sound.enabled = (e.target as HTMLInputElement).checked;
});
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === " " && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    practice.togglePlay();
  } else if (e.key === "ArrowRight") practice.skip(1);
  else if (e.key === "ArrowLeft") practice.skip(-1);
  else if (e.key === "r" && !e.ctrlKey) practice.restart();
  else if (e.key === "z" && !e.ctrlKey) setOctave(octave - 1);
  else if (e.key === "x" && !e.ctrlKey) setOctave(octave + 1);
});

$<HTMLSelectElement>("input-mode").addEventListener("change", (e) => {
  void setInputMode((e.target as HTMLSelectElement).value as InputMode);
});
try {
  if (localStorage.getItem("inputMode") === "mic") void setInputMode("mic");
} catch {
  // storage unavailable: start with MIDI
}

startComputerKeyboard({ noteOn: onNoteOn, noteOff: onNoteOff });
startMidiInput({
  noteOn: (pitch, velocity) => inputMode === "midi" && onNoteOn(pitch, velocity),
  noteOff: onNoteOff,
  sustain: (down) => sound.sustain(down),
  devicesChanged: (names) => {
    midiNames = names;
    renderInputStatus();
  },
}).catch((e) => {
  $("midi-status").textContent = `MIDI indisponível: ${(e as Error).message}`;
});

$("open-browser").addEventListener("click", () => {
  void openBrowser("onlinesequencer", $<HTMLInputElement>("search-input").value.trim());
});
function openImported(entry: LibraryEntry): void {
  switchTab("library", false);
  void showLibrary().then(() => void openSong(entry, songList.querySelector("li") ?? document.createElement("li")));
}
api.onImported(openImported);
$("import-file").addEventListener("click", async () => {
  try {
    const entry = await api.importFile();
    if (entry) openImported(entry);
  } catch (e) {
    const message = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    setStatus(`Não foi possível adicionar: ${message}`, true);
  }
});

setStatus("Carregando som de piano…");
sound.ready.then(
  async () => {
    const { pdmx } = await api.status();
    setStatus(
      pdmx
        ? "Busque uma música para começar."
        : "Busque uma música. (Fonte PDMX não instalada: rode `npm run setup:pdmx` uma vez.)",
    );
  },
  () => setStatus("Som de piano não carregou (sem internet?). O resto funciona.", true),
);
