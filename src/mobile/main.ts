import { KeepAwake } from "@capacitor-community/keep-awake";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Clipboard } from "@capacitor/clipboard";
import { ScreenOrientation } from "@capacitor/screen-orientation";
import { StatusBar } from "@capacitor/status-bar";
import type { Midi } from "@tonejs/midi";
import { bitmidiSource } from "../shared/bitmidi";
import { Library } from "../shared/library";
import { parseSequenceId } from "../shared/onlinesequencer";
import { DEFAULT_ALIASES, Search } from "../shared/search";
import type { LibraryEntry, SongRef } from "../shared/types";
import type { HandMode, PracticeStats } from "../renderer/src/practice";
import { defaultTrackSelection, describeTracks, type ConvertedScore, type SplitMode } from "../renderer/src/score/convert";
import { chordName } from "../renderer/src/score/harmony";
import { noteLabel, Session, type InputMode, type TrackChoice } from "../renderer/src/session";
import { renderTheory } from "../renderer/src/theory";
import { startAndroidMidi } from "./android-midi";
import { capHttp, capStore, isNative } from "./platform";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const library = new Library(capStore, capHttp);
const search = new Search([bitmidiSource(capHttp)], () => DEFAULT_ALIASES);

type Screen = "library" | "add" | "tracks" | "practice" | "theory";
const stack: Screen[] = ["library"];
let current: { bytes: Uint8Array; title: string } | null = null;
let score: ConvertedScore | null = null;
let view: "score" | "keys" = "score";
let chooseResolve: ((c: TrackChoice | null) => void) | null = null;
let modalResolve: ((v: string | null) => void) | null = null;

const remembered = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
};

const session = new Session(
  $("sheet"),
  $("keyboard"),
  {
    stats: renderStats,
    playState: (playing) => {
      const b = $("play");
      b.textContent = playing ? "■ Parar" : "▶ Tocar";
      b.classList.toggle("stop", playing);
    },
    inputStatus: (mode, ok, text) => {
      document.querySelectorAll<HTMLButtonElement>("#input-mode button").forEach((b) => {
        b.classList.toggle("active", b.dataset.input === mode);
      });
      document.body.classList.toggle("midi-mode", mode === "midi");
      $("input-status").textContent = text;
      $("meter").classList.toggle("usb", mode === "midi");
      $("meter").classList.toggle("ok", ok);
      if (mode === "midi" && !ok) showBanner(text.replace(/^MIDI: /, "Teclado MIDI: "));
      else hideBanner();
    },
    level: (v) => {
      const bars = $("meter").querySelectorAll("i");
      bars.forEach((bar, i) => bar.classList.toggle("on", v > [0.02, 0.08, 0.2, 0.4][i]));
    },
    octave: (o) => ($("octave-label").textContent = `${o > 0 ? "+" : ""}${o}`),
  },
  "mic",
);
const { practice } = session;

// ---------- navigation ----------

function show(screen: Screen): void {
  document.querySelectorAll<HTMLElement>(".screen").forEach((s) => (s.hidden = s.id !== `screen-${screen}`));
  document.body.dataset.screen = screen;
  const practicing = screen === "practice";
  if (isNative) {
    void (practicing ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(() => undefined);
    void (practicing ? ScreenOrientation.lock({ orientation: "landscape" }) : ScreenOrientation.unlock()).catch(
      () => undefined,
    );
  }
}

function go(screen: Screen): void {
  if (stack[stack.length - 1] !== screen) stack.push(screen);
  show(screen);
}

function back(): void {
  if (!$("modal").hidden) return closeModal(null);
  if (!$("panel").hidden) return togglePanel(false);
  if (!$("finish").hidden) return void ($("finish").hidden = true);
  if (practice.isPlaying) return practice.togglePlay();
  const leaving = stack.pop();
  if (leaving === "tracks" && chooseResolve) {
    chooseResolve(null);
    chooseResolve = null;
  }
  if (!stack.length) {
    stack.push("library");
    if (isNative) void App.exitApp();
    return;
  }
  const target = stack[stack.length - 1];
  if (target === "library") void refreshLibrary();
  show(target);
}

document.querySelectorAll<HTMLButtonElement>(".back").forEach((b) => b.addEventListener("click", back));
if (isNative) void App.addListener("backButton", back);

// ---------- messages ----------

let snackTimer: ReturnType<typeof setTimeout> | undefined;
function snack(text: string): void {
  const el = $("snackbar");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => (el.hidden = true), 2500);
}

function showBanner(text: string, action?: { label: string; run: () => void }): void {
  const el = $("banner");
  el.querySelector("span")!.textContent = text;
  const button = el.querySelector("button")!;
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = action.run;
  }
  el.hidden = false;
}

function hideBanner(): void {
  $("banner").hidden = true;
}

function modal(title: string, text: string, opts: { ok: string; danger?: boolean; input?: string }): Promise<string | null> {
  $("m-title").textContent = title;
  $("m-text").textContent = text;
  const input = $<HTMLInputElement>("m-input");
  input.hidden = opts.input === undefined;
  input.value = opts.input ?? "";
  const ok = $("m-ok");
  ok.textContent = opts.ok;
  ok.classList.toggle("danger", !!opts.danger);
  $("modal").hidden = false;
  if (opts.input !== undefined) setTimeout(() => input.select(), 50);
  return new Promise((resolve) => (modalResolve = resolve));
}

function closeModal(value: string | null): void {
  $("modal").hidden = true;
  modalResolve?.(value);
  modalResolve = null;
}

$("m-cancel").addEventListener("click", () => closeModal(null));
$("m-ok").addEventListener("click", () => {
  const input = $<HTMLInputElement>("m-input");
  if (!input.hidden && !input.value.trim()) return input.focus();
  closeModal(input.hidden ? "ok" : input.value.trim());
});

const errorText = (e: unknown) => (e as Error).message ?? String(e);

// ---------- library ----------

function row(item: SongRef | LibraryEntry, onOpen: () => void, onRemove?: () => void): HTMLLIElement {
  const li = document.createElement("li");
  const text = document.createElement("div");
  text.className = "text";
  const title = document.createElement("strong");
  title.textContent = item.title;
  const detail = document.createElement("small");
  detail.textContent = item.detail ?? item.source;
  text.append(title, detail);
  li.append(text);
  li.addEventListener("click", onOpen);
  if (onRemove) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "icon";
    more.setAttribute("aria-label", "Remover");
    more.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      onRemove();
    });
    li.append(more);
  }
  return li;
}

async function refreshLibrary(): Promise<void> {
  const entries = await library.list();
  $("library-list").replaceChildren(
    ...entries.map((entry) =>
      row(
        entry,
        () => void openEntry(entry),
        () => void removeEntry(entry),
      ),
    ),
  );
  $("library-empty").hidden = entries.length > 0;
  $("fab-add").hidden = entries.length === 0;
}

async function removeEntry(entry: LibraryEntry): Promise<void> {
  const ok = await modal("Remover música", `Remover “${entry.title}” da biblioteca?`, { ok: "Remover", danger: true });
  if (!ok) return;
  await library.remove(entry.fileName);
  await refreshLibrary();
}

async function openEntry(entry: LibraryEntry): Promise<void> {
  try {
    await openSong(await library.read(entry.fileName), entry.title);
  } catch (e) {
    void modal("Não foi possível abrir", errorText(e), { ok: "OK" });
  }
}

// ---------- add: search, Online Sequencer, file ----------

function openAdd(tab: "search" | "os" | "file"): void {
  selectTab(tab);
  go("add");
  if (tab === "file") $<HTMLInputElement>("file-input").click();
}

function selectTab(tab: string): void {
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>(".tab-body").forEach((b) => (b.hidden = b.dataset.body !== tab));
}

document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
  b.addEventListener("click", () => selectTab(b.dataset.tab!));
});
$("fab-add").addEventListener("click", () => openAdd("search"));
document.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((b) => {
  b.addEventListener("click", () => openAdd(b.dataset.add as "search" | "file"));
});

function searchState(text: string, retry = false): void {
  const el = $("search-state");
  el.hidden = !text;
  el.textContent = text;
  if (retry) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Tentar de novo";
    b.addEventListener("click", () => $<HTMLFormElement>("search-form").requestSubmit());
    el.append(" ", b);
  }
}

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("search-input");
  const query = input.value.trim();
  input.blur();
  if (!query) return;
  if (parseSequenceId(query)) {
    $<HTMLInputElement>("os-link").value = query;
    selectTab("os");
    return void importSequence();
  }
  if (!navigator.onLine) return searchState("Sem conexão. Importe um arquivo .mid pela aba Arquivo.");
  searchState("Buscando…");
  $("search-results").replaceChildren();
  try {
    const res = await search.page(query, 0);
    searchState(res.total ? "" : `Nada encontrado para “${query}”. Tente a aba Online Sequencer.`);
    $("search-results").replaceChildren(...res.items.map((ref) => row(ref, () => void openRef(ref))));
  } catch {
    searchState("A busca falhou.", true);
  }
});

async function openRef(ref: SongRef): Promise<void> {
  searchState(`Baixando “${ref.title}”…`);
  try {
    const { bytes } = await library.download(ref);
    searchState("");
    await openSong(bytes, ref.title);
  } catch (e) {
    searchState(`Não foi possível baixar: ${errorText(e)}`, true);
  }
}

$("os-open").addEventListener("click", () => {
  const query = $<HTMLInputElement>("search-input").value.trim();
  const url = query
    ? `https://onlinesequencer.net/sequences?search=${encodeURIComponent(query)}`
    : "https://onlinesequencer.net/sequences";
  if (isNative) void Browser.open({ url });
  else window.open(url, "_blank");
});

$("os-paste").addEventListener("click", async () => {
  try {
    const { value } = isNative ? await Clipboard.read() : { value: await navigator.clipboard.readText() };
    $<HTMLInputElement>("os-link").value = value.trim();
    $("os-error").hidden = true;
  } catch {
    osError("Não foi possível ler a área de transferência. Cole manualmente no campo.");
  }
});

function osError(text: string): void {
  $("os-error").textContent = text;
  $("os-error").hidden = false;
}

async function importSequence(): Promise<void> {
  const link = $<HTMLInputElement>("os-link").value.trim();
  const id = parseSequenceId(link);
  if (!id) return osError("Link inválido. Ele deve ser como onlinesequencer.net/1234567.");
  $("os-error").hidden = true;
  const suggestion = $<HTMLInputElement>("search-input").value.trim() || `Online Sequencer #${id}`;
  const title = await modal("Nome da música", "A Online Sequencer não informa o nome. Como ela deve aparecer na biblioteca?", {
    ok: "Salvar",
    input: suggestion,
  });
  if (!title) return;
  try {
    const entry = await library.importOnlineSequence(id, title);
    $<HTMLInputElement>("os-link").value = "";
    await openSong(await library.read(entry.fileName), entry.title);
  } catch (e) {
    osError(`Não foi possível importar: ${errorText(e)}`);
  }
}
$("os-import").addEventListener("click", () => void importSequence());

$("file-pick").addEventListener("click", () => $<HTMLInputElement>("file-input").click());
$("file-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const state = $("file-state");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entry = await library.importLocal(file.name, `file:${file.name}`, bytes);
    state.hidden = true;
    await openSong(bytes, entry.title);
  } catch (err) {
    state.textContent = `Não foi possível ler este MIDI: ${errorText(err)}`;
    state.hidden = false;
  }
});

// ---------- tracks ----------

function chooseTracks(midi: Midi): Promise<TrackChoice | null> {
  const tracks = describeTracks(midi).filter((t) => t.noteCount > 0);
  const selected = new Set(defaultTrackSelection(tracks));
  $("track-list").replaceChildren(
    ...tracks.map((t) => {
      const li = document.createElement("li");
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = String(t.index);
      box.checked = selected.has(t.index);
      const text = document.createElement("span");
      text.className = "text";
      const name = document.createElement("strong");
      name.textContent = t.name;
      const detail = document.createElement("small");
      detail.textContent = `${t.isPercussion ? "bateria" : t.instrument} · ${t.noteCount} notas`;
      text.append(name, detail);
      label.append(box, text);
      li.append(label);
      return li;
    }),
  );
  updateStart();
  go("tracks");
  return new Promise((resolve) => (chooseResolve = resolve));
}

function checkedTracks(): number[] {
  return [...document.querySelectorAll<HTMLInputElement>("#track-list input:checked")].map((b) => Number(b.value));
}

function updateStart(): void {
  ($("tracks-start") as HTMLButtonElement).disabled = checkedTracks().length === 0;
}
$("track-list").addEventListener("change", updateStart);

$("tracks-start").addEventListener("click", () => {
  const tracks = checkedTracks();
  if (!tracks.length || !chooseResolve) return;
  const split = document.querySelector<HTMLInputElement>("input[name=split]:checked")!.value as SplitMode;
  stack.pop();
  enterPractice(true);
  chooseResolve({ tracks, split });
  chooseResolve = null;
});

// ---------- practice ----------

async function openSong(bytes: Uint8Array, title: string): Promise<void> {
  current = { bytes, title };
  $("p-title").textContent = title;
  const opened = await session.openSong(bytes, title, $<HTMLSelectElement>("hand-mode").value as HandMode, chooseTracks);
  $("loading").hidden = true;
  if (!opened) return;
  score = opened;
  renderTheory($("theory"), score);
  buildTheoryRail();
  updateKeysView();
  if (session.outOfReach(score)) {
    showBanner(`A música vai de ${noteLabel(score.minPitch)} a ${noteLabel(score.maxPitch)}: use Oitava − / + nas opções.`);
  }
}

// Back from practice always returns to the library, however the song was found.
function enterPractice(loading: boolean): void {
  stack.length = 1;
  $("loading").hidden = !loading;
  $("finish").hidden = true;
  togglePanel(false);
  go("practice");
  setView(view);
}

function renderStats(s: PracticeStats): void {
  const pct = s.done ? Math.round((s.clean / s.done) * 100) : 100;
  $("p-stats").textContent = `${s.done}/${s.total} · ${pct}% · ${s.errors} ${s.errors === 1 ? "erro" : "erros"}`;
  if (s.finished && s.total > 0) {
    $("f-pct").textContent = `${Math.round((s.clean / s.total) * 100)}%`;
    $("f-detail").textContent = `${s.clean} de ${s.total} passos de primeira · ${s.errors} ${s.errors === 1 ? "erro" : "erros"}`;
    $("finish").hidden = false;
  }
  updateKeysView();
}

function setView(next: "score" | "keys"): void {
  view = next;
  remember("practiceView", next);
  document.querySelectorAll<HTMLButtonElement>(".pbar .segmented button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === next);
  });
  $("view-score").hidden = next !== "score";
  $("view-keys").hidden = next !== "keys";
  updateKeysView();
}

document.querySelectorAll<HTMLButtonElement>(".pbar .segmented button").forEach((b) => {
  b.addEventListener("click", () => setView(b.dataset.view as "score" | "keys"));
});

const SOLFEGE = ["Dó", "Dó♯", "Ré", "Ré♯", "Mi", "Fá", "Fá♯", "Sol", "Sol♯", "Lá", "Lá♯", "Si"];
const VISIBLE_WHITE_KEYS = 22;

// The keyboard view shows about three octaves, centred on the notes the score asks for next.
function updateKeysView(): void {
  if (view !== "keys" || !score) return;
  const notes = practice.expectedNotes();
  const unit = practice.currentUnit();
  const chord = unit === null ? undefined : score.harmony.chords.filter((c) => c.unit <= unit && c.end > unit).pop();
  $("k-chord").textContent = chord ? chordName(chord, score.harmony.fifths) : "";
  const next = $("k-next");
  next.replaceChildren(
    ...[...notes]
      .sort((a, b) => a.pitch - b.pitch)
      .map((n) => {
        const span = document.createElement("span");
        span.className = n.hand;
        span.textContent = `${SOLFEGE[n.pitch % 12]}${Math.floor(n.pitch / 12) - 1}`;
        return span;
      }),
  );
  const win = $("keys-window");
  const kb = $("keyboard");
  const whites = session.keyboard.whiteKeys || 1;
  const width = Math.max(win.clientWidth, (win.clientWidth * whites) / VISIBLE_WHITE_KEYS);
  kb.style.width = `${width}px`;
  const centers = notes.map((n) => session.keyboard.centerOf(n.pitch)).filter((c): c is number => c !== null);
  if (!centers.length) return;
  const mid = ((Math.min(...centers) + Math.max(...centers)) / 2) * width;
  const offset = Math.max(0, Math.min(width - win.clientWidth, mid - win.clientWidth / 2));
  kb.style.transform = `translateX(${-offset}px)`;
}
new ResizeObserver(() => updateKeysView()).observe($("keys-window"));

$("play").addEventListener("click", () => practice.togglePlay());
$("prev").addEventListener("click", () => practice.skip(-1));
$("next").addEventListener("click", () => practice.skip(1));
$("hand-mode").addEventListener("change", (e) => practice.setMode((e.target as HTMLSelectElement).value as HandMode));
$("view-score").addEventListener("click", () => practice.isPlaying && practice.togglePlay());

function togglePanel(open: boolean): void {
  $("panel").hidden = !open;
  $("panel-scrim").hidden = !open;
}
$("p-menu").addEventListener("click", () => togglePanel($("panel").hidden === true));
$("panel-scrim").addEventListener("click", () => togglePanel(false));

document.querySelectorAll<HTMLButtonElement>("#input-mode button").forEach((b) => {
  b.addEventListener("click", () => void chooseInput(b.dataset.input as InputMode));
});

async function chooseInput(mode: InputMode): Promise<void> {
  if (mode === "mic" && remembered("micIntro") !== "1") {
    const ok = await modal(
      "Usar o microfone",
      "O app ouve o seu piano para saber se você acertou a nota. Nada é gravado nem enviado.",
      { ok: "Permitir microfone" },
    );
    if (!ok) return;
    remember("micIntro", "1");
  }
  const error = await session.setInputMode(mode);
  if (error) {
    showBanner(error, { label: "Tentar de novo", run: () => void chooseInput("mic") });
    return;
  }
  snack(mode === "mic" ? "Microfone conectado" : "Entrada MIDI ativa");
}

$("octave-down").addEventListener("click", () => session.setOctave(session.octave - 1));
$("octave-up").addEventListener("click", () => session.setOctave(session.octave + 1));
$<HTMLInputElement>("sound-toggle").addEventListener("change", (e) => {
  session.sound.enabled = (e.target as HTMLInputElement).checked;
});

$("restart").addEventListener("click", async () => {
  togglePanel(false);
  const done = Number($("p-stats").textContent?.split("/")[0] ?? 0);
  if (done > 0 && !(await modal("Reiniciar", "Recomeçar a música do início? O placar atual será perdido.", { ok: "Reiniciar", danger: true }))) {
    return;
  }
  practice.restart();
});

$("change-tracks").addEventListener("click", () => {
  togglePanel(false);
  if (!current) return;
  stack.pop();
  void openSong(current.bytes, current.title);
});

$("open-theory").addEventListener("click", () => {
  togglePanel(false);
  go("theory");
});

$("f-again").addEventListener("click", () => {
  $("finish").hidden = true;
  practice.restart();
});
$("f-library").addEventListener("click", () => {
  $("finish").hidden = true;
  stack.length = 1;
  void refreshLibrary();
  show("library");
});

function buildTheoryRail(): void {
  const sections = [...$("theory").querySelectorAll("section")];
  $("theory-rail").replaceChildren(
    ...sections.map((section, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = section.querySelector("h3")?.textContent?.replace(/ de .*/, "") ?? `Seção ${i + 1}`;
      b.addEventListener("click", () => {
        $("theory-rail").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        section.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return b;
    }),
  );
  $("theory-rail").querySelector("button")?.classList.add("active");
}

// ---------- lifecycle ----------

// Stop listening while the app is in the background; resume the chosen input when it returns.
if (isNative) {
  void App.addListener("pause", () => {
    if (practice.isPlaying) practice.togglePlay();
    session.pauseInput();
  });
  void App.addListener("resume", () => void session.resumeInput());
  void StatusBar.hide().catch(() => undefined);
}

async function boot(): Promise<void> {
  const saved = remembered("practiceView");
  if (saved === "keys" || saved === "score") view = saved;
  setView(view);
  show("library");
  await refreshLibrary();
  if (session.inputMode === "mic" && remembered("micIntro") !== "1") {
    const ok = await modal(
      "Usar o microfone",
      "O app ouve o seu piano para saber se você acertou a nota. Nada é gravado nem enviado.",
      { ok: "Permitir microfone" },
    );
    if (ok) remember("micIntro", "1");
    else await session.setInputMode("midi");
  }
  const error = await session.start(startAndroidMidi);
  if (error) showBanner(error, { label: "Tentar de novo", run: () => void chooseInput("mic") });
  session.sound.ready.catch(() => snack("O som de piano não carregou (sem internet?)."));
}

void boot();
