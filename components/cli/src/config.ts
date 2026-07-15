// Shared user settings for behaviour toggles (specs/settings.html). One flat
// JSON file so the CLI hooks and the macOS app's Settings window can read
// and write the same choices. Missing file or key = the default; a broken
// file must never break the hook path.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Settings {
  // Claude Code `/clear` fires SessionEnd(reason "clear"). true (default):
  // the session ends and leaves the board. false: it maps to done - the old
  // exchange stays visible until hidden, removed, or expired.
  claudeClearEnds: boolean;
  // Claude Code `/rename` sets a custom session title. true (default): that
  // title becomes the board's session name. false: ignore it and fall back to
  // the cwd folder name. The user's own jumplist rename always wins regardless.
  claudeRenameTitle: boolean;
}

const defaults: Settings = {
  claudeClearEnds: true,
  claudeRenameTitle: true,
};

export function settingsPath(): string {
  return join(homedir(), ".config", "signalbox", "settings.json");
}

export function loadSettings(): Settings {
  let fromFile: Partial<Settings> = {};
  try {
    fromFile = JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    // missing or malformed → defaults
  }
  const s: Settings = { ...defaults, ...fromFile };
  // Env override for scripting/testing, and for hosts without the file.
  const env = process.env.SIGNALBOX_CLEAR_ENDS;
  if (env === "0" || env === "false") s.claudeClearEnds = false;
  if (env === "1" || env === "true") s.claudeClearEnds = true;
  const rename = process.env.SIGNALBOX_CLAUDE_RENAME;
  if (rename === "0" || rename === "false") s.claudeRenameTitle = false;
  if (rename === "1" || rename === "true") s.claudeRenameTitle = true;
  return s;
}
