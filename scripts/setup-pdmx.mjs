// One-time setup: downloads PDMX metadata + MIDI files from Zenodo and builds a compact search index.
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const BASE = "https://zenodo.org/records/15571083/files/";
const FILES = ["PDMX.csv", "mid.tar.gz"];
const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "learn-piano", "pdmx");
const progressFile = join(homedir(), ".cache/claude-progress/learn-piano-pdmx.json");
const startedAt = new Date().toISOString();
// Zenodo rejects default Node/curl user agents with 403.
const HEADERS = { "user-agent": "learn-piano-setup/0.1" };
const fileUrl = (name) => `${BASE}${name}?download=1`;

function progress(done, total, status, unit = "MB") {
  mkdirSync(dirname(progressFile), { recursive: true });
  writeFileSync(
    progressFile,
    JSON.stringify({
      name: "learn-piano: PDMX",
      done: Math.round(done),
      total: Math.round(total),
      unit,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      status,
    }),
  );
}

async function download(names) {
  const sizes = await Promise.all(
    names.map(async (n) => Number((await fetch(fileUrl(n), { method: "HEAD", headers: HEADERS })).headers.get("content-length") || 0)),
  );
  const totalMb = sizes.reduce((a, b) => a + b, 0) / 1e6;
  let doneBytes = 0;
  let last = 0;
  for (const [i, name] of names.entries()) {
    const target = join(dataDir, name);
    if (existsSync(target) && (!sizes[i] || statSync(target).size === sizes[i])) {
      doneBytes += sizes[i];
      continue;
    }
    console.log(`Baixando ${name} (${(sizes[i] / 1e6).toFixed(0)} MB)…`);
    const res = await fetch(fileUrl(name), { headers: HEADERS });
    if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        doneBytes += chunk.length;
        if (Date.now() - last > 1000) {
          last = Date.now();
          progress(doneBytes / 1e6, totalMb, `baixando ${name}`);
        }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(target + ".part"));
    rmSync(target, { force: true });
    spawnSync("mv", [target + ".part", target]);
  }
}

// Minimal RFC 4180 parser: quoted fields may contain commas, quotes ("") and newlines.
async function* csvRows(path) {
  let field = "";
  let row = [];
  let quoted = false;
  let pendingQuote = false;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    for (const ch of chunk) {
      if (quoted) {
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          quoted = false;
        } else if (ch === '"') {
          pendingQuote = true;
          continue;
        } else {
          field += ch;
          continue;
        }
      }
      if (ch === '"' && field === "") quoted = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field.replace(/\r$/, ""));
        yield row;
        row = [];
        field = "";
      } else field += ch;
    }
  }
  if (field || row.length) yield [...row, field];
}

async function buildIndex() {
  console.log("Montando índice…");
  const rows = [];
  let header = null;
  let seen = 0;
  for await (const r of csvRows(join(dataDir, "PDMX.csv"))) {
    if (!header) {
      header = Object.fromEntries(r.map((name, i) => [name, i]));
      continue;
    }
    if (++seen % 20000 === 0) progress(seen, 254077, "montando índice", "partituras");
    const get = (k) => {
      const v = r[header[k]];
      return v === undefined || v === "NA" ? "" : v;
    };
    if (get("subset:no_license_conflict") !== "True" || get("subset:all_valid") !== "True" || !get("mid")) continue;
    const programs = get("tracks").split("-").filter(Boolean).map(Number);
    const pianoTracks = programs.filter((p) => p >= 0 && p <= 7).length;
    if (!pianoTracks) continue;
    const title = get("title") || get("song_name");
    const artist = get("artist_name") || get("composer_name");
    rows.push([title, artist, get("mid").replace(/^\.\//, ""), Number(get("n_views")) || 0, pianoTracks === programs.length ? 1 : 0]);
  }
  writeFileSync(join(dataDir, "index.json"), JSON.stringify({ version: 1, rows }));
  console.log(`Índice: ${rows.length} partituras com piano.`);
}

function extract() {
  console.log("Extraindo MIDIs…");
  progress(0, 0, "extraindo mid.tar.gz");
  const res = spawnSync("tar", ["xzf", "mid.tar.gz"], { cwd: dataDir, stdio: "inherit" });
  if (res.status !== 0) throw new Error("tar falhou");
}

try {
  mkdirSync(dataDir, { recursive: true });
  await download(FILES);
  extract();
  await buildIndex();
  rmSync(join(dataDir, "mid.tar.gz"));
  rmSync(join(dataDir, "PDMX.csv"));
  progress(1, 1, "concluído", "etapas");
  console.log(`Pronto: ${dataDir}`);
} catch (e) {
  progress(0, 0, `erro: ${e.message}`);
  console.error(e);
  process.exit(1);
}
