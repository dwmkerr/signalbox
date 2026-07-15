// `signalbox install` - the README's front door: an idempotent guided
// install. Every step detects current state before acting and reports one of
// three statuses, so re-running is a status checklist, never a re-install.
// It only ever writes things it owns (its adapter symlinks) - user config
// files (Claude settings, tmux.conf) get the exact snippet printed instead,
// because merging someone's settings is how installers break setups.
//
// The binary itself is not init's business: Homebrew (or make install) owns
// the CLI on PATH, and the menu bar app owns the hub - init wires the things
// around them.

import {
  existsSync, lstatSync, readFileSync, mkdirSync, unlinkSync,
  symlinkSync, realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { renderStatus, runPicker, type Component } from "./initui";

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

  // Only ever detects and prints. Hook config lives in the user's
  // settings.json alongside their own hooks; a wrong merge there breaks
  // every Claude session, so the user applies the block themselves.
  stepClaudeHooks(): StepResult {
    const name = "Claude Code hooks";
    const settingsPath = join(this.home, ".claude", "settings.json");
    let scan: HookScan;
    try {
      scan = scanClaudeHooks(settingsPath);
    } catch (err) {
      return { status: statusNeeds, name, detail: `cannot read ${settingsPath}: ${err}` };
    }
    // Every event calls signalbox directly - the canonical setup.
    if (scan.ours.length === claudeHookEvents.length) {
      return { status: statusDone, name, detail: settingsPath };
    }
    // Every event has *some* hook, but not the literal signalbox command:
    // the user routes through a wrapper/dispatcher (e.g. a dotfiles script
    // that calls signalbox). We cannot verify what a script does, and
    // printing the merge block would double-fire every hook - so report it
    // as present-but-unverified, never as missing.
    if (scan.empty.length === 0) {
      return {
        status: statusDone,
        name,
        detail: `${settingsPath} (hooks present via a wrapper - ensure it calls 'signalbox hook claude')`,
      };
    }
    return {
      status: statusNeeds,
      name,
      detail: `merge the JSON block below into ${settingsPath}`,
      after: `Claude Code hooks - merge this into ${settingsPath} (missing: ${scan.empty.join(", ")}):\n${claudeHooksBlock}`,
    };
  }

  // Cursor's hooks.json is the user's file (like Claude's settings.json): the
  // block is printed, never merged. Cursor Hooks are beta.
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
    // Every event already routes somewhere but not through the literal
    // signalbox command - assume a wrapper and report present-but-unverified,
    // never missing (printing the block would double-fire the hooks).
    if (scan.empty.length === 0) {
      return {
        status: statusDone,
        name,
        detail: `${hooksPath} (hooks present via a wrapper - ensure it calls 'signalbox hook cursor')`,
      };
    }
    return {
      status: statusNeeds,
      name,
      detail: `merge the JSON block below into ${hooksPath}`,
      after: `Cursor hooks - merge this into ${hooksPath} (missing: ${scan.empty.join(", ")}):\n${cursorHooksBlock}`,
    };
  }

  unstepCursorHooks(): StepResult {
    const name = "Cursor hooks";
    const hooksPath = join(this.home, ".cursor", "hooks.json");
    return {
      status: statusNeeds,
      name,
      detail: `remove the signalbox hooks from ${hooksPath}`,
      after: `Cursor hooks - remove every hook whose command is "signalbox hook cursor" from ${hooksPath}.`,
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

  unstepClaudeHooks(): StepResult {
    const name = "Claude Code hooks";
    const settingsPath = join(this.home, ".claude", "settings.json");
    return {
      status: statusNeeds,
      name,
      detail: `remove the signalbox hooks from ${settingsPath}`,
      after: `Claude Code hooks - remove every hook whose command is "signalbox hook claude" from ${settingsPath}.`,
    };
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

const claudeHookEvents = ["Notification", "Stop", "UserPromptSubmit", "SessionStart", "SessionEnd"];

interface HookScan {
  ours: string[]; // events whose hook calls signalbox directly
  other: string[]; // events with some hook, but not the signalbox command
  empty: string[]; // events with no hook at all
}

// scanClaudeHooks classifies each hook event. Parsed leniently so user
// settings with matchers still read fine. "ours" recognises both the literal
// `signalbox claude-hook` and any command that mentions signalbox, so a
// dispatcher named e.g. signalbox-hook.sh still counts; a generic wrapper
// (agent-notify.sh) lands in "other", which the caller treats as present.
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

const knownAgents = ["claude", "cursor", "opencode", "pi"];

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

  // Scoped run: act on exactly the named components. `--remove` turns them
  // off (init is the way both in and out); otherwise it sets them up.
  if (scoped) {
    const remove = args.includes("--remove");
    const ids: string[] = [];
    if (wantApp) ids.push("app");
    if (wantTmux) ids.push("tmux");
    for (const a of agents) ids.push(a);
    const { lines, afters } = remove ? removeByIds(ids) : applyByIds(ids);
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

  // Interactive: the picker. It hands back what to install and what to remove.
  await runPicker(components, async (changes) => {
    const add = applyByIds(changes.install.map((c) => c.id));
    const drop = removeByIds(changes.remove.map((c) => c.id));
    const lines = [...add.lines, ...drop.lines];
    // Snippets (tmux/claude add or remove instructions) print under the list.
    const afters = [...add.afters, ...drop.afters];
    if (afters.length) lines.push("", ...afters);
    return lines;
  });
}
