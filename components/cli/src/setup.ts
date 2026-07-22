// `signalbox install` - the README's front door: an idempotent guided
// install. Every step detects current state before acting and reports one of
// three statuses, so re-running is a status checklist, never a re-install.
//
// User config policy: JSON agent configs (Claude settings.json, Cursor
// hooks.json) are merged only with consent (the picker checkbox / scoped
// flag), with a timestamped backup and an atomic parse-validated write -
// and removal is the same edit in reverse, touching only the literal
// signalbox command. Freeform config (tmux.conf) is never edited: the exact
// snippet is printed instead, because merging someone's dotfiles is how
// installers break setups.
//
// The binary itself is not init's business: Homebrew (or make install) owns
// the CLI on PATH, and the menu bar app owns the hub - init wires the things
// around them.

import {
  existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, unlinkSync,
  symlinkSync, realpathSync, renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { renderStatus, runPicker, type Component } from "./initui";
import {
  writeManagedBlock, removeManagedBlock, previewManagedBlock,
  mergeHookCommand, removeHookCommand, mergeCursorHooks, removeCursorHooks,
  detectCodexHooksOwner, recordManaged, forgetManaged,
} from "./managed";

const statusDone = "✓"; // already in place, nothing touched
const statusInstalled = "installed"; // applied this run
const statusNeeds = "✗"; // needs user action (or was declined)

// The exact merge block for ~/.claude/settings.json - embedded so install
// can print it even outside a repo checkout.
const claudeHooksBlock = `{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "signalbox hook claude" }] }]
  }
}`;

// The ~/.cursor/hooks.json block (Cursor 1.7 Hooks, beta -
// https://cursor.com/docs/hooks). Printed for the user to apply, never merged:
// it is their config and may already hold hooks. Event names track the beta
// docs; verify them against a live Cursor if the payload shape shifts.
const cursorHooksBlock = `{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "signalbox hook cursor" }],
    "stop": [{ "command": "signalbox hook cursor" }],
    "subagentStop": [{ "command": "signalbox hook cursor" }],
    "beforeShellExecution": [{ "command": "signalbox hook cursor" }],
    "beforeMCPExecution": [{ "command": "signalbox hook cursor" }]
  }
}`;

// The ~/.codex/hooks.json block (Codex hooks; needs `[features] hooks = true`
// in ~/.codex/config.toml). Printed for the user to merge, never edited - it is
// their config and may already hold hooks (e.g. koi's). Same shape as Claude's
// settings.json hooks; Codex records a trust hash on first run.
const codexHooksBlock = `{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "signalbox hook codex" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "signalbox hook codex" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "signalbox hook codex" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "signalbox hook codex" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "signalbox hook codex" }] }]
  }
}`;

// Every line no-ops when signalbox is not installed: config must survive
// an uninstall without error banners.
const tmuxSnippet = `set -g status-interval 2
set -g status-right '#(command -v signalbox >/dev/null && signalbox tmux status)  %Y-%m-%d %H:%M'
bind-key j display-popup -E -w 80% -h 15 "command -v signalbox >/dev/null && signalbox pick || echo signalbox is not installed"
set-hook -g pane-focus-in 'run-shell -b "command -v signalbox >/dev/null 2>&1 && signalbox tmux seen-pane --socket #{socket_path} --pane #{pane_id} || true"'`;

interface StepResult {
  status: string;
  name: string;
  detail: string;
  // Printed under the checklist for the user to apply by hand.
  after?: string;
}

function fileExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// forceSymlink is ln -sf: install targets are files signalbox owns, so
// clobbering a stale link or copy is correct.
function forceSymlink(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    unlinkSync(dest);
  } catch {}
  symlinkSync(src, dest);
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// locateInstall resolves the running binary and, when it lives in a checkout
// (<repo>/cli/bin/signalbox), the cli root holding adapters/ - adapter
// symlinks must point into the checkout so a `git pull` updates them.
function locateInstall(): { exe: string; repo: string } {
  const exe = realpathOrNull(process.execPath) ?? process.execPath;
  const root = dirname(dirname(exe));
  if (existsSync(join(root, "adapters"))) return { exe, repo: root };
  return { exe, repo: "" };
}

class Setup {
  home = homedir();
  exe: string;
  repo: string;

  // detectOnly makes confirm() always decline, so every step reports its
  // current state without applying - how the status view and the picker probe.
  constructor(
    private yes: boolean,
    private detectOnly = false
  ) {
    const loc = locateInstall();
    this.exe = loc.exe;
    this.repo = loc.repo;
  }

  // confirm gates every install action; --yes short-circuits. EOF or
  // anything but an explicit yes means no - never act on silence.
  confirm(action: string): boolean {
    if (this.detectOnly) return false;
    if (this.yes) return true;
    process.stdout.write(`${action}? [y/N] `);
    const buf = Buffer.alloc(256);
    let line = "";
    try {
      const fs = require("node:fs");
      const n = fs.readSync(0, buf, 0, buf.length, null);
      line = buf.subarray(0, Math.max(n, 0)).toString();
    } catch {
      console.log();
      return false;
    }
    const a = line.trim().toLowerCase();
    return a === "y" || a === "yes";
  }

  // Installs one adapter link (the same ln -sf the adapters' install.sh
  // scripts do, so replacing a stale link is safe by design).
  stepSymlink(name: string, src: string, dest: string): StepResult {
    if (!this.repo) {
      return { status: statusNeeds, name, detail: "adapters/ not found next to this binary; link from a repo checkout" };
    }
    if (!fileExists(src)) return { status: statusNeeds, name, detail: `source missing: ${src}` };
    const resolved = realpathOrNull(dest);
    if (resolved && resolved === realpathOrNull(src)) return { status: statusDone, name, detail: dest };
    if (!this.confirm(`link ${dest} -> ${src}`)) {
      return { status: statusNeeds, name, detail: `run: ln -sf ${src} ${dest}` };
    }
    try {
      forceSymlink(src, dest);
    } catch (err) {
      return { status: statusNeeds, name, detail: String(err) };
    }
    return { status: statusInstalled, name, detail: dest };
  }

  // The plugin symlink plus a check for the predecessor script: running both
  // double-fires every notification.
  stepOpencode(): StepResult {
    const pluginDir = join(this.home, ".config", "opencode", "plugin");
    const r = this.stepSymlink(
      "opencode plugin",
      join(this.repo, "adapters", "opencode", "signalbox.js"),
      join(pluginDir, "signalbox.js")
    );
    if (fileExists(join(pluginDir, "tmux-notify.js"))) {
      r.detail += " (note: old tmux-notify.js present - remove it to avoid double notifications)";
    }
    return r;
  }

  // Merges the signalbox hooks into the user's settings.json, with consent
  // (the picker checkbox / scoped flag), a timestamped backup, and an atomic
  // parse-validated write - a wrong merge there breaks every Claude session,
  // so declining still prints the block to apply by hand.
  stepClaudeHooks(): StepResult {
    const name = "Claude Code hooks";
    const settingsPath = join(this.home, ".claude", "settings.json");
    let scan: HookScan;
    try {
      scan = scanClaudeHooks(settingsPath);
    } catch (err) {
      return { status: statusNeeds, name, detail: `cannot read ${settingsPath}: ${err}` };
    }
    // Every event routes to signalbox (directly or via a command that
    // mentions it) - the canonical setup.
    if (scan.ours.length === claudeHookEvents.length) {
      return { status: statusDone, name, detail: settingsPath };
    }
    // An event whose hooks never mention signalbox is missing, even when the
    // user has their own hook there (a bell, a logger): hook arrays compose,
    // so signalbox is appended alongside and cannot double-fire. Only a
    // command that mentions signalbox counts as wired.
    const missing = claudeHookEvents.filter((ev) => !scan.ours.includes(ev));
    if (!this.confirm(`merge the signalbox hooks into ${settingsPath} (backup taken)`)) {
      return {
        status: statusNeeds,
        name,
        detail: `merge the JSON block below into ${settingsPath}`,
        after: `Claude Code hooks - merge this into ${settingsPath} (missing: ${missing.join(", ")}):\n${claudeHooksBlock}`,
      };
    }
    try {
      // Appends a signalbox entry to each missing event; the user's own
      // entries are left exactly as they were.
      const backup = mergeJSONFile(settingsPath, (settings) => {
        settings.hooks ??= {};
        for (const ev of missing) {
          settings.hooks[ev] ??= [];
          settings.hooks[ev].push({ hooks: [{ type: "command", command: "signalbox hook claude" }] });
        }
      });
      return { status: statusInstalled, name, detail: `${settingsPath}${backup ? ` (backup: ${backup})` : ""}` };
    } catch (err) {
      return {
        status: statusNeeds,
        name,
        detail: `could not merge (${err}) - apply the block below by hand`,
        after: `Claude Code hooks - merge this into ${settingsPath} (missing: ${missing.join(", ")}):\n${claudeHooksBlock}`,
      };
    }
  }

  // Cursor's hooks.json gets the same consent-gated merge as Claude's
  // settings.json (backup, atomic write). Cursor Hooks are beta.
  stepCursorHooks(): StepResult {
    const name = "Cursor hooks";
    const hooksPath = join(this.home, ".cursor", "hooks.json");
    let scan: CursorHookScan;
    try {
      scan = scanCursorHooks(hooksPath);
    } catch (err) {
      return { status: statusNeeds, name, detail: `cannot read ${hooksPath}: ${err}` };
    }
    if (scan.ours.length === cursorHookEvents.length) {
      return { status: statusDone, name, detail: hooksPath };
    }
    // Same append policy as Claude's hooks: an event is missing unless one of
    // its commands mentions signalbox; unrelated hooks compose, so appending
    // alongside them cannot double-fire.
    const missing = cursorHookEvents.filter((ev) => !scan.ours.includes(ev));
    if (!this.confirm(`merge the signalbox hooks into ${hooksPath} (backup taken)`)) {
      return {
        status: statusNeeds,
        name,
        detail: `merge the JSON block below into ${hooksPath}`,
        after: `Cursor hooks - merge this into ${hooksPath} (missing: ${missing.join(", ")}):\n${cursorHooksBlock}`,
      };
    }
    try {
      const backup = mergeJSONFile(hooksPath, (cfg) => {
        cfg.version ??= 1;
        cfg.hooks ??= {};
        for (const ev of missing) {
          cfg.hooks[ev] ??= [];
          cfg.hooks[ev].push({ command: "signalbox hook cursor" });
        }
      });
      return { status: statusInstalled, name, detail: `${hooksPath}${backup ? ` (backup: ${backup})` : ""}` };
    } catch (err) {
      return {
        status: statusNeeds,
        name,
        detail: `could not merge (${err}) - apply the block below by hand`,
        after: `Cursor hooks - merge this into ${hooksPath} (missing: ${missing.join(", ")}):\n${cursorHooksBlock}`,
      };
    }
  }

  // Removal edits out only the literal signalbox command - a wrapper that
  // *mentions* signalbox is the user's own script and is left alone.
  unstepCursorHooks(): StepResult {
    const name = "Cursor hooks";
    const hooksPath = join(this.home, ".cursor", "hooks.json");
    if (!fileExists(hooksPath)) return { status: statusDone, name, detail: "not set up" };
    if (!this.confirm(`remove the signalbox hooks from ${hooksPath} (backup taken)`)) {
      return { status: statusNeeds, name, detail: `remove every "signalbox hook cursor" hook from ${hooksPath}` };
    }
    try {
      let changed = false;
      const backup = mergeJSONFile(hooksPath, (cfg) => {
        for (const ev of Object.keys(cfg.hooks ?? {})) {
          const entries = cfg.hooks[ev];
          if (!Array.isArray(entries)) continue;
          const kept = entries.filter((e: any) => e?.command !== "signalbox hook cursor");
          if (kept.length !== entries.length) changed = true;
          if (kept.length === 0) delete cfg.hooks[ev];
          else cfg.hooks[ev] = kept;
        }
      });
      if (!changed) return { status: statusDone, name, detail: "no signalbox hooks found" };
      return { status: statusInstalled, name, detail: `removed${backup ? ` (backup: ${backup})` : ""}` };
    } catch (err) {
      return { status: statusNeeds, name, detail: `could not edit ${hooksPath}: ${err}` };
    }
  }

  // Codex's hooks.json is the user's file (like Claude's settings.json and
  // Cursor's hooks.json): the block is printed, never merged.
  stepCodexHooks(): StepResult {
    const name = "Codex hooks";
    const hooksPath = join(this.home, ".codex", "hooks.json");
    let scan: HookScan;
    try {
      scan = scanCodexHooks(hooksPath);
    } catch (err) {
      return { status: statusNeeds, name, detail: `cannot read ${hooksPath}: ${err}` };
    }
    if (scan.ours.length === codexHookEvents.length) {
      return { status: statusDone, name, detail: hooksPath };
    }
    // Same append policy as Claude's hooks: an event is missing unless one of
    // its commands mentions signalbox - a user's unrelated hook there does not
    // count as wired, and entries compose so adding ours cannot double-fire.
    const missing = codexHookEvents.filter((ev) => !scan.ours.includes(ev));
    return {
      status: statusNeeds,
      name,
      detail: `merge the JSON block below into ${hooksPath}`,
      after: `Codex hooks - merge this into ${hooksPath} (needs [features] hooks = true in ~/.codex/config.toml; missing: ${missing.join(", ")}):\n${codexHooksBlock}`,
    };
  }

  unstepCodexHooks(): StepResult {
    const name = "Codex hooks";
    const hooksPath = join(this.home, ".codex", "hooks.json");
    return {
      status: statusNeeds,
      name,
      detail: `remove the signalbox hooks from ${hooksPath}`,
      after: `Codex hooks - remove every hook whose command is "signalbox hook codex" from ${hooksPath}.`,
    };
  }

  // tmux config is the user's file: the snippet is printed, not merged.
  // Detection is broad on purpose - a live server counts (the option may have
  // been set with set-option, not written to a file), and both the classic
  // ~/.tmux.conf and the XDG path (tmux 3.1+) are checked.
  stepTmux(): StepResult {
    const name = "tmux integration";
    // Active in the running server = set up, whatever the config file says.
    const live = spawnSync("tmux", ["show-options", "-g", "status-right"]);
    if (live.status === 0 && (live.stdout?.toString() ?? "").includes("signalbox")) {
      return { status: statusDone, name, detail: "active in tmux (status-right)" };
    }
    const confs = [
      join(this.home, ".tmux.conf"),
      join(this.home, ".config", "tmux", "tmux.conf"),
    ];
    for (const conf of confs) {
      try {
        if (readFileSync(conf, "utf8").includes("signalbox")) {
          return { status: statusDone, name, detail: conf };
        }
      } catch {}
    }
    const conf = confs[0];
    return {
      status: statusNeeds,
      name,
      detail: `add the snippet below to ${conf}`,
      after: `tmux integration - add to ${conf} (see docs/tmux.md):\n${tmuxSnippet}`,
    };
  }

  // The app is the product: menu bar, ⌃⌥J jumplist, and the hub it runs in
  // the background. Set up means running - init opens an installed bundle,
  // and points at brew when there is none.
  stepApp(): StepResult {
    const name = "menu bar app";
    if (spawnSync("pgrep", ["-x", "Signalbox"]).status === 0) {
      return { status: statusDone, name, detail: "Signalbox.app is running (it runs the hub)" };
    }
    const candidates = [
      "/Applications/Signalbox.app",
      join(this.home, "Applications", "Signalbox.app"),
    ];
    if (this.repo) candidates.push(join(this.repo, "..", "app", "build", "Signalbox.app"));
    const found = candidates.find((p) => fileExists(p));
    if (!found) {
      return {
        status: statusNeeds, name,
        detail: "install it: brew install dwmkerr/tools/signalbox (or make app from a checkout)",
      };
    }
    if (!this.confirm(`open ${found}`)) {
      return { status: statusNeeds, name, detail: `${found} (not running - open it)` };
    }
    const out = spawnSync("open", [found]);
    if (out.status !== 0) {
      return { status: statusNeeds, name, detail: `open failed: ${(out.stderr?.toString() ?? "").trim()}` };
    }
    return { status: statusInstalled, name, detail: `${found} opened (menu bar + hub)` };
  }

  // ---- removal ------------------------------------------------------------
  // init is also the way to turn things off. Only things signalbox owns are
  // removed directly (its symlinks, the LaunchAgent); user config files
  // (Claude settings, tmux.conf) get removal instructions, never an edit -
  // the same rule that governs install.

  unstepSymlink(name: string, dest: string): StepResult {
    if (!fileExists(dest)) return { status: statusDone, name, detail: "not linked" };
    if (!this.confirm(`remove ${dest}`)) return { status: statusNeeds, name, detail: `run: rm ${dest}` };
    try {
      unlinkSync(dest);
    } catch (err) {
      return { status: statusNeeds, name, detail: String(err) };
    }
    return { status: statusInstalled, name, detail: `removed ${dest}` };
  }

  // Removal edits out only the literal signalbox command - a wrapper that
  // *mentions* signalbox is the user's own script and is left alone.
  unstepClaudeHooks(): StepResult {
    const name = "Claude Code hooks";
    const settingsPath = join(this.home, ".claude", "settings.json");
    if (!fileExists(settingsPath)) return { status: statusDone, name, detail: "not set up" };
    if (!this.confirm(`remove the signalbox hooks from ${settingsPath} (backup taken)`)) {
      return { status: statusNeeds, name, detail: `remove every "signalbox hook claude" hook from ${settingsPath}` };
    }
    try {
      let changed = false;
      const backup = mergeJSONFile(settingsPath, (settings) => {
        for (const ev of Object.keys(settings.hooks ?? {})) {
          const entries = settings.hooks[ev];
          if (!Array.isArray(entries)) continue;
          const kept = entries
            .map((e: any) => {
              if (!Array.isArray(e?.hooks)) return e;
              const hooks = e.hooks.filter((h: any) => h?.command !== "signalbox hook claude");
              if (hooks.length !== e.hooks.length) changed = true;
              return { ...e, hooks };
            })
            .filter((e: any) => !Array.isArray(e?.hooks) || e.hooks.length > 0);
          if (kept.length === 0) delete settings.hooks[ev];
          else settings.hooks[ev] = kept;
        }
      });
      if (!changed) return { status: statusDone, name, detail: "no signalbox hooks found" };
      return { status: statusInstalled, name, detail: `removed${backup ? ` (backup: ${backup})` : ""}` };
    } catch (err) {
      return { status: statusNeeds, name, detail: `could not edit ${settingsPath}: ${err}` };
    }
  }

  unstepTmux(): StepResult {
    const name = "tmux integration";
    // Name whichever config actually holds the snippet (classic or XDG path,
    // the same two stepTmux detects) so the removal instruction points at the
    // right file; fall back to the classic path when neither contains it.
    const confs = [
      join(this.home, ".tmux.conf"),
      join(this.home, ".config", "tmux", "tmux.conf"),
    ];
    const conf =
      confs.find((c) => {
        try {
          return readFileSync(c, "utf8").includes("signalbox");
        } catch {
          return false;
        }
      }) ?? confs[0];
    return {
      status: statusNeeds,
      name,
      detail: `remove the signalbox lines from ${conf}`,
      after: `tmux integration - remove the signalbox status-right, popup binding and pane-focus hook lines from ${conf}.`,
    };
  }

  // Quitting the app stops the hub with it. Deleting the bundle is brew's
  // job (it installed it): uninstall --cask, --zap to drop state too.
  unstepApp(): StepResult {
    const name = "menu bar app";
    if (spawnSync("pgrep", ["-x", "Signalbox"]).status !== 0) {
      return { status: statusDone, name, detail: "not running" };
    }
    if (!this.confirm("quit Signalbox (the hub stops with it)")) {
      return { status: statusNeeds, name, detail: "quit Signalbox from the menu bar" };
    }
    spawnSync("osascript", ["-e", 'tell application "Signalbox" to quit']);
    return {
      status: statusInstalled, name,
      detail: "quit (remove fully with: brew uninstall --cask signalbox, add --zap to drop state)",
    };
  }

  // VS Code needs no setup: agents in its integrated terminal are detected
  // automatically (TERM_PROGRAM=vscode) and jump raises the window. Always
  // reported as ready - this entry only exists so the board shows the
  // integration is there. Its own agent (Copilot) is not wired (no hook API).
  stepVSCode(): StepResult {
    const installed =
      existsSync("/Applications/Visual Studio Code.app") ||
      existsSync(join(this.home, "Applications", "Visual Studio Code.app"));
    return {
      status: statusDone,
      name: "VS Code",
      detail: installed
        ? "jump-back ready - automatic in the integrated terminal, no setup"
        : "jump-back is automatic once VS Code is installed",
    };
  }

  unstepVSCode(): StepResult {
    return { status: statusDone, name: "VS Code", detail: "nothing to remove - detection is automatic" };
  }
}

// mergeJSONFile edits a user-owned JSON config as safely as an editor can:
// parse (missing file starts as {}), timestamped backup of the original,
// mutate, re-parse the serialized result as a sanity check, then an atomic
// rename into place - a crash can never leave a half-written settings file.
// Returns the backup path (null when there was nothing to back up).
// Formatting is normalized to 2-space JSON; the backup preserves the byte-
// exact original.
function mergeJSONFile(path: string, mutate: (obj: any) => void): string | null {
  let raw: string | null = null;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  const obj = raw === null || raw.trim() === "" ? {} : JSON.parse(raw);
  let backup: string | null = null;
  if (raw !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    backup = `${path}.backup-${stamp}`;
    writeFileSync(backup, raw);
  }
  mutate(obj);
  const out = JSON.stringify(obj, null, 2) + "\n";
  JSON.parse(out); // sanity: never install something that does not parse
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
  return backup;
}

const claudeHookEvents = ["Notification", "Stop", "UserPromptSubmit", "SessionStart", "SessionEnd"];

interface HookScan {
  ours: string[]; // events with a command that mentions signalbox
  other: string[]; // events with only unrelated hooks - still need signalbox
  empty: string[]; // events with no hook at all
}

// scanClaudeHooks classifies each hook event. Parsed leniently so user
// settings with matchers still read fine. "ours" recognises both the literal
// `signalbox hook claude` and any command that mentions signalbox, so a
// dispatcher named e.g. signalbox-hook.sh still counts; a generic wrapper
// (agent-notify.sh) lands in "other" and still gets signalbox appended
// alongside - an unrelated hook is not evidence signalbox is wired.
function scanClaudeHooks(settingsPath: string): HookScan {
  let settings: any = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ours: [], other: [], empty: [...claudeHookEvents] };
    throw err;
  }
  const scan: HookScan = { ours: [], other: [], empty: [] };
  for (const evName of claudeHookEvents) {
    const entries = settings?.hooks?.[evName];
    const commands: string[] = Array.isArray(entries)
      ? entries.flatMap((e: any) => (e?.hooks ?? []).map((h: any) => h?.command)).filter(
          (c: unknown): c is string => typeof c === "string"
        )
      : [];
    if (commands.some((c) => c.includes("signalbox"))) scan.ours.push(evName);
    else if (commands.length > 0) scan.other.push(evName);
    else scan.empty.push(evName);
  }
  return scan;
}

const codexHookEvents = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "SessionEnd"];

// Codex's ~/.codex/hooks.json has the same shape as Claude's settings.json hooks
// (`{ hooks: { <Event>: [{ hooks: [{ command }] }] } }`), so the same lenient
// classification applies: "ours" matches any command mentioning signalbox.
function scanCodexHooks(hooksPath: string): HookScan {
  let cfg: any = {};
  try {
    cfg = JSON.parse(readFileSync(hooksPath, "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ours: [], other: [], empty: [...codexHookEvents] };
    throw err;
  }
  const scan: HookScan = { ours: [], other: [], empty: [] };
  for (const evName of codexHookEvents) {
    const entries = cfg?.hooks?.[evName];
    const commands: string[] = Array.isArray(entries)
      ? entries.flatMap((e: any) => (e?.hooks ?? []).map((h: any) => h?.command)).filter(
          (c: unknown): c is string => typeof c === "string"
        )
      : [];
    if (commands.some((c) => c.includes("signalbox"))) scan.ours.push(evName);
    else if (commands.length > 0) scan.other.push(evName);
    else scan.empty.push(evName);
  }
  return scan;
}

const cursorHookEvents = ["sessionStart", "stop", "subagentStop", "beforeShellExecution", "beforeMCPExecution"];

interface CursorHookScan {
  ours: string[]; // events whose hook calls signalbox directly
  other: string[]; // events with some hook, but not the signalbox command
  empty: string[]; // events with no hook at all
}

// scanCursorHooks classifies each Cursor hook event. Cursor's hooks.json shape
// is `{ hooks: { <event>: [{ command }] } }` (beta). Parsed leniently; "ours"
// matches any command mentioning signalbox so a dispatcher script still counts.
function scanCursorHooks(hooksPath: string): CursorHookScan {
  let cfg: any = {};
  try {
    cfg = JSON.parse(readFileSync(hooksPath, "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ours: [], other: [], empty: [...cursorHookEvents] };
    throw err;
  }
  const scan: CursorHookScan = { ours: [], other: [], empty: [] };
  for (const evName of cursorHookEvents) {
    const entries = cfg?.hooks?.[evName];
    const commands: string[] = Array.isArray(entries)
      ? entries.map((e: any) => e?.command).filter((c: unknown): c is string => typeof c === "string")
      : [];
    if (commands.some((c) => c.includes("signalbox"))) scan.ours.push(evName);
    else if (commands.length > 0) scan.other.push(evName);
    else scan.empty.push(evName);
  }
  return scan;
}

const knownAgents = ["claude", "cursor", "codex", "opencode", "pi"];

// One entry per thing init sets up: a category and label for display, an id
// that matches its scope flag, a one-line description for the details view,
// and the step that both detects (under a detect-only Setup) and applies
// (under a yes Setup). Order here is display order.
interface CompDef {
  id: string;
  flag: string;
  category: string;
  label: string;
  info: string;
  // Welcome-screen phrasing: `done` reads as a status when configured
  // ("CLI on your PATH"); `miss` is the consequence when it is not
  // ("hooks not set up - Claude events won't fire").
  done: string;
  miss: string;
  step: (s: Setup) => StepResult;
  // The reverse of step - turns this component off. init toggles both ways.
  unstep: (s: Setup) => StepResult;
}

const piExtDest = (s: Setup) => join(s.home, ".pi", "agent", "extensions", "signalbox.ts");
const opencodePluginDest = (s: Setup) => join(s.home, ".config", "opencode", "plugin", "signalbox.js");

function compDefs(s: Setup): CompDef[] {
  return [
    { id: "app", flag: "--app", category: "signalbox", label: "Menu bar app",
      info: "The Signalbox app is the product: it lives in your menu bar, opens the ⌃⌥J jumplist, and runs the hub - the background board that collects every agent's events.",
      done: "Menu bar app running (hub + jumplist)", miss: "not running - no board, no jumplist",
      step: (x) => x.stepApp(), unstep: (x) => x.unstepApp() },
    { id: "claude", flag: "--agent claude", category: "Integrations", label: "Claude Code",
      info: "Fires events as Claude Code works - asks, finishes, errors - so its sessions show and update on your board.",
      done: "Claude Code hooks active", miss: "hooks not set up, Claude events won't fire",
      step: (x) => x.stepClaudeHooks(), unstep: (x) => x.unstepClaudeHooks() },
    { id: "cursor", flag: "--agent cursor", category: "Integrations", label: "Cursor (testing)",
      info: "Fires events as Cursor's own agent works - asks, finishes, errors - so its sessions show and update on your board. Uses Cursor 1.7 Hooks (beta).",
      done: "Cursor hooks active", miss: "hooks not set up, Cursor events won't fire",
      step: (x) => x.stepCursorHooks(), unstep: (x) => x.unstepCursorHooks() },
    { id: "codex", flag: "--agent codex", category: "Integrations", label: "Codex",
      info: "Fires events as Codex works - asks, finishes, needs approval - so its sessions show and update on your board. Uses Codex hooks (config `[features] hooks = true`).",
      done: "Codex hooks active", miss: "hooks not set up, Codex events won't fire",
      step: (x) => x.stepCodexHooks(), unstep: (x) => x.unstepCodexHooks() },
    { id: "vscode", flag: "", category: "Integrations", label: "VS Code (testing)",
      info: "Jump-back to agents running in VS Code's integrated terminal - automatic, no setup (detected via TERM_PROGRAM). VS Code's own agent is not wired (no hook API yet).",
      done: "VS Code jump-back (automatic)", miss: "",
      step: (x) => x.stepVSCode(), unstep: (x) => x.unstepVSCode() },
    { id: "opencode", flag: "--agent opencode", category: "Integrations", label: "OpenCode",
      info: "Fires events as OpenCode works, so its sessions show and update on your board.",
      done: "OpenCode plugin installed", miss: "plugin not set up, OpenCode events won't fire",
      step: (x) => x.stepOpencode(),
      unstep: (x) => x.unstepSymlink("OpenCode plugin", opencodePluginDest(x)) },
    { id: "pi", flag: "--agent pi", category: "Integrations", label: "pi",
      info: "Fires events as pi works, so its sessions show and update on your board.",
      done: "pi extension installed", miss: "extension not set up, pi events won't fire",
      step: (x) => x.stepSymlink("pi extension",
        join(s.repo, "adapters", "pi", "signalbox.ts"), piExtDest(s)),
      unstep: (x) => x.unstepSymlink("pi extension", piExtDest(x)) },
    { id: "tmux", flag: "--tmux", category: "Integrations", label: "tmux",
      info: "Counts waiting sessions in your tmux status line and adds a popup picker to jump to any of them without leaving tmux.",
      done: "tmux integration active", miss: "not set up, no status count or in-tmux jump",
      step: (x) => x.stepTmux(), unstep: (x) => x.unstepTmux() },
  ];
}

function detect(defs: CompDef[]): Component[] {
  const prober = new Setup(false, true); // detect only
  return defs.map((d) => {
    const r = d.step(prober);
    const configured = r.status === statusDone;
    return {
      id: d.id, category: d.category, label: d.label, info: d.info,
      done: d.done, miss: d.miss,
      configured,
      note: configured ? undefined : "not configured",
      path: configured ? r.detail : undefined,
      after: r.after,
    };
  });
}

// applyByIds runs the real steps for the given component ids and returns a
// one-line outcome each. Snippets that need manual application are returned
// so the caller can print them once, below the list.
function applyByIds(ids: string[]): { lines: string[]; afters: string[] } {
  const doer = new Setup(true, false);
  const defs = compDefs(doer);
  const lines: string[] = [];
  const afters: string[] = [];
  for (const id of ids) {
    const def = defs.find((d) => d.id === id);
    if (!def) continue;
    const r = def.step(doer);
    const mark = r.status === statusNeeds ? "○" : "✔";
    lines.push(`${mark} ${def.label} - ${r.detail}`);
    if (r.after) afters.push(r.after);
  }
  return { lines, afters };
}

// removeByIds is applyByIds' mirror: turn the named components off.
function removeByIds(ids: string[]): { lines: string[]; afters: string[] } {
  const doer = new Setup(true, false);
  const defs = compDefs(doer);
  const lines: string[] = [];
  const afters: string[] = [];
  for (const id of ids) {
    const def = defs.find((d) => d.id === id);
    if (!def) continue;
    const r = def.unstep(doer);
    const mark = r.status === statusNeeds ? "○" : "✔";
    lines.push(`${mark} ${def.label} - ${r.detail}`);
    if (r.after) afters.push(r.after);
  }
  return { lines, afters };
}

// Components whose setup lives in a config file signalbox can write directly
// (behind consent), rather than a symlink it owns or a print-only step.
const userConfigIds = new Set(["tmux", "claude", "cursor", "codex"]);

// writeUserConfigFor writes signalbox's edit into a user-owned config file it
// fully understands (behind --write-user-config / consent), backing it up and
// recording it in the manifest so it stays idempotent and reversible. Returns
// null for components with no writable user config (symlink-owned, or print-only
// like a koi-managed Codex hooks.json), which fall back to the normal step.
function writeUserConfigFor(
  id: string, home: string, dryRun: boolean,
): { label: string; result: string; wrote: boolean } | null {
  const done = (label: string, result: string, wrote: boolean) => ({ label, result, wrote });
  switch (id) {
    case "tmux": {
      const f = join(home, ".tmux.conf");
      if (dryRun) return done("tmux", previewManagedBlock(f, tmuxSnippet), false);
      const r = writeManagedBlock(f, tmuxSnippet);
      if (r.changed) recordManaged({ file: f, kind: "text", backup: r.backup });
      return done("tmux", r.changed ? `wrote ${f}${r.backup ? `  (backup: ${r.backup})` : ""}` : `already current (${f})`, true);
    }
    case "codex": {
      const owner = detectCodexHooksOwner(join(home, ".codex", "config.toml"));
      // A koi-managed hooks.json is print-by-default: a blind rewrite breaks the
      // Codex trust hash. Fall back to the normal (print) step.
      if (owner) return null;
      return writeHooksJson(id, join(home, ".codex", "hooks.json"), "Codex", codexHookEvents, "signalbox hook codex", dryRun);
    }
    case "claude":
      return writeHooksJson(id, join(home, ".claude", "settings.json"), "Claude Code", claudeHookEvents, "signalbox hook claude", dryRun);
    case "cursor": {
      const f = join(home, ".cursor", "hooks.json");
      const cmd = "signalbox hook cursor";
      const m = mergeCursorHooks(f, cursorHookEvents, cmd);
      if (dryRun) return done("Cursor", m.changed.length ? `add signalbox to ${m.changed.join(", ")} in ${f}` : `already present (${f})`, false);
      if (!m.changed.length) return done("Cursor", `already present (${f})`, true);
      const { backup } = m.write();
      recordManaged({ file: f, kind: "json", command: cmd, managedEvents: cursorHookEvents, backup });
      return done("Cursor", `wrote ${f}${backup ? `  (backup: ${backup})` : ""}`, true);
    }
    default:
      // opencode/pi (symlink), app/vscode: no user-config write - the normal
      // step handles them.
      return null;
  }
}

function writeHooksJson(
  id: string, file: string, label: string, events: string[], command: string, dryRun: boolean,
): { label: string; result: string; wrote: boolean } {
  const m = mergeHookCommand(file, events, command);
  if (dryRun) {
    return { label, result: m.changed.length ? `add signalbox to ${m.changed.join(", ")} in ${file}` : `already present (${file})`, wrote: false };
  }
  if (!m.changed.length) return { label, result: `already present (${file})`, wrote: true };
  const { backup } = m.write();
  recordManaged({ file, kind: "json", command, managedEvents: events, backup });
  return { label, result: `wrote ${file}${backup ? `  (backup: ${backup})` : ""}`, wrote: true };
}

// reverseUserConfigFor removes only signalbox's own edit from a user file.
function reverseUserConfigFor(id: string, home: string): string | null {
  const strip = (file: string, cmd: string) => {
    const r = removeHookCommand(file, cmd);
    if (r.changed) forgetManaged(file);
    return r.changed ? `removed signalbox hooks from ${file}${r.backup ? `  (backup: ${r.backup})` : ""}` : null;
  };
  switch (id) {
    case "tmux": {
      const f = join(home, ".tmux.conf");
      const r = removeManagedBlock(f);
      if (r.changed) forgetManaged(f);
      return r.changed ? `removed signalbox block from ${f}${r.backup ? `  (backup: ${r.backup})` : ""}` : null;
    }
    case "codex": return strip(join(home, ".codex", "hooks.json"), "signalbox hook codex");
    case "claude": return strip(join(home, ".claude", "settings.json"), "signalbox hook claude");
    case "cursor": {
      const f = join(home, ".cursor", "hooks.json");
      const r = removeCursorHooks(f, "signalbox hook cursor");
      if (r.changed) forgetManaged(f);
      return r.changed ? `removed signalbox hooks from ${f}${r.backup ? `  (backup: ${r.backup})` : ""}` : null;
    }
    default: return null;
  }
}

export async function runSetup(args: string[]): Promise<void> {
  const yes = args.includes("--yes") || args.includes("-y");
  const verbose = args.includes("-v") || args.includes("--verbose");

  // Scope flags: with any set, only the named components run (non-interactive).
  const wantApp = args.includes("--app");
  const wantTmux = args.includes("--tmux");
  const agents: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent") {
      const a = args[i + 1];
      if (a === "all") agents.push(...knownAgents);
      else if (a && knownAgents.includes(a)) agents.push(a);
      else {
        console.error(`signalbox init: unknown agent "${a ?? ""}" (known: ${knownAgents.join(", ")})`);
        process.exit(2);
      }
    }
  }
  const scoped = wantApp || wantTmux || agents.length > 0;

  const defs = compDefs(new Setup(false, true));

  // Scoped run: act on exactly the named components. `--remove`/`--reverse` turn
  // them off; `--write-user-config` writes the user's config directly (with a
  // backup + manifest) instead of printing a block; `--dry-run` previews it.
  if (scoped) {
    const remove = args.includes("--remove") || args.includes("--reverse");
    const write = args.includes("--write-user-config");
    const dryRun = args.includes("--dry-run");
    const home = homedir();
    const ids: string[] = [];
    if (wantApp) ids.push("app");
    if (wantTmux) ids.push("tmux");
    for (const a of agents) ids.push(a);

    if (remove) {
      // A user-config component's edit is reversed directly (its own step only
      // prints removal instructions, which would be stale here). Everything else
      // goes through the normal symlink/step undo.
      const rest: string[] = [];
      for (const id of ids) {
        if (userConfigIds.has(id)) {
          const rev = reverseUserConfigFor(id, home);
          console.log(rev ? `✓ ${rev}` : `✓ ${id} - no signalbox edit to remove`);
        } else {
          rest.push(id);
        }
      }
      const { lines, afters } = removeByIds(rest);
      for (const l of lines) console.log(l);
      for (const a of afters) console.log(`\n${a}`);
      return;
    }

    if (write || dryRun) {
      // A safe write for files signalbox understands and no other tool manages;
      // anything else falls back to the printed block, and the summary counts it
      // honestly as "needs a manual step" - never a blanket "done".
      let configured = 0, manual = 0;
      for (const id of ids) {
        const wr = writeUserConfigFor(id, home, dryRun);
        if (wr) {
          console.log(`${dryRun ? "" : "✔ "}${wr.label}: ${wr.result}`);
          configured++;
          continue;
        }
        const { lines, afters } = applyByIds([id]);
        for (const l of lines) console.log(l);
        for (const a of afters) console.log(`\n${a}`);
        if (afters.length) manual++; else configured++;
      }
      const bits = [`${configured} configured`];
      if (manual) bits.push(`${manual} need a manual step`);
      console.log(`\n${dryRun ? "(dry run) " : ""}${bits.join(" · ")}`);
      return;
    }

    const { lines, afters } = applyByIds(ids);
    for (const l of lines) console.log(l);
    for (const a of afters) console.log(`\n${a}`);
    return;
  }

  const components = detect(defs);
  const statusOnly = args.includes("--status");

  // Non-interactive (piped, --status, --yes, or -v): status view, applying
  // everything on --yes. `-v` implies the read-only status view - its only
  // effect is to print paths, which the picker never shows, so on a TTY plain
  // `init -v` must render the board with paths rather than open the picker.
  if (statusOnly || verbose || !process.stdout.isTTY || yes) {
    if (yes) {
      const { afters } = applyByIds(defs.map((d) => d.id));
      console.log(renderStatus(detect(defs), verbose));
      for (const a of afters) console.log(`\n${a}`);
    } else {
      console.log(renderStatus(components, verbose));
    }
    return;
  }

  // Interactive: the picker. Toggling a component on and pressing apply IS the
  // consent to edit that file, so here init WRITES a user config it understands
  // (naming the file + backup in the output), prints for anything a another tool
  // manages, and reconciles honestly at the end - never a blanket "Done".
  const home = homedir();
  await runPicker(components, async (changes) => {
    const out: string[] = [];
    const afters: string[] = [];
    let configured = 0, manual = 0, removed = 0;

    for (const c of changes.install) {
      const wr = writeUserConfigFor(c.id, home, false);
      if (wr) {
        out.push(`✔ ${wr.label}  ${wr.result}`);
        configured++;
        continue;
      }
      // Symlink-owned (opencode/pi/app) or print-only (koi-managed codex): use
      // the normal step. A step that returns a snippet needs a manual paste.
      const r = applyByIds([c.id]);
      if (r.afters.length) {
        out.push(`⚠ ${c.label} - needs a manual step (below)`);
        afters.push(...r.afters);
        manual++;
      } else {
        out.push(...r.lines.map((l) => l.replace(/^○/, "✔")));
        configured++;
      }
    }

    for (const c of changes.remove) {
      if (userConfigIds.has(c.id)) {
        const rev = reverseUserConfigFor(c.id, home);
        out.push(rev ? `✓ ${rev}` : `✓ ${c.label} - no signalbox edit to remove`);
      } else {
        const r = removeByIds([c.id]);
        out.push(...r.lines);
        afters.push(...r.afters);
      }
      removed++;
    }

    if (afters.length) out.push("", ...afters);
    const bits: string[] = [];
    if (configured) bits.push(`${configured} configured`);
    if (manual) bits.push(`${manual} need a manual step`);
    if (removed) bits.push(`${removed} removed`);
    out.push("", bits.length ? bits.join(" · ") : "no changes");
    if (manual) out.push("Run signalbox init --status to see what is left.");
    return out;
  });
}
