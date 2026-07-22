// Routes the user to a session's origin: a tmux pane or a URL. Portability
// rule: everything jump needs is data captured at fire time - never assume
// the local topology (socket paths, terminal app, client count).

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { newSeen, type Event } from "./event";
import { Client, fetchState, stateDir } from "./client";
import { socketPath, bellSuffix } from "./tmux";
import { cursorBundle } from "./cursor";

// iTerm2 gets a window-precise raise because its AppleScript exposes session
// ttys; other terminals get a generic app activation.
const iterm2Bundle = "com.googlecode.iterm2";

// command strips TMPDIR so a tmux invocation without -S still resolves the
// same default socket directory as terminal shells (GUI TMPDIR differs).
function command(name: string, args: string[], opts: SpawnSyncOptions = {}) {
  const env = { ...process.env };
  delete env.TMPDIR;
  return spawnSync(name, args, { ...opts, env });
}

function runCmd(name: string, ...args: string[]): string | null {
  const out = command(name, args);
  if (out.status !== 0) return null;
  return (out.stdout?.toString() ?? "").trim();
}

// tmuxBinary resolves tmux for GUI contexts whose PATH omits homebrew.
function tmuxBinary(): string {
  const which = spawnSync("which", ["tmux"]);
  if (which.status === 0) {
    const p = which.stdout.toString().trim();
    if (p) return p;
  }
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    if (existsSync(p)) return p;
  }
  return "tmux";
}

// checkOpenURL is the backstop for origin.url, which reaches hub state via
// the unauthenticated POST /events - a hostile local page could plant a row.
// Only web URLs may reach `open`: file:// and custom schemes execute things,
// and a leading dash would be parsed by open as a flag.
export function checkOpenURL(raw: string): string | null {
  if (raw.startsWith("-")) return `refusing to open origin url ${JSON.stringify(raw)}: looks like a flag`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch (err) {
    return `refusing to open origin url ${JSON.stringify(raw)}: ${err}`;
  }
  if (u.protocol === "http:" || u.protocol === "https:") return null;
  return `refusing to open origin url ${JSON.stringify(raw)}: only http/https schemes are allowed`;
}

// fireSeen auto-acks after a successful jump. Best-effort: an unreachable
// hub must not turn a jump that already landed into an error.
async function fireSeen(hubURL: string, key: string): Promise<void> {
  const c = new Client(hubURL, stateDir());
  try {
    await c.deliver(newSeen(key));
  } catch (err) {
    c.logf(`jump: auto-ack ${key}: ${err}`);
  }
}

// Locates the iTerm2 session on the target tty and raises exactly that window,
// activating iTerm only on a hit. A miss returns WITHOUT activating, so this
// doubles as a probe for "is the switched client hosted in iTerm?": were it to
// `activate` on a miss, it would flash iTerm to the front before we raise the
// terminal that actually holds the session - the jolt. The tty arrives as argv
// so no data is ever interpolated into the script body.
const iTermRaiseScript = `on run argv
	set targetTty to item 1 of argv
	tell application "iTerm2"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					if tty of s is targetTty then
						select t
						select s
						set index of w to 1
						activate
						return "raised"
					end if
				end repeat
			end repeat
		end repeat
	end tell
	return "not-found"
end run`;

// True only when an iTerm window actually owning this tty was raised - not when
// the script merely ran. The old `status === 0` check read a bare app-activate
// as a raise and so masked tty misses.
function raiseITermWindow(tty: string): boolean {
  const out = command("osascript", ["-", tty], { input: iTermRaiseScript });
  return out.status === 0 && out.stdout.toString().trim() === "raised";
}

// isRunning reports whether an app with this bundle id is already running,
// without launching it. `open -b`/`open -a` on a terminal that is not running
// launches it, and a freshly launched terminal opens an unrelated empty window
// that never holds the attached session - the open-then-vanish jolt. lsappinfo
// needs no automation permission and prints nothing when the app is not up.
function isRunning(bundle: string): boolean {
  const out = command("lsappinfo", ["find", `bundleid=${bundle}`]);
  if (out.status !== 0) return false;
  return (out.stdout?.toString().trim() ?? "") !== "";
}

// VS Code-family editors (Cursor, VS Code, other Electron forks) have no
// AppleScript dictionary, so window focus goes through Accessibility: find the
// editor window whose title contains the project folder and AXRaise it. The
// process is matched by bundle identifier, not name - process names differ per
// fork ("Cursor", "Code", "Electron") while the bundle id is stable. This is
// WINDOW-level, not tab-level - the editors' terminal/editor tabs expose
// nothing addressable externally, so a specific tab cannot be targeted
// (documented limitation, not a bug). The needle and bundle id arrive as argv,
// so no data is ever interpolated into the script body.
const editorRaiseScript = `on run argv
	set needle to item 1 of argv
	set bundleId to item 2 of argv
	tell application "System Events"
		repeat with p in (every process whose bundle identifier is bundleId)
			repeat with w in windows of p
				if (name of w) contains needle then
					perform action "AXRaise" of w
					set frontmost of p to true
					return "raised"
				end if
			end repeat
		end repeat
	end tell
	return "no-match"
end run`;

// raiseEditor brings the editor forward (app-level, always) and best-effort
// raises the window matching the workspace folder (window-level). App
// activation is the floor: a title miss, a locked screen-recording permission,
// or several windows on the same folder must still land the user in the editor.
function raiseEditor(bundle: string, workspace: string): boolean {
  const app = runCmd("open", "-b", bundle) !== null;
  const folder = workspace ? workspace.split("/").filter(Boolean).pop() ?? "" : "";
  if (folder) command("osascript", ["-", folder, bundle], { input: editorRaiseScript });
  return app;
}

// activateTerminal raises the terminal that actually hosts the client we just
// switched, located by that client's tty - NOT origin.terminal, the terminal
// where the pane was first seen. One tmux server is routinely shared across
// terminals (the same session attached in iTerm while agents also run in VS
// Code's or Cursor's integrated terminal), so the recorded terminal is often
// not where the client is attached now. Switching one client but raising a
// different terminal is the jolt: the wrong app flashes forward while the
// session sits in the window behind it, so the jump looks like it opens then
// closes.
function activateTerminal(bundle: string | undefined, clientTTY: string): void {
  // iTerm can find any window by tty, so probe it first regardless of the
  // recorded terminal - but only when it is already running, since the probe's
  // `tell application "iTerm2"` would otherwise launch it and open a window.
  if (clientTTY && isRunning(iterm2Bundle) && raiseITermWindow(clientTTY)) return;
  // The client is not in iTerm (or its tty is unknown): raise the recorded
  // terminal, but never launch one - a fresh window would not hold the session.
  if (bundle && bundle !== iterm2Bundle) {
    if (isRunning(bundle)) runCmd("open", "-b", bundle);
    return;
  }
  // iTerm origin whose tty we could not match: bring iTerm forward only if it
  // is already up, so we never spawn a throwaway window.
  if (isRunning(iterm2Bundle)) runCmd("open", "-a", "iTerm");
}

// mostActiveClientTTY: the terminal the user is actually typing in. "|||"
// not tab: tmux mangles control characters under GUI/no-locale environments.
function mostActiveClientTTY(socket: string): string | null {
  let args = ["list-clients", "-F", "#{client_activity}|||#{client_tty}"];
  if (socket) args = ["-S", socket, ...args];
  const out = command(tmuxBinary(), args);
  if (out.status !== 0) return null;
  let bestTTY = "";
  let bestActivity = -1;
  for (const line of out.stdout.toString().split("\n")) {
    const idx = line.trim().indexOf("|||");
    if (idx < 0) continue;
    const activity = parseInt(line.trim().slice(0, idx), 10);
    const tty = line.trim().slice(idx + 3);
    if (!tty || Number.isNaN(activity)) continue;
    if (activity > bestActivity) {
      bestActivity = activity;
      bestTTY = tty;
    }
  }
  return bestTTY || null;
}

// currentClientTTY asks a server which client the last command acted on.
// Best-effort: empty on failure, the raise degrades to app activation.
function currentClientTTY(socket: string): string {
  let args = ["display-message", "-p", "#{client_tty}"];
  if (socket) args = ["-S", socket, ...args];
  const out = command(tmuxBinary(), args);
  if (out.status !== 0) return "";
  return out.stdout.toString().trim();
}

// jumpTo routes to an already-resolved session. hubURL is needed for the
// auto-ack. Throws with a user-facing message on failure.
export async function jumpTo(hubURL: string, e: Event): Promise<void> {
  if (!e.origin) throw new Error(`session ${JSON.stringify(e.session_key)} has no origin to jump to`);
  if (e.origin.url) {
    const bad = checkOpenURL(e.origin.url);
    if (bad) throw new Error(bad);
    if (runCmd("open", e.origin.url) === null) throw new Error(`open ${e.origin.url} failed`);
    await fireSeen(hubURL, e.session_key);
    return;
  }
  if (e.origin.cursor) {
    // An editor session (Cursor's own agent, or a terminal agent inside VS
    // Code / Cursor): raise the app, then the workspace window. cwd is the
    // workspace path (stripped on redacted hosts, where the raise degrades to
    // app-level). The bundle id is captured on the origin, defaulted to Cursor
    // for old events that predate it.
    const bundle = e.origin.cursor.bundle || cursorBundle;
    if (!raiseEditor(bundle, e.cwd ?? "")) throw new Error(`could not raise editor (${bundle})`);
    await fireSeen(hubURL, e.session_key);
    return;
  }
  const t = e.origin.tmux;
  if (!t) throw new Error(`session ${JSON.stringify(e.session_key)} has an empty origin`);

  // Address the server socket explicitly wherever one is known: GUI
  // processes have no $TMUX, a different TMPDIR, and the server may run on a
  // named socket - the default lookup fails on all three counts.
  const socket = t.socket || socketPath();
  const tmuxCmd = (...args: string[]): boolean => {
    const full = socket ? ["-S", socket, ...args] : args;
    return command(tmuxBinary(), full).status === 0;
  };

  // Target the pane id, not the session name: our own bell suffix renames
  // sessions, so names are unstable. Fall back to exact session:window
  // ("=" pins exact matching; the live name may carry the bell suffix).
  const targets: string[] = [];
  if (t.pane) targets.push(t.pane);
  targets.push(`=${t.session}:${t.window}`, `=${t.session}${bellSuffix}:${t.window}`);

  // Outside tmux there is no "current client"; same when jumping to a
  // different server - pick the most-recently-active client explicitly.
  let clientArgs: string[] = [];
  let clientTTY = "";
  const ownSocket = socketPath();
  if (!ownSocket || (socket && socket !== ownSocket)) {
    const tty = mostActiveClientTTY(socket);
    if (!tty) throw new Error("no attached tmux clients to switch");
    clientTTY = tty;
    clientArgs = ["-c", tty];
  }

  for (const target of targets) {
    if (!tmuxCmd("switch-client", ...clientArgs, "-t", target)) continue;
    // Best-effort: the switch already landed in the right session.
    tmuxCmd("select-window", "-t", target);
    tmuxCmd("select-pane", "-t", target);
    // The switch succeeded, so ack now - a failed terminal raise must not
    // leave the session flagged after the user was routed to it.
    await fireSeen(hubURL, e.session_key);
    if (!clientTTY) {
      // Same-server jump from inside tmux: ask the server which tty the
      // switched client is so the raise can find the right window.
      clientTTY = currentClientTTY(ownSocket);
    }
    activateTerminal(t.terminal, clientTTY);
    return;
  }
  throw new Error(`could not switch to any target for ${e.session_key}`);
}

// jump resolves key against the hub's /state and routes to its origin.
export async function jump(hubURL: string, key: string): Promise<void> {
  const { doc } = await fetchState(hubURL, 2000);
  const session = doc.sessions.find((s) => s.session_key === key);
  if (!session) throw new Error(`session ${JSON.stringify(key)} not found in hub state`);
  await jumpTo(hubURL, session);
}
