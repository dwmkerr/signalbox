import { closeSync, openSync, readSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { contentText, stripHarness } from "./claude";

export type TranscriptAgent = "claude" | "codex" | "cursor";
export type TurnRole = "user" | "assistant";

export interface TranscriptFile {
  path: string;
  agent: TranscriptAgent;
  sessionUuid: string;
  cwd?: string;
}

export interface Turn {
  role: TurnRole;
  text: string;
  ts?: string;
}

export interface ParsedTurns {
  turns: Turn[];
  endOffset: number;
  cwd?: string;
  sessionUuid?: string;
}

// One batch must fit inside the hub's 10 ms sweep slice at the measured parser
// throughput, even when the transcript itself is tens of megabytes.
export const TRANSCRIPT_WINDOW_BYTES = 1 << 20;

// FTS growth must stay bounded when a transcript contains an accidental large
// paste, while retaining enough context for useful code and prose matches.
export const TURN_TEXT_MAX_BYTES = 64 << 10;

const claudeRootEnv = "SIGNALBOX_CLAUDE_TRANSCRIPTS_DIR";
const codexRootEnv = "SIGNALBOX_CODEX_TRANSCRIPTS_DIR";
const cursorRootEnv = "SIGNALBOX_CURSOR_TRANSCRIPTS_DIR";
const claudeDiscoveryMaxDepth = 8;
const uuidName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function transcriptRoot(envName: string, fallback: string): string {
  return process.env[envName] || fallback;
}

function uuid(value: string): string | undefined {
  return uuidName.test(value) ? value : undefined;
}

function discoverClaudeDirectory(
  directory: string,
  depth: number,
  parentSessionUuid: string | undefined,
  files: TranscriptFile[],
): void {
  for (const entry of entries(directory)) {
    const path = join(directory, entry.name);
    if (entry.isFile()) {
      if (!entry.name.endsWith(".jsonl")) continue;
      const filenameUuid = depth === 0
        ? uuid(entry.name.slice(0, -".jsonl".length))
        : undefined;
      const sessionUuid = parentSessionUuid ?? filenameUuid;
      if (sessionUuid) files.push({ path, agent: "claude", sessionUuid });
      continue;
    }
    if (!entry.isDirectory() || depth >= claudeDiscoveryMaxDepth) continue;
    discoverClaudeDirectory(path, depth + 1, uuid(entry.name) ?? parentSessionUuid, files);
  }
}

function discoverClaude(root: string): TranscriptFile[] {
  const files: TranscriptFile[] = [];
  for (const project of entries(root)) {
    if (!project.isDirectory()) continue;
    discoverClaudeDirectory(join(root, project.name), 0, undefined, files);
  }
  return files;
}

const codexFilename = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function discoverCodex(root: string): TranscriptFile[] {
  const files: TranscriptFile[] = [];
  for (const year of entries(root)) {
    if (!year.isDirectory()) continue;
    const yearDir = join(root, year.name);
    for (const month of entries(yearDir)) {
      if (!month.isDirectory()) continue;
      const monthDir = join(yearDir, month.name);
      for (const day of entries(monthDir)) {
        if (!day.isDirectory()) continue;
        const dayDir = join(monthDir, day.name);
        for (const entry of entries(dayDir)) {
          if (!entry.isFile()) continue;
          const match = entry.name.match(codexFilename);
          if (!match) continue;
          files.push({ path: join(dayDir, entry.name), agent: "codex", sessionUuid: match[1] });
        }
      }
    }
  }
  return files;
}

function discoverCursor(root: string): TranscriptFile[] {
  const files: TranscriptFile[] = [];
  for (const project of entries(root)) {
    if (!project.isDirectory()) continue;
    const transcriptsDir = join(root, project.name, "agent-transcripts");
    for (const session of entries(transcriptsDir)) {
      if (!session.isDirectory()) continue;
      const filename = `${session.name}.jsonl`;
      const transcript = entries(join(transcriptsDir, session.name))
        .find((entry) => entry.isFile() && entry.name === filename);
      if (!transcript) continue;
      files.push({
        path: join(transcriptsDir, session.name, filename),
        agent: "cursor",
        sessionUuid: session.name,
      });
    }
  }
  return files;
}

export function discoverTranscripts(): TranscriptFile[] {
  const home = homedir();
  const files = [
    ...discoverClaude(transcriptRoot(claudeRootEnv, join(home, ".claude", "projects"))),
    ...discoverCodex(transcriptRoot(codexRootEnv, join(home, ".codex", "sessions"))),
    ...discoverCursor(transcriptRoot(cursorRootEnv, join(home, ".cursor", "projects"))),
  ];
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

interface CompleteWindow {
  lines: string[];
  endOffset: number;
}

function readCompleteWindow(path: string, fromOffset: number): CompleteWindow {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    let startsAtLineBoundary = fromOffset === 0;
    if (!startsAtLineBoundary) {
      const precedingByte = Buffer.allocUnsafe(1);
      startsAtLineBoundary = readSync(fd, precedingByte, 0, 1, fromOffset - 1) === 1
        && precedingByte[0] === 0x0a;
    }
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_WINDOW_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, fromOffset);
    const window = buffer.subarray(0, bytesRead);
    const firstNewline = window.indexOf(0x0a);
    if (firstNewline < 0) {
      return {
        lines: [],
        endOffset: bytesRead === buffer.length ? fromOffset + bytesRead : fromOffset,
      };
    }
    const completeEnd = window.lastIndexOf(0x0a);
    const completeStart = startsAtLineBoundary ? 0 : firstNewline + 1;
    return {
      lines: completeStart <= completeEnd
        ? window.subarray(completeStart, completeEnd + 1).toString("utf8").split("\n")
        : [],
      endOffset: fromOffset + completeEnd + 1,
    };
  } catch {
    return { lines: [], endOffset: fromOffset };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A close failure must not turn transcript parsing into a hub failure.
      }
    }
  }
}

function json(line: string): any | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

function cappedText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= TURN_TEXT_MAX_BYTES) return text;
  let end = TURN_TEXT_MAX_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function timestamp(entry: any): string | undefined {
  return nonEmptyString(entry?.timestamp);
}

function addTurn(turns: Turn[], role: TurnRole, text: string, ts?: string): void {
  if (!text) return;
  const turn: Turn = { role, text: cappedText(text) };
  if (ts) turn.ts = ts;
  turns.push(turn);
}

function filenameSessionUuid(path: string): string | undefined {
  const name = basename(path);
  return name.endsWith(".jsonl") ? nonEmptyString(name.slice(0, -".jsonl".length)) : undefined;
}

function claudeSessionUuid(path: string): string | undefined {
  const filenameUuid = filenameSessionUuid(path);
  if (filenameUuid && uuid(filenameUuid)) return filenameUuid;
  let directory = dirname(path);
  for (let depth = 0; depth <= claudeDiscoveryMaxDepth; depth++) {
    const sessionUuid = uuid(basename(directory));
    if (sessionUuid) return sessionUuid;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function codexSessionUuid(path: string): string | undefined {
  return basename(path).match(codexFilename)?.[1];
}

function parseClaude(path: string, window: CompleteWindow): ParsedTurns {
  const result: ParsedTurns = {
    turns: [],
    endOffset: window.endOffset,
    sessionUuid: claudeSessionUuid(path),
  };
  for (const line of window.lines) {
    const entry = json(line);
    if (!entry) continue;
    if (!result.cwd) result.cwd = nonEmptyString(entry.cwd);
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.message?.role !== undefined && entry.message.role !== entry.type) continue;
    const text = stripHarness(contentText(entry.message?.content));
    addTurn(result.turns, entry.type, text, timestamp(entry));
  }
  return result;
}

function parseCodex(path: string, window: CompleteWindow): ParsedTurns {
  const result: ParsedTurns = {
    turns: [],
    endOffset: window.endOffset,
    sessionUuid: codexSessionUuid(path),
  };
  for (const line of window.lines) {
    const entry = json(line);
    if (!entry) continue;
    if (entry.type === "session_meta") {
      result.cwd = nonEmptyString(entry.payload?.cwd) ?? result.cwd;
      result.sessionUuid = nonEmptyString(entry.payload?.session_id) ?? result.sessionUuid;
      continue;
    }
    if (entry.type !== "event_msg") continue;
    const payloadType = entry.payload?.type;
    if (payloadType !== "user_message" && payloadType !== "agent_message") continue;
    const text = nonEmptyString(entry.payload?.message) ?? "";
    addTurn(result.turns, payloadType === "user_message" ? "user" : "assistant", text, timestamp(entry));
  }
  return result;
}

function parseCursor(path: string, window: CompleteWindow): ParsedTurns {
  const result: ParsedTurns = {
    turns: [],
    endOffset: window.endOffset,
    sessionUuid: filenameSessionUuid(path),
  };
  for (const line of window.lines) {
    const entry = json(line);
    if (!entry) continue;
    if (!result.cwd) result.cwd = nonEmptyString(entry.cwd);
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const text = contentText(entry.message?.content);
    addTurn(result.turns, entry.role, text, timestamp(entry));
  }
  return result;
}

export function parseTurns(path: string, agent: TranscriptAgent, fromOffset: number): ParsedTurns {
  const window = readCompleteWindow(path, fromOffset);
  switch (agent) {
    case "claude":
      return parseClaude(path, window);
    case "codex":
      return parseCodex(path, window);
    case "cursor":
      return parseCursor(path, window);
  }
}
