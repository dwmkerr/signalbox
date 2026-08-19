signalbox specifications: [jumplist](https://dwmkerr.github.io/signalbox/specs/hub-jumplist.html) | [settings](https://dwmkerr.github.io/signalbox/specs/settings.html) | [menu bar](https://dwmkerr.github.io/signalbox/specs/menubar.html) | [ios](https://dwmkerr.github.io/signalbox/specs/ios.html) | [architecture](https://dwmkerr.github.io/signalbox/specs/architecture.html) | [cli](cli.md) | [data model](events.md) | [agent integrations](adapters.md) | search

# Specification: session contents search

> [!NOTE]
> **Status: proposed.** This specification leads the implementation. The search index, commands, hub endpoints, and app surfaces described here are not built yet.

Search indexes complete local agent conversations so a query can find live and ended sessions. It indexes user prompts and assistant replies, not raw transcript records.

## Local-only privacy boundary

The existing event contract promises "signals and a two-line breadcrumb of the exchange, never transcripts - crops happen at the emitter, the full text never leaves the machine that produced it" (`components/cli/src/event.ts:31`). Search preserves that hard boundary.

The index never leaves the machine that owns the transcripts. A forwarder does not serve `/search`. A hub answers `/search` only from its own local index and never on behalf of a forwarding machine.

Remote fan-out remains technically reachable: the hub already broadcasts commands downstream to forwarders (`components/cli/src/forwarder.ts:286`), and forwarders handle those frames at `components/cli/src/forwarder.ts:400`. Remote search would also need a reply path and a separate privacy decision. It is out of scope for this version.

## Index location

The SQLite index is `<stateDir()>/search.db`. `stateDir()` honours `SIGNALBOX_DATA_DIR`, so tests and isolated runs relocate the index together with the rest of Signalbox state.

## Schema

This schema is the implementation contract. Later schema work must implement these statements verbatim.

```sql
-- One row per indexed transcript file. Enables incremental, append-only
-- resume: a file that only grew is read from byte_offset, never re-parsed.
CREATE TABLE files (
  path        TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  session_uuid TEXT NOT NULL,
  cwd         TEXT,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  indexed_ts  TEXT NOT NULL
);

-- One row per TURN: a user prompt or an assistant reply. Not per raw
-- message: tool calls and tool output would drown the conversation.
CREATE TABLE turns (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  session_uuid TEXT NOT NULL,
  agent        TEXT NOT NULL,
  cwd          TEXT,
  role         TEXT NOT NULL,   -- "user" | "assistant"
  ts           TEXT,            -- RFC3339 when the line carried one
  text         TEXT NOT NULL
);
CREATE INDEX turns_by_session ON turns(session_uuid);
CREATE INDEX turns_by_path ON turns(path);

CREATE VIRTUAL TABLE turns_fts USING fts5(
  text,
  content='turns',
  content_rowid='id',
  tokenize="unicode61 remove_diacritics 2",
  prefix='2 3'
);
```

`turns_fts` is an external-content table. The indexer keeps it in sync inside the same transaction as every corresponding `turns` write or deletion. There are no triggers: the indexer is the only writer, so triggers would add indirection without a benefit.

The `prefix='2 3'` indexes make the fallback row's live hit count affordable while the user types. The tokenizer deliberately does not use `porter` stemming because stemming mangles code identifiers and terms that users expect to match exactly.

## Turn extraction

A turn is one displayed user prompt or assistant reply from an eligible transcript line. Tool calls, tool output, reasoning, system instructions, metadata, and lifecycle records are not turns. Empty displayed text and malformed JSON lines are skipped. Only complete newline-terminated records are consumed, so a line still being written remains at the current `byte_offset` for the next sweep.

Each parser invocation reads at most a 1 MiB window from its starting byte
offset. It consumes through the last complete newline in that window and leaves
any trailing partial record for the next invocation. A filled window with no
newline means the current line is oversized. The parser discards it in bounded
1 MiB chunks until it reaches the next newline, then resumes after that line. It
does not grow the window because multi-megabyte lines are giant tool results or
pastes whose turn text would already exceed the index cap. A short read with no
newline means EOF was reached while a line may still be written, so the parser
consumes nothing and leaves the byte offset unchanged. Indexed text for one
turn is capped at 64 KiB of UTF-8, truncating the end when necessary, so one
pathological paste cannot cause unbounded index growth.

The default discovery roots can be overridden with
`SIGNALBOX_CLAUDE_TRANSCRIPTS_DIR`, `SIGNALBOX_CODEX_TRANSCRIPTS_DIR`, and
`SIGNALBOX_CURSOR_TRANSCRIPTS_DIR`. Each override names the corresponding
`projects`, `sessions`, or Cursor `projects` directory directly. This keeps
isolated runs and tests away from the user's real transcript corpora.

### Claude

Claude transcripts include these paths:

- `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`
- `~/.claude/projects/<cwd-slug>/<session-uuid>/subagents/agent-<id>.jsonl`
- `~/.claude/projects/<cwd-slug>/<session-uuid>/subagents/workflows/wf_<id>/agent-<id>.jsonl`

Discovery walks each project tree recursively to a fixed maximum depth. A
subagent transcript is indexed as real conversation content and attributed to
the nearest ancestor directory whose name is a session UUID. It is never
attributed to the `agent-<id>` filename, so its search hits resolve to the
parent session that a user can jump to. A `.jsonl` file is eligible only when
it is a top-level session transcript with a UUID filename or is nested below a
session UUID directory. Non-transcript directories such as `memory` are
therefore ignored.

- Index only lines whose top-level `type` is exactly `"user"` or `"assistant"`. The role is also present at `message.role`; if both values are present but disagree, skip the malformed line.
- Read displayed text from `message.content`. A string is text directly. For an array, concatenate only blocks whose `type` is `"text"`; ignore tool-use, tool-result, and every other block type.
- Apply the existing `contentText()` block extraction and `stripHarness()` harness-noise filtering from `components/cli/src/claude.ts` rather than duplicating those rules.
- Skip line types `system`, `attachment`, `file-history-snapshot`, `last-prompt`, `mode`, `permission-mode`, `ai-title`, and `queue-operation`. Skip every other top-level type not explicitly included above.
- Take `cwd` from transcript entries. Take a top-level transcript's session UUID from its filename and a subagent transcript's session UUID from its nearest session UUID ancestor directory.

### Codex

Codex transcripts are `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`.

- Read the session UUID from the filename and from line 1, whose top-level `type` is `"session_meta"` and whose `payload` carries `session_id` and `cwd`. `session_meta` supplies metadata and is not a turn.
- Index only top-level `type: "event_msg"` lines whose `payload.type` is `"user_message"` or `"agent_message"`. Map those payload types to stored roles `"user"` and `"assistant"`, respectively, and read the turn text from `payload.message`.
- Take `ts` from the line's top-level `timestamp`.
- Never index `response_item` lines. They can contain developer and system prompts as well as reasoning blocks.
- Skip `token_count`, `custom_tool_call`, `custom_tool_call_output`, `world_state`, `turn_context`, `task_started`, `task_complete`, and `patch_apply_end`. Skip every other top-level or payload type not explicitly included above.

Codex hook payloads do not carry a transcript path. Discovery resolves a session by globbing `~/.codex/sessions/**/rollout-*-<session_id>.jsonl`.

### Cursor

Cursor transcripts are `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`.

- Index only entries whose top-level `role` is exactly `"user"` or `"assistant"`.
- Read displayed text from `message.content`. A string is text directly. For an array, concatenate only `"text"` blocks and ignore every other block type.
- Skip entries with any other role or with no valid role. In particular, never infer a turn from nested role-like fields.
- Take the session UUID from the transcript directory and filename ID. Preserve a timestamp or cwd only when the transcript line carries one; otherwise store `NULL`.

## Incremental indexing

### Staleness

A file is re-read when its current `mtime_ms` or `size` differs from its stored `files` row.

- If the current `size` is greater than or equal to the stored size, parse from the stored `byte_offset`. This is the append-only path and never reparses earlier turns.
- If the current `size` is smaller than the stored size, treat the file as rewritten or truncated: delete its existing `turns` and rebuild it from byte offset 0.
- If an indexed file has vanished, delete its `files` row and its `turns`. The foreign-key cascade removes the content rows, and the indexer removes the matching external-content FTS rows in the same transaction.

After each bounded batch, the indexer commits the last complete-line `byte_offset` and matching file metadata. A stopped hub or exhausted tick therefore loses no committed progress, and the next sweep resumes from the durable offset.

### Sweep budget

The hub starts a sweep tick every 250 ms and spends at most 10 ms of wall-clock time indexing on each tick. Parsing and writes use bounded batches, commit their progress, and yield when the budget is exhausted. A 10 ms slice stays below a display frame on the app's main interaction path, while four ticks per second provide steady first-build throughput.

A tick's budget is only enforceable when the unit of work is smaller than the
budget, so the indexer must never read a whole transcript in one operation. The
largest transcripts observed on a working machine are 65 MB, which take roughly
90 ms to 500 ms to read and parse in full: reading one whole would overshoot a
10 ms slice by more than an order of magnitude. The indexer therefore reads a
bounded window of bytes from `byte_offset`, stops at the last complete newline
in that window, and commits. A large file is consumed across as many ticks as
it needs, which is the same mechanism the append-only resume already uses.

Event ingest and the SSE stream have priority. A sweep must never delay event ingest or SSE delivery. The 10 ms budget is a hard ceiling for a tick, not permission to block pending event work; discovery, parsing, and database writes must use bounded operations and yield between batches.

### First build and status

Measured on a working machine: 1248 transcripts totalling approximately 1.2 GB
yield roughly 65,000 turns and 38 MB of indexed text, because turn text is only
about 3 percent of raw transcript bytes. Parsing runs at roughly 125 MB/s cold.
The first build is therefore on the order of 10 to 15 seconds of CPU, spread by
the sweep budget across approximately 6 minutes of wall clock. Progress is observable through `signalbox index --status` and the Settings surface, including whether the first build is running and how much work remains. Both surfaces must update as batches commit. A first build must never present as a silent freeze.

## Out of scope for v1

- OpenCode's SQLite transcript store at `~/.local/share/opencode/opencode.db`
- Search across remote or forwarded machines
- Spawning or automatically resuming an ended session
