import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { Busy, Done, Version, cropReply, machineID, shortHostname, type Event } from "./event";
import { discoverCodexTranscripts, readCompleteWindow, type TranscriptFile } from "./transcripts";

/** A relationship obtained from an agent's explicit identity records. */
export interface SessionParent {
  /** Identity of the actual child thread, not its inherited family session ID. */
  sessionKey: string;
  /** Identity of its direct spawning thread. */
  parentKey: string;
  /** Human-readable native worker name, when provided. */
  title?: string;
  /** Working directory recorded by the agent. */
  cwd?: string;
  /** First record belonging to this worker after copied ancestor history. */
  historyStart?: number;
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Decode only native spawn metadata; history forks and malformed headers do not create edges. */
export function codexParent(record: any, expectedId: string): SessionParent | undefined {
  const meta = record?.type === "session_meta" ? record.payload : undefined;
  const spawn = meta?.source?.subagent?.thread_spawn;
  if (!uuid.test(expectedId) || meta?.id !== expectedId || !uuid.test(spawn?.parent_thread_id ?? "") ||
      spawn.parent_thread_id === expectedId) return;
  return {
    sessionKey: `codex:${expectedId}`,
    parentKey: `codex:${spawn.parent_thread_id}`,
    title: typeof meta.agent_nickname === "string" ? meta.agent_nickname : undefined,
    cwd: typeof meta.cwd === "string" ? meta.cwd : undefined,
    historyStart: Number.isSafeInteger(meta.subagent_history_start_ordinal) && meta.subagent_history_start_ordinal >= 0
      ? meta.subagent_history_start_ordinal : undefined,
  };
}

/** Read the first header only; copied ancestor metadata must never replace the child identity. */
export function readCodexParent(path: string, expectedId: string): SessionParent | undefined {
  return codexParent(readHeader(path), expectedId);
}

function readHeader(path: string): any | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(1 << 20);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, length).indexOf(10);
    if (end < 0) return;
    return JSON.parse(buffer.subarray(0, end).toString("utf8"));
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface Cursor {
  offset: number;
  ordinal: number;
  parent?: SessionParent;
  headerRead: boolean;
  copiedHistoryKnown: boolean;
  baselineOffset?: number;
}

// A hub may start while Codex is still copying a parent's history. Counting
// existing records keeps the clone boundary exact without replaying any turns.
function baselineOrdinal(path: string, end: number): number {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0, count = 0, nonempty = false;
    while (offset < end) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (!length) break;
      for (const byte of buffer.subarray(0, length)) {
        if (byte === 10) { if (nonempty) count++; nonempty = false; }
        else nonempty = true;
      }
      offset += length;
    }
    return count;
  } finally { closeSync(fd); }
}

/** Observe new native Codex activity even when the runtime omits hooks for in-process workers. */
export class CodexTreeWatcher {
  private cursors = new Map<string, Cursor>();
  private running = false;
  private nextFile = 0;

  constructor(
    private emit: (event: Event) => Promise<void>,
    private discover: () => TranscriptFile[] = discoverCodexTranscripts,
    private stateDirectory?: string,
  ) {}

  /** Existing bytes form a baseline, never historical board activity. */
  baseline(): void {
    for (const file of this.discover().filter(f => f.agent === "codex")) {
      try {
        const offset = statSync(file.path).size;
        this.cursors.set(file.path, { offset, baselineOffset: offset, ordinal: 0, headerRead: false, copiedHistoryKnown: false });
      } catch { /* A concurrently removed transcript is not an event. */ }
    }
  }

  /** Process appended records in bounded windows; incomplete writes are retried on the next tick. */
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const files = this.discover().filter(f => f.agent === "codex");
      const started = performance.now();
      for (let visited = 0; visited < files.length; visited++) {
        if (performance.now() - started > 30) break;
        const file = files[this.nextFile++ % files.length];
        let size: number;
        try { size = statSync(file.path).size; } catch { continue; }
        let cursor = this.cursors.get(file.path);
        if (!cursor) {
          cursor = { offset: 0, ordinal: 0, headerRead: false, copiedHistoryKnown: false };
          this.cursors.set(file.path, cursor);
        }
        // A rewritten/truncated history is not new agent activity.
        if (size < cursor.offset) { cursor.offset = size; continue; }
        if (size === cursor.offset) continue;
        if (!cursor.headerRead) {
          const header = readHeader(file.path);
          if (!header) continue;
          cursor.parent = codexParent(header, file.sessionUuid);
          cursor.headerRead = true;
        }
        if (!cursor.parent) { cursor.offset = size; continue; }
        if (cursor.baselineOffset !== undefined) {
          cursor.ordinal = baselineOrdinal(file.path, cursor.baselineOffset);
          cursor.baselineOffset = undefined;
        }
        const window = readCompleteWindow(file.path, cursor.offset);
        let nextOrdinal = cursor.ordinal;
        for (const line of window.lines) {
          if (!line) continue;
          const ordinal = nextOrdinal++;
          let record: any;
          try { record = JSON.parse(line); } catch { continue; }
          const parent = cursor.parent;
          // Without an explicit clone boundary, a new fork's copied turns are ambiguous.
          if (!cursor.copiedHistoryKnown && (parent.historyStart === undefined || ordinal < parent.historyStart)) continue;
          if (record.type !== "event_msg" || typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) continue;
          const payload = record.payload;
          if (typeof payload?.turn_id !== "string" || !payload.turn_id) continue;
          let eventType: string;
          if (payload?.type === "task_started") eventType = Busy;
          else if (payload?.type === "task_complete" || payload?.type === "turn_aborted") eventType = Done;
          else continue;
          const reply = cropReply(typeof payload.last_agent_message === "string" ? payload.last_agent_message : "");
          await this.emit({
            v: Version, id: createHash("sha256").update(`${parent.sessionKey}:${payload.turn_id}:${payload.type}`).digest("hex"), ts: record.timestamp,
            host: shortHostname(), machine: machineID(this.stateDirectory), agent: "codex",
            event: eventType, reason: eventType === Busy ? "session_start" : payload.type === "turn_aborted" ? "interrupted" : "stop",
            session_key: parent.sessionKey, parent_session_key: parent.parentKey, parent_relation: "spawned",
            title: parent.title || "Codex worker", cwd: parent.cwd, transcript: file.path,
            ...(reply.text ? { reply: reply.text, cropped: reply.cropped } : {}),
          });
        }
        cursor.offset = window.endOffset;
        cursor.ordinal = nextOrdinal;
        cursor.copiedHistoryKnown = cursor.copiedHistoryKnown || (cursor.parent.historyStart !== undefined && cursor.ordinal >= cursor.parent.historyStart);
      }
    } finally { this.running = false; }
  }
}
