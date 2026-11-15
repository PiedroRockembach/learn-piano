import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_ALIASES } from "../shared/search";
import { aliasesFile } from "./paths";

// Users edit this file directly to add alternative titles.
export function loadAliases(): Record<string, string[]> {
  if (!existsSync(aliasesFile)) {
    mkdirSync(dirname(aliasesFile), { recursive: true });
    writeFileSync(aliasesFile, JSON.stringify(DEFAULT_ALIASES, null, 2) + "\n");
    return DEFAULT_ALIASES;
  }
  try {
    return JSON.parse(readFileSync(aliasesFile, "utf8"));
  } catch {
    return DEFAULT_ALIASES;
  }
}
