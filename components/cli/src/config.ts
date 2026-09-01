// Shared user settings for behaviour toggles (specs/settings.html). One flat
// JSON file so the CLI hooks and the macOS app's Settings window can read
// and write the same choices. Missing file or key = the default; a broken
// file must never break the hook path.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { lanIPv4 } from "./pair";
import { isLoopbackAddress } from "./hub";

// Persistent hub network config, the file-backed equivalent of the --bind flag
// and SIGNALBOX_TOKEN env. Lets `signalbox hub` (and the app-spawned hub, which
// passes no --bind) start reachable by other devices, with a token, at zero
// flags. bind is always a literal address the hub binds verbatim - "127.0.0.1"
// (this machine only), "0.0.0.0" (every interface), or an explicit IP. Friendly
// words like "any" are normalized to a literal on input, never stored. token is
// the bearer secret.
export interface HubSettings {
  bind: string;
  token: string;
  // When set, `signalbox hub` runs as a FORWARDER against this URL instead of
  // owning state. This is how the app-spawned hub, which passes only --port,
  // becomes a forwarder with no flags. Empty means own the state locally.
  upstream: string;
  // How many exchanges the reducer keeps per session. Increasing the limit uses
  // more memory. The reducer rebuilds the ring from existing events without a
  // migration.
  historyLimit: number;
  // The emitter's cap on a reply, in characters. Prompts keep the fixed cap.
  replyCap: number;
}

export interface Settings {
  // Claude Code `/clear` fires SessionEnd(reason "clear"). true (default):
  // the session ends and leaves the board. false: it maps to done - the old
  // exchange stays visible until hidden, removed, or expired.
  claudeClearEnds: boolean;
  // Claude Code `/rename` sets a custom session title. true (default): that
  // title becomes the board's session name. false: ignore it and fall back to
  // the cwd folder name. The user's own jumplist rename always wins regardless.
  claudeRenameTitle: boolean;
  // The Codex pair of the two toggles above. Rename: Codex `/rename` writes the
  // thread name to ~/.codex/session_index.jsonl, adopted as the board name when
  // true (default). Clear: guards a SessionEnd with reason "clear" the same way
  // as Claude's - inert if Codex never sends that reason.
  codexClearEnds: boolean;
  codexRenameTitle: boolean;
  /** Gates local transcript indexing because complete session content is more sensitive than board events. */
  searchEnabled: boolean;
  hub: HubSettings;
}

// Only the hub section is writable through saveSettings; the app owns the
// toggles above and writes them itself.
export interface SettingsPatch {
  hub?: Partial<HubSettings>;
}

const defaults: Settings = {
  claudeClearEnds: true,
  claudeRenameTitle: true,
  codexClearEnds: true,
  codexRenameTitle: true,
  searchEnabled: false,
  hub: {
    bind: "127.0.0.1",
    token: "",
    upstream: "",
    historyLimit: 1000,
    replyCap: 10240,
  },
};

// Resolution order mirrors kubectl/gh style: explicit file (--config sets
// SIGNALBOX_CONFIG) > XDG base dir > ~/.config. SIGNALBOX_CONFIG names the
// settings FILE, not a directory, so a test or a second profile can point at
// any path without touching HOME.
export function settingsPath(): string {
  const file = process.env.SIGNALBOX_CONFIG;
  if (file) return file;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "signalbox", "settings.json");
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max
    ? n
    : fallback;
}

export function loadSettings(): Settings {
  let fromFile: Partial<Settings> = {};
  try {
    fromFile = JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    // missing or malformed → defaults
  }
  // hub is nested, so a shallow spread would drop the defaults when the file
  // sets only part of it - merge it explicitly.
  const s: Settings = {
    ...defaults,
    ...fromFile,
    hub: { ...defaults.hub, ...(fromFile.hub ?? {}) },
  };
  // Invalid hand-edited values fall back to defaults so hooks can continue.
  s.hub.historyLimit = clampInt(fromFile.hub?.historyLimit, 1, 100000, defaults.hub.historyLimit);
  s.hub.replyCap = clampInt(fromFile.hub?.replyCap, 1, 1000000, defaults.hub.replyCap);
  // Env override for scripting/testing, and for hosts without the file.
  const env = process.env.SIGNALBOX_CLEAR_ENDS;
  if (env === "0" || env === "false") s.claudeClearEnds = false;
  if (env === "1" || env === "true") s.claudeClearEnds = true;
  const rename = process.env.SIGNALBOX_CLAUDE_RENAME;
  if (rename === "0" || rename === "false") s.claudeRenameTitle = false;
  if (rename === "1" || rename === "true") s.claudeRenameTitle = true;
  const codexClear = process.env.SIGNALBOX_CODEX_CLEAR_ENDS;
  if (codexClear === "0" || codexClear === "false") s.codexClearEnds = false;
  if (codexClear === "1" || codexClear === "true") s.codexClearEnds = true;
  const codexRename = process.env.SIGNALBOX_CODEX_RENAME;
  if (codexRename === "0" || codexRename === "false") s.codexRenameTitle = false;
  if (codexRename === "1" || codexRename === "true") s.codexRenameTitle = true;
  const search = process.env.SIGNALBOX_SEARCH;
  if (search === "0" || search === "false") s.searchEnabled = false;
  if (search === "1" || search === "true") s.searchEnabled = true;
  return s;
}

// saveSettings deep-merges patch into the hub section of the on-disk file and
// writes it back pretty-printed, creating ~/.config/signalbox/ if missing. It
// is the first and only writer of settings.json from the CLI, so it is careful:
// top-level keys the app owns pass through untouched, and the write goes to a
// temp file that is renamed into place, so a crash mid-write can never leave a
// truncated file that would break the hook path.
export function saveSettings(patch: SettingsPatch): void {
  const path = settingsPath();
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Missing or malformed: start from empty so the first write (no file yet)
    // still succeeds. An unparseable file is already broken, not data to keep.
  }
  const merged: Record<string, unknown> = { ...current };
  if (patch.hub) {
    const existing =
      current.hub && typeof current.hub === "object" ? (current.hub as Record<string, unknown>) : {};
    merged.hub = { ...existing, ...patch.hub };
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.settings.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  renameSync(tmp, path);
}

// normalizeBindInput turns whatever a user (or the --bind flag / SIGNALBOX_BIND)
// supplies into the literal address the hub binds verbatim, or an error string
// when the input is unusable. "bind" means bind: the value we store and pass to
// the socket is always a concrete address, never a mode word, so what you set is
// exactly what gets bound. The friendly words are pure input sugar:
//   loopback / local  -> 127.0.0.1  (this machine only)
//   any / all         -> 0.0.0.0    (every interface, so other devices connect)
// An explicit IPv4/IPv6 literal passes straight through. "lan" is refused on
// purpose: people read it as "my LAN IP", but a wildcard bind also answers VPN
// and tunnel interfaces, so the word hides who can actually reach the board -
// steer them to the honest choice ("any", or a specific IP) instead.
export function normalizeBindInput(input: string): { value?: string; error?: string } {
  const raw = input.trim();
  const key = raw.toLowerCase();
  if (key === "loopback" || key === "local") return { value: "127.0.0.1" };
  if (key === "any" || key === "all" || key === "0.0.0.0") return { value: "0.0.0.0" };
  if (key === "lan") {
    return { error: `"lan" is ambiguous: use "any" (all interfaces, incl. VPN) or a specific IP` };
  }
  if (raw === "::") return { value: "::" };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return { value: raw };
  // An IPv6 literal; a bare colon is enough to tell it apart from a typo.
  if (raw.includes(":")) return { value: raw };
  return { error: `invalid hub.bind ${JSON.stringify(input)} (expected an IP, "loopback"/"local", or "any"/"all")` };
}

export function normalizeIntInput(
  input: string,
  min: number,
  max: number
): { value?: number; error?: string } {
  const value = Number(input);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { error: `expected a whole number between ${min} and ${max}` };
  }
  return { value };
}

const upstreamInputError =
  "hub.upstream needs an https hub origin, e.g. https://my-hub.fly.dev (plain http is allowed only for a loopback upstream)";

export function normalizeUpstreamInput(input: string): { value?: string; error?: string } {
  const raw = input.trim();
  if (!raw) return { value: "" };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: upstreamInputError };
  }

  const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  const loopbackHostname = isLoopbackAddress(hostname) && (
    hostname === "localhost"
    || hostname === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
  // The upstream credential and every prompt cross this link, so plaintext is
  // acceptable only when the link cannot leave the machine. This exception
  // keeps a local upstream usable for development and tests.
  const protocolAllowed = parsed.protocol === "https:"
    || (parsed.protocol === "http:" && loopbackHostname);
  if (
    !protocolAllowed
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    return { error: upstreamInputError };
  }

  // Raw input can retain control characters stripped during parsing and
  // empty-but-present query, fragment, or userinfo markers missed above.
  // The parser's canonical origin is therefore the only safe value to persist.
  return { value: parsed.origin };
}

// lanHint returns the LAN IPv4 a device would dial to reach a wildcard-bound
// hub, or null when no network interface exists yet. For display only - the bind
// is the wildcard; this is just the number a human cares about.
export function lanHint(): string | null {
  return lanIPv4();
}

// shouldGenerateToken decides whether runHub must mint and persist a token: a
// non-loopback bind with no token would be refused by validateBindConfig, so
// rather than fail we auto-generate one. Pure so the decision is unit-testable
// without booting a hub. bind must already be resolved to a concrete address.
export function shouldGenerateToken(resolvedBind: string, token: string): boolean {
  return !isLoopbackAddress(resolvedBind) && !token;
}

// generateToken mints a hub bearer token: 24 random bytes as base64url (~32
// chars). The entropy is high enough that no attempt-limiting is needed, and
// url-safe so it drops into headers and env without escaping.
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
