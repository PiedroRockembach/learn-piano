import { join } from "node:path";
import { homedir } from "node:os";

export const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "learn-piano");
export const libraryDir = join(dataDir, "library");
export const libraryIndexFile = join(dataDir, "library.json");
export const pdmxDir = join(dataDir, "pdmx");
export const aliasesFile = join(dataDir, "aliases.json");
