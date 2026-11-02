import { spawnSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { basename } from "node:path";
import { agentFamily, type Event } from "./event";

/** Process fields needed to prove that the captured agent owns the foreground pane. */
export interface ChatProcess {
  /** Operating-system process ID. */
  pid: number;
  /** Parent process ID. */
  parent: number;
  /** Process group ID. */
  group: number;
  /** Terminal foreground process group ID. */
  foreground: number;
  /** Executable basename. */
  name: string;
}

/** Prove ancestry and foreground ownership; a shared background daemon is not a pane binding. */
export function ownsChatPane(processes: ChatProcess[], panePID: number, capturedPID: number, name: string): boolean {
  const byPID = new Map(processes.map(p => [p.pid, p]));
  const agent = byPID.get(capturedPID);
  if (!agent || agent.name !== name || agent.group <= 0 || agent.group !== agent.foreground) return false;
  const visited = new Set<number>();
  let current: ChatProcess | undefined = agent;
  while (current && !visited.has(current.pid)) {
    if (current.pid === panePID) return true;
    visited.add(current.pid);
    current = byPID.get(current.parent);
  }
  return false;
}

function tmuxBinary(): string {
  const found = spawnSync("which", ["tmux"], { encoding: "utf8" });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  return ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find(existsSync) ?? "tmux";
}

const chatSessionOption = "@signalbox_chat_session";

function paneConnection(session: Event) {
  const target = session.origin?.tmux;
  const family = agentFamily(session.agent);
  if (!target?.socket || !/^%\d+$/.test(target.pane) || session.proc?.name !== family) return null;
  const binary = tmuxBinary();
  const run = (args: string[], input?: string) => spawnSync(binary, ["-S", target.socket!, ...args], {
    input, encoding: "utf8", timeout: 2000,
  });
  const binding = `${session.session_key}@${session.proc.pid}`;
  const verify = (requireBinding: boolean): string | null => {
    const pane = run(["display-message", "-p", "-t", target.pane,
      `#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_in_mode}\t#{${chatSessionOption}}`]);
    if (pane.status !== 0) return "The tmux pane is no longer available.";
    const [id, pid, dead, mode, bound] = pane.stdout.trim().split("\t");
    if (id !== target.pane || dead !== "0" || mode !== "0") return "Leave tmux copy mode and reconnect the agent before sending.";
    if (requireBinding && bound !== binding) {
      return bound
        ? "This tmux pane is linked to a different conversation. Open this session in its terminal and send a message first."
        : "Send one message in this session's terminal to connect it, then try again.";
    }
    const ps = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,comm="], { encoding: "utf8", timeout: 2000 });
    if (ps.status !== 0) return "Could not verify the agent process.";
    const processes = ps.stdout.split("\n").flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+)$/);
      return match ? [{ pid: +match[1], parent: +match[2], group: +match[3], foreground: +match[4], name: basename(match[5]) }] : [];
    });
    if (!ownsChatPane(processes, Number(pid), session.proc!.pid, session.proc!.name!)) {
      return family === "codex"
        ? "Cannot verify this session's tmux connection. Launch Codex inside tmux with --no-daemon."
        : "Cannot verify this session's tmux connection. Resume Claude inside tmux.";
    }
    return null;
  };
  return { run, verify, binding, pane: target.pane };
}

/** Only interactive CLI transcripts may bind Codex input; internal title threads share its process. */
export function isInteractiveCodexTranscript(path: string, sessionID: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(64 * 1024);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const meta = JSON.parse(bytes.subarray(0, count).toString("utf8").split("\n")[0]);
    return meta.type === "session_meta" && meta.payload?.id === sessionID &&
      meta.payload?.source === "cli" && meta.payload?.originator === "codex-tui";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Bind a root conversation on its start or submitted prompt, using the final wire key after redaction. */
export function bindTmuxChat(session: Event, transcript = "", nativeID = ""): void {
  const family = agentFamily(session.agent);
  if (session.parent_session_key || !["claude", "codex"].includes(family)) return;
  if (family === "codex" && !isInteractiveCodexTranscript(transcript, nativeID)) return;
  const connection = paneConnection(session);
  if (!connection || connection.verify(false)) return;
  connection.run(["set-option", "-p", "-t", connection.pane, chatSessionOption, connection.binding]);
}

/** Conservatively recognize an empty input at the live cursor, never a historical prompt above it. */
export function emptyChatInput(agent: string, screen: string, x: number, y: number): boolean {
  const lines = screen.split("\n");
  if (x !== 2 || !Number.isInteger(y) || y < 0 || y >= lines.length) return false;
  if (agentFamily(agent) === "claude") {
    return /^❯\s*$/.test(lines[y]) && /^─{3}/.test(lines[y + 1] ?? "");
  }
  return /^›(?:\s*| Ask Codex to do anything\s*)$/.test(lines[y]) && !lines[y + 1]?.trim();
}

/** A delivery result says what reached the terminal, not whether the model accepted the prompt. */
export interface TmuxChatOutcome {
  /** Sent, definitely refused before paste, or uncertain after paste. */
  status: "sent" | "failed" | "unknown";
  /** Human-readable delivery feedback. */
  message: string;
}

/** Paste literal text into a verified, idle agent pane without activating any window. */
export async function sendTmuxChat(session: Event, text: string): Promise<TmuxChatOutcome> {
  const fail = (message: string): TmuxChatOutcome => ({ status: "failed", message });
  if (!["claude", "codex"].includes(agentFamily(session.agent))) return fail("Chat supports Claude Code and Codex.");
  if (session.parent_session_key) return fail("Open the owning session to chat with this agent.");
  if (session.reason === "exited" || session.reason === "session_end") return fail("This agent is no longer running.");
  if (session.event === "busy") return fail("Wait for this task to finish before sending.");
  if (session.event === "attention") return fail("Answer the pending question or permission request in the terminal first.");
  const connection = paneConnection(session);
  if (!connection) {
    return fail("Run this session inside tmux to send messages from Signalbox.");
  }
  const { run, pane } = connection;
  const verify = () => connection.verify(true);
  const invalid = verify();
  if (invalid) return fail(invalid);
  const buffer = "signalbox-chat-" + crypto.randomUUID();
  try {
    if (run(["load-buffer", "-b", buffer, "-"], text).status !== 0) return fail("Could not prepare the message for tmux.");
    const changed = verify();
    if (changed) return fail(changed);
    const screen = run(["capture-pane", "-p", "-t", pane]);
    const cursor = run(["display-message", "-p", "-t", pane, "#{cursor_x},#{cursor_y}"]);
    const [x, y] = cursor.stdout.trim().split(",").map(Number);
    if (screen.status !== 0 || cursor.status !== 0 || !emptyChatInput(session.agent, screen.stdout, x, y)) {
      return fail("Clear the terminal's draft and leave the agent at its empty message prompt before sending.");
    }
    if (run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane]).status !== 0) {
      return { status: "unknown", message: "Paste was not confirmed. Check the terminal before sending again." };
    }
    // Give the terminal UI time to consume the bracketed paste before Enter.
    await Bun.sleep(100);
    if (verify() || run(["send-keys", "-t", pane, "Enter"]).status !== 0) {
      return { status: "unknown", message: "Text may be pasted but not submitted. Check the terminal before sending again." };
    }
    return { status: "sent", message: "Sent to terminal" };
  } finally {
    run(["delete-buffer", "-b", buffer]);
  }
}
