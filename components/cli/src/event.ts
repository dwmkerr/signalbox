// The signalbox wire schema (contract v1, specs/events.md) and helpers for
// building user events. Wire format is identical to the original Go
// implementation - the Swift app, adapters, and persisted logs must not
// notice the runtime change.

import { hostname } from "node:os";

// Event types, ordered as they rank for display urgency. Seen, Hide, Show,
// Pin, Unpin and Label are user actions, not agent lifecycle - none touches
// recency (pin/unpin move the display partition, never engaged_ts).
export const Attention = "attention";
export const Error = "error";
export const Done = "done";
export const Busy = "busy";
export const Ended = "ended";
export const Seen = "seen";
export const Hide = "hide";
export const Show = "show";
export const Pin = "pin";
export const Unpin = "unpin";
export const Label = "label";
export const Tag = "tag";
export const Untag = "untag";

export const Version = 1;

// Crop bounds. The privacy line is "signals and a two-line breadcrumb of the
// exchange, never transcripts" - crops happen at the emitter, the full text
// never leaves the machine that produced it.
export const PromptMax = 160;
export const ReplyMax = 280;
export const LabelMax = 80;

export interface TmuxOrigin {
  session: string;
  window: number;
  pane: string;
  socket?: string;
  terminal?: string;
}

// An editor-window jump target. The kind is named "cursor" for the app it was
// built for, but it covers every VS Code-family editor (Cursor, VS Code, other
// Electron forks) - the origin carries only the app's bundle id, and jump
// raises the window by app plus a best-effort title match on the event's cwd
// (workspace path). Kept as "cursor" because renaming the kind would break
// events already on disk. Deliberately holds no path itself so redact has
// nothing to strip: the workspace comes from e.cwd, which redact already
// removes.
export interface CursorOrigin {
  bundle?: string;
}

// A jump target. `kind` discriminates the union so new origin kinds (ssh,
// editor windows, a remote host) can be added without guessing from which
// field is set. Optional on read for old events, where it is inferred.
export type OriginKind = "tmux" | "url" | "cursor";
export interface Origin {
  kind?: OriginKind;
  tmux?: TmuxOrigin;
  url?: string;
  cursor?: CursorOrigin;
}

// Process behind the session, captured at fire time for the liveness sweep.
export interface Proc {
  pid: number;
  name?: string;
}

export interface Event {
  v: number;
  id: string;
  ts: string; // RFC3339 UTC, second precision (matches the Go emitter)
  host: string;
  agent: string;
  event: string;
  reason?: string;
  session_key: string;
  cwd?: string;
  title?: string;
  // The human/trigger side of the exchange breadcrumb (your last prompt, a
  // CI trigger line, ...). Was `detail` before v0.2; readers still accept
  // `detail` for old events.
  prompt?: string;
  // The agent/result side (the agent's last message).
  reply?: string;
  // signalbox's own display name, set by the user ("label" events only);
  // beats title on every surface, carried by the reducer.
  label?: string;
  // Discreet, free-form tags on a session (e.g. "work"). Carried across agent
  // events; added/removed by tag/untag events. Filterable in `state`.
  tags?: string[];
  origin?: Origin;
  proc?: Proc;
  // Diagnostic only: the untouched adapter payload, attached when SIGNALBOX_RAW
  // is set so the raw hook JSON can be inspected from the hub's event log.
  // Never set in normal operation; stripped by redact.
  raw?: string;
  // Assigned by the hub on ingest.
  seq?: number;
  // Reducer-derived state-model metadata; a fired event never carries these.
  acked?: boolean;
  hidden?: boolean;
  // The user pinned this session to the top partition. Unlike acked/hidden it
  // outlives agent activity: only unpin or hide clears it (specs/events.md).
  pinned?: boolean;
  engaged_ts?: string;
}

export interface StateDoc {
  sessions: Event[];
}

function cropLine(s: string, max: number): string {
  // Collapse all whitespace runs (newlines included) so multi-line text
  // becomes one readable breadcrumb; crop by code points, not bytes.
  const collapsed = s.split(/\s+/).filter(Boolean).join(" ");
  const points = Array.from(collapsed);
  return points.length > max ? points.slice(0, max).join("") : collapsed;
}

export function cropPrompt(s: string): string {
  return cropLine(s, PromptMax);
}

export function cropReply(s: string): string {
  return cropLine(s, ReplyMax);
}

export function cropLabel(s: string): string {
  return cropLine(s, LabelMax);
}

export function validType(t: string): boolean {
  return [Attention, Error, Done, Busy, Ended, Seen, Hide, Show, Pin, Unpin, Label, Tag, Untag].includes(t);
}

export function shortHostname(): string {
  return hostname().split(".")[0] ?? "";
}

// agentFamily is the base agent that anchors session identity, stripping any
// editor-host display prefix: "vscode/claude" and "cursor/claude" both key on
// "claude", so one session keeps a single identity whether it runs in a plain
// terminal or an editor. session_key is built from the family; only the display
// `agent` field carries the host prefix (specs/events.md).
export function agentFamily(agent: string): string {
  const slash = agent.indexOf("/");
  return slash > 0 ? agent.slice(slash + 1) : agent;
}

// nowTS matches the Go emitter's time.Now().UTC().Truncate(time.Second):
// RFC3339, UTC, no fractional seconds.
export function nowTS(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// newUserEvent builds a non-agent lifecycle event. The key passes through
// verbatim: on redacted hosts the caller already holds the displayed
// (hashed) key, so re-redacting would miss the session.
function newUserEvent(eventType: string, sessionKey: string, reason: string): Event {
  // Agent label from the key's own convention (<agent>:<id>) so user events
  // read consistently in the log.
  const idx = sessionKey.indexOf(":");
  const agent = idx > 0 ? sessionKey.slice(0, idx) : "user";
  const e: Event = {
    v: Version,
    id: crypto.randomUUID(),
    ts: nowTS(),
    host: shortHostname(),
    agent,
    event: eventType,
    session_key: sessionKey,
  };
  if (reason) e.reason = reason;
  return e;
}

export function newSeen(sessionKey: string): Event {
  return newUserEvent(Seen, sessionKey, "");
}

export function newHide(sessionKey: string): Event {
  return newUserEvent(Hide, sessionKey, "");
}

// newShow unhides a session in place: the reverse of hide, clearing hidden
// with no ack and no reorder so the row reappears where it sat.
export function newShow(sessionKey: string): Event {
  return newUserEvent(Show, sessionKey, "");
}

// newPin / newUnpin float a session into the pinned top partition or release
// it. A pin is the user's until removed; only unpin or hide drops it.
export function newPin(sessionKey: string): Event {
  return newUserEvent(Pin, sessionKey, "");
}

export function newUnpin(sessionKey: string): Event {
  return newUserEvent(Unpin, sessionKey, "");
}

// newLabel sets signalbox's own display label (cropped at the emitter).
// An empty label clears back to the agent-provided title.
export function newLabel(sessionKey: string, label: string): Event {
  const e = newUserEvent(Label, sessionKey, "");
  const cropped = cropLabel(label);
  if (cropped) e.label = cropped;
  else e.label = ""; // explicit clear survives JSON round-trip as ""
  return e;
}

// newEnded is the non-agent "ended": `signalbox remove` (reason "removed")
// and the hub sweeps ("expired", "exited").
export function newEnded(sessionKey: string, reason: string): Event {
  return newUserEvent(Ended, sessionKey, reason);
}

// newTag / newUntag add or remove a discreet tag on a session.
export function newTag(sessionKey: string, tag: string): Event {
  const e = newUserEvent(Tag, sessionKey, "");
  e.tags = [tag];
  return e;
}

export function newUntag(sessionKey: string, tag: string): Event {
  const e = newUserEvent(Untag, sessionKey, "");
  e.tags = [tag];
  return e;
}

// validate checks the contract's required fields. CWD is not enforced
// because the redacted profile deliberately omits it.
// normalizeInbound migrates old-format fields on any event the hub reads
// (a POST body, or a line replayed from events.jsonl): `detail` becomes
// `prompt`, and origin.kind is stamped from whichever field is set. Keeps a
// pre-v0.2 log and older emitters working with no data loss.
export function normalizeInbound(e: Event): void {
  const legacy = e as Event & { detail?: string };
  if (legacy.detail !== undefined && e.prompt === undefined) e.prompt = legacy.detail;
  delete legacy.detail;
  if (e.origin && !e.origin.kind) {
    if (e.origin.tmux) e.origin.kind = "tmux";
    else if (e.origin.url) e.origin.kind = "url";
    else if (e.origin.cursor) e.origin.kind = "cursor";
  }
}

export function validate(e: Event): string | null {
  if (e.v !== Version) return `v must be ${Version}`;
  if (!e.id) return "id is required";
  if (!e.ts) return "ts is required";
  if (!e.host) return "host is required";
  if (!e.agent) return "agent is required";
  if (!validType(e.event)) return `unknown event type ${JSON.stringify(e.event)}`;
  if (!e.session_key) return "session_key is required";
  if (e.origin) {
    const set = [e.origin.tmux, e.origin.url, e.origin.cursor].filter(Boolean).length;
    if (set > 1) return "origin is a union: set exactly one of tmux, url, cursor";
    if (set === 0) return "origin present but empty";
  }
  return null;
}

// redact keeps the signal but strips anything that names the work - for corp
// hosts where paths, titles and exchange text must not leave the machine.
export async function redact(e: Event): Promise<void> {
  delete e.cwd;
  delete e.title;
  delete e.prompt;
  delete e.reply;
  delete e.raw; // the raw payload carries everything - never leaves a corp host
  const idx = e.session_key.indexOf(":");
  if (idx > 0 && idx < e.session_key.length - 1) {
    const agent = e.session_key.slice(0, idx);
    const id = e.session_key.slice(idx + 1);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
    const hex = [...new Uint8Array(digest).slice(0, 6)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    e.session_key = `${agent}:${hex}`;
  }
}
