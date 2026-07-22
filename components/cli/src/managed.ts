// Editing user config responsibly (see components/specs/init.html). Text files
// get a sentinel-fenced block replaced in place; JSON files get a keyed merge
// tracked in a sidecar manifest signalbox owns. Every write backs the file up
// first, and reverse() removes only signalbox's own edits. This is the "license"
// the init spec requires before signalbox touches a file it does not own.

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

export const MANAGED_BEGIN = "# >>> signalbox managed >>>";
export const MANAGED_END = "# <<< signalbox managed <<<";
const MANAGED_NOTE =
  "# !! Managed by `signalbox init`. Edit: signalbox init  Remove: signalbox init --reverse !!";

function configDir(): string {
  return join(homedir(), ".config", "signalbox");
}
function backupsDir(): string {
  return join(configDir(), "backups");
}
function manifestPath(): string {
  return join(configDir(), "managed.json");
}

// A filesystem-safe timestamp for backup names: 2026-07-21T08-40-11.
function stamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

// backupFile copies a file into ~/.config/signalbox/backups with a timestamp
// and returns the backup path, or null if there was nothing to back up.
export function backupFile(file: string): string | null {
  if (!existsSync(file)) return null;
  mkdirSync(backupsDir(), { recursive: true });
  const dest = join(backupsDir(), `${basename(file)}.${stamp()}`);
  copyFileSync(file, dest);
  return dest;
}

// The managed region as a regex, matched whole so a re-run replaces it in place
// (the conda/pnpm idiom) rather than appending a second copy.
function managedRegion(): RegExp {
  const b = MANAGED_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const e = MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\n?${b}[\\s\\S]*?${e}\\n?`);
}

export function hasManagedBlock(text: string): boolean {
  return managedRegion().test(text);
}

// The fenced block signalbox owns in a text file.
export function managedBlock(body: string): string {
  return `${MANAGED_BEGIN}\n${MANAGED_NOTE}\n${body.trim()}\n${MANAGED_END}`;
}

// writeManagedBlock inserts or replaces signalbox's fenced block in a text file,
// backing the file up first. Idempotent: re-running with the same body is a
// no-op; a changed body replaces the region in place.
export function writeManagedBlock(
  file: string,
  body: string,
): { changed: boolean; backup: string | null } {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = managedBlock(body);
  let next: string;
  if (hasManagedBlock(existing)) {
    next = existing.replace(managedRegion(), `\n${block}\n`);
  } else {
    next = existing.length && !existing.endsWith("\n") ? `${existing}\n\n${block}\n` : `${existing}${existing.length ? "\n" : ""}${block}\n`;
  }
  if (next === existing) return { changed: false, backup: null };
  const backup = backupFile(file);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, next);
  return { changed: true, backup };
}

// removeManagedBlock strips signalbox's fenced block from a text file (backing
// it up first), leaving everything else untouched.
export function removeManagedBlock(file: string): { changed: boolean; backup: string | null } {
  if (!existsSync(file)) return { changed: false, backup: null };
  const existing = readFileSync(file, "utf8");
  if (!hasManagedBlock(existing)) return { changed: false, backup: null };
  const backup = backupFile(file);
  const next = existing.replace(managedRegion(), "\n").replace(/\n{3,}/g, "\n\n");
  writeFileSync(file, next);
  return { changed: true, backup };
}

// A one-off unified-ish diff for --dry-run: the lines signalbox would add.
export function previewManagedBlock(file: string, body: string): string {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (hasManagedBlock(existing) && existing.includes(body.trim())) return "(no change)";
  const verb = hasManagedBlock(existing) ? "replace signalbox block in" : "add signalbox block to";
  return `${verb} ${file}:\n` + managedBlock(body).split("\n").map((l) => `+ ${l}`).join("\n");
}

// --- JSON hooks (Claude settings.json / Codex hooks.json share this shape) ---

// mergeHookCommand adds a `{ type:"command", command }` entry to each named
// event in a `{ hooks: { <Event>: [{ hooks: [...] }] } }` file, alongside any
// existing entries. Idempotent (skips events that already call the command).
// Returns the events changed and the parsed before/after for a dry-run diff.
export function mergeHookCommand(
  file: string,
  events: string[],
  command: string,
): { changed: string[]; write: () => { backup: string | null } } {
  const doc: any = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const hooks = (doc.hooks ??= {});
  const changed: string[] = [];
  for (const ev of events) {
    const groups = (hooks[ev] ??= []);
    if (!Array.isArray(groups)) continue;
    const present = groups.some((g: any) =>
      (g?.hooks ?? []).some((h: any) => typeof h?.command === "string" && h.command.includes(command)),
    );
    if (present) continue;
    groups.push({ matcher: "*", hooks: [{ type: "command", command }] });
    changed.push(ev);
  }
  return {
    changed,
    write: () => {
      const backup = backupFile(file);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
      return { backup };
    },
  };
}

// removeHookCommand strips every hook whose command mentions the given command
// from a hooks-shaped JSON file, and drops events left empty.
export function removeHookCommand(
  file: string,
  command: string,
): { changed: boolean; backup: string | null } {
  if (!existsSync(file)) return { changed: false, backup: null };
  const doc: any = JSON.parse(readFileSync(file, "utf8"));
  const hooks = doc?.hooks;
  if (!hooks) return { changed: false, backup: null };
  let changed = false;
  for (const ev of Object.keys(hooks)) {
    const groups = hooks[ev];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g: any) => ({ ...g, hooks: (g?.hooks ?? []).filter((h: any) => !(typeof h?.command === "string" && h.command.includes(command))) }))
      .filter((g: any) => (g.hooks ?? []).length > 0);
    if (kept.length !== groups.length) {
      changed = true;
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
  }
  if (!changed) return { changed: false, backup: null };
  const backup = backupFile(file);
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return { changed: true, backup };
}

// Cursor's hooks.json is flatter than Claude's/Codex's: the command sits
// directly in the event array, `{ version, hooks: { <event>: [{ command }] } }`.
export function mergeCursorHooks(
  file: string, events: string[], command: string,
): { changed: string[]; write: () => { backup: string | null } } {
  const doc: any = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, hooks: {} };
  doc.version ??= 1;
  const hooks = (doc.hooks ??= {});
  const changed: string[] = [];
  for (const ev of events) {
    const arr = (hooks[ev] ??= []);
    if (!Array.isArray(arr)) continue;
    if (arr.some((h: any) => typeof h?.command === "string" && h.command.includes(command))) continue;
    arr.push({ command });
    changed.push(ev);
  }
  return {
    changed,
    write: () => {
      const backup = backupFile(file);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
      return { backup };
    },
  };
}

export function removeCursorHooks(file: string, command: string): { changed: boolean; backup: string | null } {
  if (!existsSync(file)) return { changed: false, backup: null };
  const doc: any = JSON.parse(readFileSync(file, "utf8"));
  const hooks = doc?.hooks;
  if (!hooks) return { changed: false, backup: null };
  let changed = false;
  for (const ev of Object.keys(hooks)) {
    const arr = hooks[ev];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((h: any) => !(typeof h?.command === "string" && h.command.includes(command)));
    if (kept.length !== arr.length) {
      changed = true;
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
  }
  if (!changed) return { changed: false, backup: null };
  const backup = backupFile(file);
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return { changed: true, backup };
}

// detectExternalOwner returns the name of another tool that manages a config
// file, so init can fall back to print rather than risk that tool's state.
// Codex's hooks.json is "owned" by whatever wrote the per-hook trusted_hash
// entries in ~/.codex/config.toml (koi, in the common case).
export function detectCodexHooksOwner(configTomlPath: string): string | null {
  if (!existsSync(configTomlPath)) return null;
  const toml = readFileSync(configTomlPath, "utf8");
  if (/#\s*koi-managed/i.test(toml)) return "koi";
  if (/\[hooks\.state\./.test(toml) && /trusted_hash/.test(toml)) return "another tool";
  return null;
}

// --- Manifest: the sidecar that makes JSON edits idempotent and removable ---

export interface ManagedEntry {
  file: string;
  kind: "text" | "json";
  command?: string; // for json hooks: the command signalbox owns
  managedEvents?: string[];
  backup: string | null;
  externalOwner?: string | null;
}

export function readManifest(): ManagedEntry[] {
  const p = manifestPath();
  if (!existsSync(p)) return [];
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function recordManaged(entry: ManagedEntry): void {
  mkdirSync(configDir(), { recursive: true });
  const entries = readManifest().filter((e) => e.file !== entry.file);
  entries.push(entry);
  writeFileSync(manifestPath(), JSON.stringify(entries, null, 2) + "\n");
}

export function forgetManaged(file: string): void {
  const entries = readManifest().filter((e) => e.file !== file);
  writeFileSync(manifestPath(), JSON.stringify(entries, null, 2) + "\n");
}
