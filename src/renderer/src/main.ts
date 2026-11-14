import { Midi } from "@tonejs/midi";
import type { LibraryEntry, SongRef } from "../../shared/types";
import { PianoSound } from "./audio";
import { VirtualKeyboard } from "./keyboard";
import { startComputerKeyboard, startMidiInput } from "./midi-input";
import { Practice, type HandMode, type PracticeStats } from "./practice";
import { defaultTrackSelection, describeTracks, midiToScore, type SplitMode } from "./score/convert";

const api = window.learnPiano;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const sound = new PianoSound();
const keyboard = new VirtualKeyboard($("keyboard"));
const practice = new Practice($("sheet"), sound, keyboard, renderStats);
const handMode = $<HTMLSelectElement>("hand-mode");
const songList = $<HTMLUListElement>("song-list");

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

function onNoteOn(pitch: number, velocity: number): void {
  sound.noteOn(pitch, velocity);
  keyboard.set(pitch, "pressed", true);
  practice.noteOn(pitch);
}

function onNoteOff(pitch: number): void {
  sound.noteOff(pitch);
  keyboard.set(pitch, "pressed", false);
  keyboard.set(pitch, "correct", false);
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
    const li = document.createElement("li");
    li.className = "browser-link";
    li.textContent = `Não achou? Procurar “${lastQuery}” na MidiShow →`;
    li.addEventListener("click", () => void openBrowser(lastQuery));
    songList.append(li);
  }
}

function openBrowser(query: string): Promise<void> {
  const url = query
    ? `https://www.midishow.com/en/search/result?q=${encodeURIComponent(query)}`
    : "https://www.midishow.com/en";
  setStatus("Abrindo no seu navegador. Baixe o arquivo em MIDI (.mid): ao terminar em ~/Downloads, ele abre aqui sozinho.");
  return api.openBrowser(url);
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
    $("song-title").textContent = ref.title;
    setStatus("");
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
  void runSearch($<HTMLInputElement>("search-input").value.trim(), 0);
});
$("prev-page").addEventListener("click", () => page > 0 && void runSearch(lastQuery, page - 1));
$("next-page").addEventListener("click", () => page + 1 < pageTotal && void runSearch(lastQuery, page + 1));
document.querySelectorAll<HTMLButtonElement>("aside nav button").forEach((b) => {
  b.addEventListener("click", () => switchTab(b.dataset.tab as "results" | "library"));
});
handMode.addEventListener("change", () => practice.setMode(handMode.value as HandMode));
$("restart").addEventListener("click", () => practice.restart());
$<HTMLInputElement>("sound-toggle").addEventListener("change", (e) => {
  sound.enabled = (e.target as HTMLInputElement).checked;
});
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "ArrowRight") practice.skip(1);
  else if (e.key === "ArrowLeft") practice.skip(-1);
  else if (e.key === "r" && !e.ctrlKey) practice.restart();
});

startComputerKeyboard({ noteOn: onNoteOn, noteOff: onNoteOff });
startMidiInput({
  noteOn: onNoteOn,
  noteOff: onNoteOff,
  sustain: (down) => sound.sustain(down),
  devicesChanged: (names) => {
    const el = $("midi-status");
    el.textContent = names.length ? `MIDI: ${names.join(", ")}` : "MIDI: nenhum teclado";
    el.classList.toggle("ok", names.length > 0);
  },
}).catch((e) => {
  $("midi-status").textContent = `MIDI indisponível: ${(e as Error).message}`;
});

$("open-browser").addEventListener("click", () => {
  void openBrowser($<HTMLInputElement>("search-input").value.trim());
});
api.onImported((entry) => {
  switchTab("library", false);
  void showLibrary().then(() => void openSong(entry, songList.querySelector("li") ?? document.createElement("li")));
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
