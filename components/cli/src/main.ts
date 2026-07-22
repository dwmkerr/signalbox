#!/usr/bin/env bun
// signalbox - one board for everything you run. Command dispatch per
// specs/cli.md: hook-path commands always exit 0; interactive commands may
// fail loudly.

import { basename } from "node:path";
import * as ev from "./event";
import type { Event, Origin, Proc } from "./event";
import { Client, fetchState, hubURL, stateDir, logTo, DefaultURL } from "./client";
import { Hub, listen, validateBindConfig, isLoopbackAddress } from "./hub";
import * as tmux from "./tmux";
import { jump } from "./jump";
import { runPair } from "./pair";
import { captureProc, captureAgentProc } from "./proc";
import { mapClaudeHook, claudeReply, sessionName, type ClaudeHook } from "./claude";
import { mapCursorHook, cursorReply, cursorWorkspace, cursorBundle, editorTerminalOrigin, hostPrefixedAgent, type CursorHook } from "./cursor";
import { mapCodexHook, codexReply, codexSessionName, type CodexHook } from "./codex";
import {
  loadSettings, saveSettings, settingsPath, normalizeBindInput, lanHint,
  shouldGenerateToken, generateToken,
} from "./config";
import { runSetup } from "./setup";
import {
  glyph, coloredGlyph, statusWord, titleOf, age, printSessions, tmuxStatusLine,
  cropRunes, dimOn, dimOff, needsYou, visible, termWidth,
} from "./display";

// A plain const stamped by release-please; the compiled binary carries it.
const version = "0.1.2"; // x-release-please-version

// The short help: what a person types. Plumbing (hooks, tmux glue, drain)
// and env vars live in `signalbox help` - the first screen a new user sees
// should fit in one glance.
function shortUsage(): string {
  return `signalbox ${version} - one board for everything you run

usage: signalbox <command> [flags]

  init         guided setup: the app, coding-agent hooks, tmux
  state        show the board
  jump <key>   jump to a session's origin and mark it seen
  pick         pick a waiting session interactively and jump to it
  fire         fire an event from a script, cron job, or CI
  hub          run the hub in the foreground (the app runs one for you)

'signalbox help' lists every command, flag, and environment variable.
`;
}

function usage(): string {
  return `signalbox ${version} - one board for everything you run

usage: signalbox <command> [flags]

  init         guided setup: the app, coding-agent hooks, tmux [--yes]
               scope with --app, --tmux, --agent <claude|cursor|codex|opencode|pi|all>
               (repeatable); no scope flag sets up everything
               --status shows the checklist without the interactive picker
  hub          run the hub in the foreground [--port 8377] [--bind 127.0.0.1]
               (the menu bar app runs one for you; use this headless or in dev)
               --bind wide (e.g. 0.0.0.0) needs SIGNALBOX_TOKEN; non-loopback
               clients must then send Authorization: Bearer <token>
  pair         show a QR a phone scans to pair: it carries this hub's LAN URL
               and a one-time code the phone trades for the token [--host <ip>]
               (run on the hub machine; needs --bind wide + SIGNALBOX_TOKEN)
  config       persist how the hub binds so it needs no flags to let other
               devices connect:
               config get                       show the effective hub config
               config set hub.bind <loopback|any|IP>  (loopback = this Mac only;
                                                any = every interface, incl. VPN)
               config set hub.token <value>     ("" or --generate mints one)
  state        show the board [--json] [--all] [--tag T] [--exclude-tag T]
  jump <key>   jump to a session's origin (tmux pane or URL) and mark it seen
  pick         pick a waiting session interactively and jump to it
  fire         fire an event: --agent A --event E [--reason R] [--title T]
               [--prompt P] [--reply R] [--session-key K] [--origin-url U]
               [--pid P [--pid-name N]] (pid = the agent process, for the
               hub's liveness sweep; name resolved from the pid when omitted)

  session ack <key>          mark a session seen (clears the flag; row stays)
  session hide <key>         hide until its next agent event (hide on busy = seen)
  session show <key>         unhide a hidden session (reappears in place)
  session pin <key>          pin a session to the top of the board
  session unpin <key>        remove the pin
  session rename <key> [t…]  set your own name for a session (empty clears)
  session remove <key>       take a session off the board now
  session tag <key> <tag>    add a discreet tag to a session (e.g. work)
  session untag <key> <tag>  remove a tag
  session list               alias for state

  tmux status                one-line summary for tmux status-right
  tmux seen-pane --socket S --pane P   mark flagged sessions at a pane seen
                             (for tmux pane-focus-in; no-op when nothing flagged)

  hook claude                read a Claude Code hook payload on stdin, fire it
  hook cursor                read a Cursor hook payload on stdin, fire it
  hook codex                 read a Codex hook payload on stdin, fire it

  drain        flush the offline spool to the hub

env: SIGNALBOX_URL (default ${DefaultURL})
     SIGNALBOX_STATE_DIR (default ~/.local/state/signalbox)
     SIGNALBOX_PROFILE=full|redacted
     SIGNALBOX_EXPIRE (hub: end sessions with no agent event for this long, default 24h)
     SIGNALBOX_BIND (hub: bind address, default 127.0.0.1; --bind wins)
     SIGNALBOX_TOKEN (bearer token; required to bind non-loopback, sent by clients)
`;
}

// runHookSafe wraps hook-path commands: a notifier must never break the
// agent that calls it, so failures are logged and the exit code is always 0.
async function runHookSafe(fn: () => Promise<void> | void): Promise<never> {
  try {
    await fn();
  } catch (err) {
    logTo(stateDir(), `panic: ${err}`);
  }
  process.exit(0);
}

// ---- flags -----------------------------------------------------------------

// parseFlags: minimal --flag value parser (every signalbox flag takes a
// value except --yes/--json/--all, which callers handle themselves).
function parseFlags(args: string[], boolFlags: string[] = []): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (boolFlags.includes(name)) {
        flags[name] = "true";
      } else {
        flags[name] = args[++i] ?? "";
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

// ---- fire ------------------------------------------------------------------

function shortHash(s: string): string {
  // FNV-1a then hex - only used for the no-tmux session-key default, where
  // any stable short digest of the cwd will do.
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h = (h ^ b) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

async function buildEvent(opts: {
  agent: string;
  eventType: string;
  reason?: string;
  title?: string;
  prompt?: string;
  reply?: string;
  sessionKey?: string;
  originURL?: string;
  origin?: Origin | null;
  cwd?: string;
  proc?: Proc | null;
}): Promise<Event> {
  const cwd = opts.cwd || process.cwd();
  let origin: Origin | null = null;
  // An explicit origin (e.g. a Cursor session, which runs no tmux pane) wins;
  // otherwise a URL origin, otherwise the calling tmux pane, otherwise an
  // editor's integrated terminal (VS Code / Cursor). tmux beats the editor
  // check: a pane is a more precise jump target than an app window.
  if (opts.origin) origin = opts.origin;
  else if (opts.originURL) origin = { kind: "url", url: opts.originURL };
  else origin = tmux.currentOrigin() ?? editorTerminalOrigin(process.env);
  let sessionKey = opts.sessionKey ?? "";
  if (!sessionKey) {
    // Key on the agent family, never the host-prefixed display name: a
    // "vscode/claude" session must derive "claude:<...>" so it cannot split
    // from the same session seen in a plain terminal (specs/events.md).
    const family = ev.agentFamily(opts.agent);
    sessionKey = origin?.tmux ? `${family}:${origin.tmux.pane}` : `${family}:${shortHash(cwd)}`;
  }
  const e: Event = {
    v: ev.Version,
    id: crypto.randomUUID(),
    ts: ev.nowTS(),
    host: ev.shortHostname(),
    agent: opts.agent,
    event: opts.eventType,
    session_key: sessionKey,
    cwd,
  };
  if (opts.reason) e.reason = opts.reason;
  if (opts.title) e.title = opts.title;
  // Crop at the emitter, whatever the source: the full text must never
  // leave this process.
  const prompt = ev.cropPrompt(opts.prompt ?? "");
  if (prompt) e.prompt = prompt;
  const reply = ev.cropReply(opts.reply ?? "");
  if (reply) e.reply = reply;
  if (origin) e.origin = origin;
  if (opts.proc) e.proc = opts.proc;
  if (process.env.SIGNALBOX_PROFILE === "redacted") await ev.redact(e);
  return e;
}

// deliver posts without tmux side-effects - user actions run in whatever
// pane the user is in, so side-effects would land on the wrong pane.
async function deliver(e: Event): Promise<void> {
  const c = new Client(hubURL(), stateDir());
  try {
    await c.deliver(e);
  } catch (err) {
    c.logf(`deliver ${e.session_key}/${e.event}: ${err}`);
  }
}

// fireEvent applies the tmux side-effects then delivers. Side-effects come
// first so the in-terminal signal appears even when the hub is down.
async function fireEvent(e: Event): Promise<void> {
  if (e.event === ev.Attention || e.event === ev.Done || e.event === ev.Error) tmux.notify();
  else if (e.event === ev.Busy || e.event === ev.Ended) tmux.clear();
  await deliver(e);
}

async function runFire(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const agent = flags["agent"] ?? "";
  const eventType = flags["event"] ?? "";
  if (!agent || !ev.validType(eventType)) {
    logTo(stateDir(), `fire: --agent and a valid --event are required (agent="${agent}" event="${eventType}")`);
    return;
  }
  let proc: Proc | null = null;
  const pid = parseInt(flags["pid"] ?? "0", 10);
  if (pid > 0) {
    proc = flags["pid-name"] ? { pid, name: flags["pid-name"] } : captureProc(pid);
  }
  await fireEvent(
    await buildEvent({
      agent,
      eventType,
      reason: flags["reason"],
      title: flags["title"],
      prompt: flags["prompt"] ?? flags["detail"],
      reply: flags["reply"],
      sessionKey: flags["session-key"],
      originURL: flags["origin-url"],
      proc,
    })
  );
}

// ---- user actions ------------------------------------------------------------

// Built directly, not via buildEvent: the key the user holds is the
// displayed one, and re-applying redaction would hash it a second time.
async function runAck(args: string[]): Promise<void> {
  if (args.length !== 1 || !args[0]) {
    logTo(stateDir(), "ack: usage: signalbox session ack <session_key>");
    return;
  }
  await deliver(ev.newSeen(args[0]));
}

async function runHide(args: string[]): Promise<void> {
  if (args.length !== 1 || !args[0]) {
    logTo(stateDir(), "hide: usage: signalbox session hide <session_key>");
    return;
  }
  await deliver(ev.newHide(args[0]));
}

async function runShow(args: string[]): Promise<void> {
  if (args.length !== 1 || !args[0]) {
    logTo(stateDir(), "show: usage: signalbox session show <session_key>");
    return;
  }
  await deliver(ev.newShow(args[0]));
}

async function runPin(args: string[]): Promise<void> {
  if (args.length !== 1 || !args[0]) {
    logTo(stateDir(), "pin: usage: signalbox session pin <session_key>");
    return;
  }
  await deliver(ev.newPin(args[0]));
}

async function runUnpin(args: string[]): Promise<void> {
  if (args.length !== 1 || !args[0]) {
    logTo(stateDir(), "unpin: usage: signalbox session unpin <session_key>");
    return;
  }
  await deliver(ev.newUnpin(args[0]));
}

async function runLabel(args: string[]): Promise<void> {
  if (args.length < 1 || !args[0]) {
    logTo(stateDir(), "rename: usage: signalbox session rename <session_key> [text...]");
    return;
  }
  await deliver(ev.newLabel(args[0], args.slice(1).join(" ")));
}

async function runTag(args: string[]): Promise<void> {
  if (args.length < 2 || !args[0] || !args[1]) {
    logTo(stateDir(), "tag: usage: signalbox session tag <session_key> <tag>");
    return;
  }
  await deliver(ev.newTag(args[0], args[1]));
}

async function runUntag(args: string[]): Promise<void> {
  if (args.length < 2 || !args[0] || !args[1]) {
    logTo(stateDir(), "untag: usage: signalbox session untag <session_key> <tag>");
    return;
  }
  await deliver(ev.newUntag(args[0], args[1]));
}

async function runRemove(args: string[]): Promise<void> {
  if (args.length !== 1 || !args[0]) {
    logTo(stateDir(), "remove: usage: signalbox session remove <session_key>");
    return;
  }
  await deliver(ev.newEnded(args[0], "removed"));
}

// Presence hook for tmux pane-focus-in: any flagged session that originated
// at the focused pane is marked seen. Fires nothing when nothing is flagged,
// so focus churn cannot spam the event log.
async function runSeenPane(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const socket = flags["socket"] ?? "";
  const pane = flags["pane"] ?? "";
  if (!socket || !pane) {
    logTo(stateDir(), "seen-pane: usage: signalbox tmux seen-pane --socket <path> --pane <id>");
    return;
  }
  // Short timeout: pane-focus-in fires on every pane switch, so a dead hub
  // must cost one quick failure, not a hang.
  let doc;
  try {
    doc = (await fetchState(hubURL(), 200)).doc;
  } catch (err) {
    logTo(stateDir(), `seen-pane: ${err}`);
    return;
  }
  for (const s of doc.sessions) {
    if (!needsYou(s)) continue;
    const t = s.origin?.tmux;
    if (t && t.socket === socket && t.pane === pane) await deliver(ev.newSeen(s.session_key));
  }
}

// ---- claude hook -------------------------------------------------------------

async function runClaudeHook(): Promise<void> {
  const dir = stateDir();
  let payload: ClaudeHook;
  let text: string;
  try {
    text = await Bun.stdin.text();
    payload = JSON.parse(text.slice(0, 1 << 20));
  } catch (err) {
    logTo(dir, `claude-hook: parse stdin: ${err}`);
    return;
  }
  const settings = loadSettings();
  const mapped = mapClaudeHook(payload, settings.claudeClearEnds);
  if (!mapped) return;
  // Failsafe: with no session_id we cannot form the stable claude:<id> key, so
  // buildEvent falls back to a pane/cwd-derived key. That fallback can split one
  // session across several rows, so log the degraded case rather than let it
  // happen silently.
  const key = payload.session_id ? `claude:${payload.session_id}` : "";
  if (!payload.session_id) logTo(dir, "claude-hook: no session_id; falling back to a pane/cwd key (session rows may split)");
  // A Claude session running inside an editor's integrated terminal is shown
  // under that editor's icon: the DISPLAY agent gains a host prefix
  // ("vscode/claude", "cursor/claude") so the board draws the editor mark
  // badged with Claude's glyph. Display-only - the key stays "claude:<id>"
  // above, so the same session keeps one identity in a plain terminal or an
  // editor (specs/adapters.md, specs/events.md).
  const agent = hostPrefixedAgent("claude", process.env);
  // Explicit names beat inferred ones: a /rename is the user telling us what
  // this session IS; the cwd basename is only a guess. Off (claudeRenameTitle
  // false) skips the custom title so the cwd basename fallback below wins; the
  // user's own jumplist rename (a label event) still overrides either way.
  let title =
    settings.claudeRenameTitle && payload.transcript_path ? sessionName(payload.transcript_path) : "";
  if (!title && payload.cwd) title = basename(payload.cwd);
  // Hooks are descendants of the agent, but usually via a transient shell
  // (sh -c, or the agent-notify.sh dispatcher) - walk past shells to the
  // agent itself so the liveness sweep tracks the right process.
  const proc = captureAgentProc(process.ppid);
  const e = await buildEvent({
    agent,
    eventType: mapped.eventType,
    reason: mapped.reason,
    title,
    prompt: mapped.detail,
    reply: claudeReply(payload),
    sessionKey: key,
    cwd: payload.cwd,
    proc,
  });
  // Diagnostic (off by default): SIGNALBOX_RAW attaches the untouched hook
  // payload so it rides into the hub's own event log - inspect it from the
  // server (`state --json` / events.jsonl) instead of a stray file. Redacted
  // out on corp hosts; never sent in normal operation.
  if (process.env.SIGNALBOX_RAW) e.raw = text;
  await fireEvent(e);
}

// ---- cursor hook -------------------------------------------------------------

async function runCursorHook(): Promise<void> {
  const dir = stateDir();
  let payload: CursorHook;
  let text: string;
  try {
    text = await Bun.stdin.text();
    payload = JSON.parse(text.slice(0, 1 << 20));
  } catch (err) {
    logTo(dir, `cursor-hook: parse stdin: ${err}`);
    return;
  }
  const mapped = mapCursorHook(payload);
  if (!mapped) return;
  // Failsafe like the Claude hook: without a conversation_id the key falls back
  // to a pane/cwd-derived one, which can split a session - log rather than hide it.
  const key = payload.conversation_id ? `cursor:${payload.conversation_id}` : "";
  if (!payload.conversation_id) logTo(dir, "cursor-hook: no conversation_id; falling back to a pane/cwd key (session rows may split)");
  const workspace = cursorWorkspace(payload);
  const title = workspace ? basename(workspace) : "";
  // Cursor's own agent has no tmux pane; the origin carries the app bundle id
  // so jump raises the Cursor window (window-level; see specs/adapters.md).
  const origin: Origin = { kind: "cursor", cursor: { bundle: cursorBundle } };
  // Hooks are descendants of the Cursor process - walk past shells to the
  // agent so the liveness sweep tracks the right process.
  const proc = captureAgentProc(process.ppid);
  const e = await buildEvent({
    agent: "cursor",
    eventType: mapped.eventType,
    reason: mapped.reason,
    title,
    prompt: mapped.detail,
    reply: cursorReply(payload),
    sessionKey: key,
    origin,
    cwd: workspace || undefined,
    proc,
  });
  if (process.env.SIGNALBOX_RAW) e.raw = text;
  await fireEvent(e);
}

// ---- codex hook --------------------------------------------------------------

async function runCodexHook(): Promise<void> {
  const dir = stateDir();
  let payload: CodexHook;
  let text: string;
  try {
    text = await Bun.stdin.text();
    payload = JSON.parse(text.slice(0, 1 << 20));
  } catch (err) {
    logTo(dir, `codex-hook: parse stdin: ${err}`);
    return;
  }
  const settings = loadSettings();
  const mapped = mapCodexHook(payload, settings.codexClearEnds);
  if (!mapped) return;
  // Without a session_id we cannot form the stable codex:<id> key, so buildEvent
  // falls back to a pane/cwd key that can split one session across rows - log it.
  const key = payload.session_id ? `codex:${payload.session_id}` : "";
  if (!payload.session_id) logTo(dir, "codex-hook: no session_id; falling back to a pane/cwd key (session rows may split)");
  // Codex run inside an editor terminal shows under the editor mark, badged with
  // Codex's glyph (display only; the key stays codex:<id>).
  const agent = hostPrefixedAgent("codex", process.env);
  // A Codex /rename names the session; adopt it like Claude's (toggleable). The
  // cwd folder name is the fallback; a jumplist rename still overrides either.
  let title =
    settings.codexRenameTitle && payload.session_id ? codexSessionName(payload.session_id) : "";
  if (!title && payload.cwd) title = basename(payload.cwd);
  const proc = captureAgentProc(process.ppid);
  const e = await buildEvent({
    agent,
    eventType: mapped.eventType,
    reason: mapped.reason,
    title,
    prompt: mapped.detail,
    reply: codexReply(payload),
    sessionKey: key,
    cwd: payload.cwd,
    proc,
  });
  if (process.env.SIGNALBOX_RAW) e.raw = text;
  await fireEvent(e);
}

// ---- hub -----------------------------------------------------------------------

function expireAgeMs(): number {
  const def = 24 * 60 * 60 * 1000;
  const v = process.env.SIGNALBOX_EXPIRE;
  if (!v) return def;
  // Go-style duration strings ("24h", "90m", "1h30m").
  const m = v.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) {
    console.error(`signalbox: invalid SIGNALBOX_EXPIRE ${JSON.stringify(v)}, using 24h`);
    return def;
  }
  const ms =
    (parseFloat(m[1] ?? "0") * 3600 + parseFloat(m[2] ?? "0") * 60 + parseFloat(m[3] ?? "0")) * 1000;
  if (ms <= 0) {
    console.error(`signalbox: invalid SIGNALBOX_EXPIRE ${JSON.stringify(v)}, using 24h`);
    return def;
  }
  return ms;
}

function runHub(args: string[]): void {
  const { flags } = parseFlags(args);
  const port = parseInt(flags["port"] ?? "8377", 10);
  const settings = loadSettings();
  // Bind resolution order: --bind flag, then SIGNALBOX_BIND, then the persisted
  // config.hub.bind, then loopback. The persisted value is what lets the
  // app-spawned hub (which passes no --bind) come up reachable by other devices
  // with zero flags. The same normalizer runs whichever source wins, so a
  // friendly word ("any", "loopback") works identically from the flag, the env,
  // or the file, and the result is always the literal address we bind.
  const bindInput = flags["bind"] || process.env.SIGNALBOX_BIND || settings.hub.bind || "127.0.0.1";
  const norm = normalizeBindInput(bindInput);
  if (norm.error) fatal(norm.error);
  const bind = norm.value!;
  // Token: env wins over the persisted config token. The token is the only way
  // a non-loopback client authenticates.
  let token = process.env.SIGNALBOX_TOKEN || settings.hub.token || "";
  // A non-loopback bind with no token would be refused below. Rather than fail,
  // mint a stable token and persist it, so a bind other devices can reach plus a
  // bare `signalbox hub` Just Works and stays reachable across restarts on one
  // token.
  if (shouldGenerateToken(bind, token)) {
    token = generateToken();
    try {
      saveSettings({ hub: { token } });
      console.error(`signalbox: generated a hub token and saved it to ${settingsPath()}`);
    } catch (err) {
      // Persisting failed (read-only home?); still boot with the token for this
      // run, but warn that it will not survive a restart.
      console.error(`signalbox: generated a hub token but could not save it (${err}); it will not persist`);
    }
  }
  // Backstop: still refuse a non-loopback bind with no token. The auto-generate
  // path above should mean this never fires, but a bad SIGNALBOX_TOKEN="" plus a
  // wildcard bind must never slip through.
  const bindErr = validateBindConfig(bind, token);
  if (bindErr) fatal(bindErr);
  const hub = new Hub(stateDir(), version, token, bind);
  const expire = expireAgeMs();
  hub.startExpiry(10 * 60 * 1000, expire);
  // Much shorter than expiry: a dead process shows as an eternal spinner
  // until the sweep catches it.
  hub.startLiveness(30 * 1000);
  listen(hub, port, bind);
  console.error(
    `signalbox hub ${version} listening on http://${bind}:${port} (state: ${stateDir()}, expire: ${expire / 3600000}h)`
  );
  if (!isLoopbackAddress(bind)) {
    console.error(
      `signalbox: bound to ${bind}; non-loopback clients must send Authorization: Bearer $SIGNALBOX_TOKEN (loopback clients need no token)`
    );
  }
}

// ---- config ----------------------------------------------------------------

// runConfig reads and writes the persistent hub network settings that runHub
// (and the app-spawned hub) honor. A deliberately tiny two-key surface
// (hub.bind, hub.token), not a general config editor: the app owns everything
// else in settings.json.
function runConfig(args: string[]): void {
  const { flags, rest } = parseFlags(args, ["generate"]);
  const sub = rest[0] ?? "get";
  if (sub === "get") {
    const s = loadSettings();
    // The stored value is a literal address; normalize once more only to absorb
    // a value an older build may have written (e.g. "loopback"). Describe it by
    // who can reach it, in the same "allow other devices" language config set
    // uses - never "LAN mode", which hid that a wildcard also answers VPN. For a
    // wildcard bind, add the LAN IPv4 a device would actually dial. The token
    // value is never printed, only whether one is set, so it cannot leak.
    const bind = normalizeBindInput(s.hub.bind).value ?? s.hub.bind;
    let reach: string;
    if (isLoopbackAddress(bind)) {
      reach = "this Mac only";
    } else if (bind === "0.0.0.0" || bind === "::") {
      const ip = lanHint();
      reach = ip
        ? `other devices may connect; this Mac is reachable at ${ip}`
        : "other devices may connect; no network interface detected";
    } else {
      reach = `other devices may connect; this Mac is reachable at ${bind}`;
    }
    console.log(`hub.bind:  ${bind} (${reach})`);
    console.log(`hub.token: ${s.hub.token ? "set" : "none"}`);
    return;
  }
  if (sub === "set") {
    const key = rest[1] ?? "";
    const value = rest[2] ?? "";
    if (key === "hub.bind") {
      // Store the literal address, never the word the user typed: bind means
      // bind. "lan" is refused here with guidance toward "any" or a specific IP.
      const norm = normalizeBindInput(value);
      if (norm.error) fatal(norm.error);
      saveSettings({ hub: { bind: norm.value! } });
      console.log(`hub.bind set to ${norm.value}`);
      return;
    }
    if (key === "hub.token") {
      // An empty value or --generate mints a fresh token; otherwise the given
      // value is stored verbatim.
      const token = flags["generate"] || value === "" ? generateToken() : value;
      saveSettings({ hub: { token } });
      console.log("token saved");
      return;
    }
    fatal(`unknown config key ${JSON.stringify(key)} (settable: hub.bind, hub.token)`);
  }
  fatal(`unknown config subcommand ${JSON.stringify(sub)} (try: config get, config set hub.bind <value>, config set hub.token <value|--generate>)`);
}

// ---- state / pick / tmux-status / drain -------------------------------------------

async function runState(args: string[]): Promise<void> {
  const { flags } = parseFlags(args, ["json", "all"]);
  const { doc, raw } = await fetchState(hubURL(), 2000);
  if (flags["json"]) {
    process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
    return;
  }
  let sessions = flags["all"] ? doc.sessions : visible(doc.sessions);
  // Tag filters: --tag shows only sessions carrying it, --exclude-tag hides them.
  if (flags["tag"]) sessions = sessions.filter((s) => (s.tags ?? []).includes(flags["tag"]));
  if (flags["exclude-tag"]) sessions = sessions.filter((s) => !(s.tags ?? []).includes(flags["exclude-tag"]));
  if (sessions.length === 0) {
    const hidden = doc.sessions.length;
    console.log(hidden > 0 ? `no visible sessions (${hidden} hidden, use --all)` : "no active sessions");
    return;
  }
  console.log(printSessions(sessions, isTTY()));
}

function isTTY(): boolean {
  return !!process.stdout.isTTY;
}

async function runPick(): Promise<void> {
  const { doc } = await fetchState(hubURL(), 2000);
  // Hub order is engagement MRU - keep it, dropping only hidden rows.
  const sessions = visible(doc.sessions);
  if (sessions.length === 0) {
    console.log("no sessions");
    return;
  }
  const fzf = Bun.which("fzf");
  const key = fzf ? await pickFzf(sessions) : await pickNumbered(sessions);
  if (!key) return;
  await jump(hubURL(), key);
}

async function pickFzf(sessions: Event[]): Promise<string> {
  let input = "";
  for (const s of sessions) {
    // The key travels as a hidden first field; detail rides dimmed on the
    // same line - the two-line palette row flattened.
    input += `${s.session_key}\t${coloredGlyph(s)} ${statusWord(s.event).padEnd(9)} ${s.agent}  ${titleOf(s)}  ${age(s.ts)}`;
    if (s.prompt) input += `  ${dimOn}${cropRunes(s.prompt, 80)}${dimOff}`;
    input += "\n";
  }
  const proc = Bun.spawn(
    ["fzf", "--ansi", "--delimiter=\t", "--with-nth=2..", "--layout=reverse", "--height=100%", "--info=inline", "--prompt=jump> "],
    { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "inherit" }
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  // 130 = ESC/Ctrl-C, 1 = no match: both are cancels, not failures.
  if (code === 130 || code === 1) return "";
  if (code !== 0) throw new Error(`fzf exited ${code}`);
  return out.trim().split("\t")[0] ?? "";
}

async function pickNumbered(sessions: Event[]): Promise<string> {
  const tty = isTTY();
  sessions.forEach((s, i) => {
    const g = tty ? coloredGlyph(s) : glyph(s);
    console.log(
      `${String(i + 1).padStart(2)}. ${g} ${statusWord(s.event).padEnd(9)} ${s.agent.padEnd(9)} ${titleOf(s)} (${age(s.ts)})`
    );
    if (s.prompt) console.log(`      ${cropRunes(s.prompt, termWidth() - 8)}`);
  });
  process.stdout.write("jump to> ");
  const line = await readLine();
  const text = line.trim();
  if (!text) return "";
  const n = parseInt(text, 10);
  if (Number.isNaN(n) || n < 1 || n > sessions.length) throw new Error(`invalid selection ${JSON.stringify(text)}`);
  return sessions[n - 1].session_key;
}

async function readLine(): Promise<string> {
  for await (const line of console) return line;
  return "";
}

async function runTmuxStatus(): Promise<void> {
  // A status-line segment must never hang or error visibly; a dead hub just
  // renders as an empty segment.
  try {
    const { doc } = await fetchState(hubURL(), 200);
    process.stdout.write(tmuxStatusLine(doc.sessions));
  } catch {
    // empty segment
  }
}

async function runDrain(): Promise<void> {
  const c = new Client(hubURL(), stateDir());
  try {
    const n = await c.drain();
    console.log(`drained ${n} event(s)`);
  } catch (err) {
    console.log("drained 0 event(s)");
    console.error(`signalbox: drain stopped: ${err}`);
    process.exit(1);
  }
}

// ---- dispatch -------------------------------------------------------------------

function fatal(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  // A refused connection to the hub is the common new-user stumble - name
  // the actual fix instead of relaying the socket error.
  const code = (err as any)?.code ?? "";
  if (msg.includes("Unable to connect") || code === "ECONNREFUSED" || code === "ConnectionRefused") {
    console.error(`signalbox: the hub isn't running (${hubURL()})`);
    console.error("open the Signalbox app (it runs the hub), or run: signalbox hub");
    process.exit(1);
  }
  console.error(`signalbox: ${msg}`);
  process.exit(1);
}

// Commands group under nouns (session, tmux, hook) the gh/docker way. The
// old flat forms (ack, tmux-status, claude-hook, …) stay as hidden aliases so
// existing installs, tmux configs, and muscle memory keep working. normalize
// rewrites a "<noun> <verb>" invocation into the canonical flat command the
// switch below dispatches.
function normalize(rawCmd: string | undefined, rawArgs: string[]): { cmd: string | undefined; args: string[] } {
  const groups: Record<string, Record<string, string>> = {
    session: { ack: "ack", hide: "hide", show: "show", pin: "pin", unpin: "unpin", rename: "label", remove: "remove", list: "state", tag: "tag", untag: "untag" },
    tmux: { status: "tmux-status", "seen-pane": "seen-pane" },
    hook: { claude: "claude-hook", cursor: "cursor-hook", codex: "codex-hook" },
  };
  const group = rawCmd ? groups[rawCmd] : undefined;
  if (group) {
    const verb = rawArgs[0];
    const canonical = verb ? group[verb] : undefined;
    if (canonical) return { cmd: canonical, args: rawArgs.slice(1) };
    // Unknown subcommand under a known noun: report the valid verbs.
    console.error(`signalbox ${rawCmd}: unknown subcommand ${JSON.stringify(verb ?? "")} (try: ${Object.keys(group).join(", ")})`);
    process.exit(2);
  }
  return { cmd: rawCmd, args: rawArgs };
}

const { cmd, args } = normalize(process.argv[2], process.argv.slice(3));

switch (cmd) {
  case "fire":
    await runHookSafe(() => runFire(args));
    break;
  case "ack":
    await runHookSafe(() => runAck(args));
    break;
  case "hide":
    await runHookSafe(() => runHide(args));
    break;
  case "show":
    await runHookSafe(() => runShow(args));
    break;
  case "pin":
    await runHookSafe(() => runPin(args));
    break;
  case "unpin":
    await runHookSafe(() => runUnpin(args));
    break;
  case "label":
    await runHookSafe(() => runLabel(args));
    break;
  case "tag":
    await runHookSafe(() => runTag(args));
    break;
  case "untag":
    await runHookSafe(() => runUntag(args));
    break;
  case "seen-pane":
    await runHookSafe(() => runSeenPane(args));
    break;
  case "remove":
    await runHookSafe(() => runRemove(args));
    break;
  case "claude-hook":
    await runHookSafe(() => runClaudeHook());
    break;
  case "cursor-hook":
    await runHookSafe(() => runCursorHook());
    break;
  case "codex-hook":
    await runHookSafe(() => runCodexHook());
    break;
  case "hub":
    runHub(args);
    break;
  case "pair":
    await runPair(args).catch(fatal);
    break;
  case "config":
    runConfig(args);
    break;
  case "init":
  case "install": // aliases - init is the documented verb
  case "setup":
    await runSetup(args).catch(fatal);
    break;
  case "state":
    await runState(args).catch(fatal);
    break;
  case "jump":
    if (args.length !== 1) {
      console.error("usage: signalbox jump <session_key>");
      process.exit(2);
    }
    await jump(hubURL(), args[0]).catch(fatal);
    break;
  case "pick":
    await runPick().catch(fatal);
    break;
  case "tmux-status":
    await runTmuxStatus();
    break;
  case "drain":
    await runDrain();
    break;
  case "version":
  case "--version":
    console.log(version);
    break;
  case "help":
    process.stdout.write(usage());
    break;
  case "-h":
  case "--help":
    process.stdout.write(shortUsage());
    break;
  default:
    if (cmd) console.error(`signalbox: unknown command ${JSON.stringify(cmd)}\n`);
    process.stderr.write(shortUsage());
    process.exit(2);
}
