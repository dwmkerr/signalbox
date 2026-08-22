signalbox specifications: [jumplist](https://dwmkerr.github.io/signalbox/specs/hub-jumplist.html) | [settings](https://dwmkerr.github.io/signalbox/specs/settings.html) | [menu bar](https://dwmkerr.github.io/signalbox/specs/menubar.html) | [ios](https://dwmkerr.github.io/signalbox/specs/ios.html) | [architecture](https://dwmkerr.github.io/signalbox/specs/architecture.html) | [cli](cli.md) | [data model](events.md) | [agent integrations](adapters.md) | search

# Specification: session contents search

> [!NOTE]
> **Status: proposed.** This specification leads the implementation. The search index, commands, hub endpoints, and app surfaces described here are not built yet.

Search indexes complete local agent conversations so a query can find live and ended sessions. It indexes user prompts and assistant replies, not raw transcript records.

## Why transcripts, and not the exchange ring

The hub already keeps a per-session ring of exchanges and serves it over
[`GET /exchanges`](events.md#the-hub-api). Search does not use it. The ring is
bounded (`hub.historyLimit`, 1,000 exchanges per session by default) and exists
only for sessions the hub currently knows about, so it cannot answer the
question this feature is for: finding a session that ended weeks ago and left
the board. Transcripts on disk are the complete archive, which is why they are
the corpus. The two stores are complementary, not alternatives.

## Local-only boundary

The index never leaves the machine that owns the transcripts. A forwarder does
not serve `/search`. A hub answers `/search` only from its own local index and
never on behalf of a forwarding machine.

This is a deliberate scope and privacy decision for this version, not an
inherited invariant. Signalbox does send conversation content to a configured
remote hub: `prompt` and `reply` carry raw Markdown up to their caps, and
`/exchanges` serves that history to clients. The transcript index is held to a
stricter rule than that content for three reasons:

1. It covers sessions that are not on the board at all, including work the hub
   has never seen and has no other reason to hold.
2. It covers the whole archive rather than a bounded recent ring, so the volume
   and the spread across unrelated projects are of a different order.
3. A remote hub cannot read another machine's transcripts in any case, so
   serving them would require a query fan-out that does not exist.

Remote fan-out remains technically reachable: the hub already broadcasts
commands downstream to forwarders (`components/cli/src/forwarder.ts`), and
forwarders handle those frames. Remote search would also need a reply path,
which commands do not have, plus a separate privacy decision. It is out of
scope for this version.

The `transcript` path field on events is held to the same rule: `redact()`
strips it, and every forwarder strips it on the uplink for all profiles
(see [events.md](events.md#privacy)).

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

## Query semantics

Search input is plain text, never FTS5 syntax. The query layer extracts Unicode
word tokens, quotes each token, prefix-matches tokens of two or more characters,
and joins them with `AND`. A query such as `edit skill` becomes
`"edit"* AND "skill"*`. Single-character tokens are matched exactly because the
schema's cheap prefix indexes begin at two characters. At most the first 32
tokens and 128 Unicode code points from each token are used, which keeps one
search-box query bounded.

Quotes, wildcards, parentheses, carets, and leading minus signs are separators,
not operators. FTS5-looking words such as `OR` and `NEAR` are quoted as ordinary
search terms. Consequently raw user input never reaches `MATCH`, and malformed
FTS5 syntax cannot surface as a SQLite error. A query containing no word tokens,
such as `*` or `^`, has zero hits and zero results.

`countHits(q)` counts matching turns, not occurrences or sessions. Its prefix
expressions use the `prefix='2 3'` indexes so the jumplist can refresh the count
while the user types.

`search(q, limit)` groups matching turns by `session_uuid`. Each result carries
the session UUID, agent, cwd, best matching turn's timestamp, an FTS5
`snippet()` with matches enclosed in `<mark>` and `</mark>`, and the number of
matching turns in that session. The best turn is the one with the lowest FTS5
`bm25()` score. Sessions are ordered by that score, then by the best turn's
timestamp from newest to oldest, with the session UUID as a stable final tie
breaker.

A result is marked `live` only when an indexed file path for its session exactly
matches the `transcript` path of a current board row. A live result also carries
that row's `session_key` as its jump target. Every other result is marked
`ended` and has no jump target.

## Hub API

The hub serves local grouped results at `GET /search?q=QUERY`. The route is
below the normal hub authentication gate and uses the same flat route shape as
`GET /exchanges`; query values are ordinary URL query values. A successful
response is `200` with `Cache-Control: no-store`:

```json
{
  "enabled": true,
  "query": "edit skill",
  "results": []
}
```

`results` contains at most 50 grouped results with the fields described in
Query semantics. A missing or empty `q` is `400` with `{"error":"q is
required"}`. When search is off, the route returns `409` with
`{"error":"search_disabled","enabled":false}`. This marker is deliberately
not an empty result list, because an empty list means an enabled search found
no matches.

`GET /search/status` is also below the authentication gate and returns `200`
with `Cache-Control: no-store`. When enabled, its body is `{"enabled":true,
"status":STATUS}`, where `STATUS` is the index status described below. When
off, its body is `{"enabled":false,"status":"disabled"}`.

A forwarder returns `501` for both routes with
`{"error":"search_not_supported","mode":"forwarder"}` and
`Cache-Control: no-store`. It never proxies either route because doing so would
make transcript-derived text cross machines.

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

The hub starts a sweep tick every 250 ms with a 10 ms wall-clock indexing
budget. Parsing and writes use bounded batches, commit their progress, and
yield when the budget is exhausted. A 10 ms slice stays below a display frame
on the app's main interaction path, while four ticks per second provide steady
first-build throughput.

Discovery is separate from that indexing budget. The indexer walks the
transcript roots once when the enabled index opens, before the recurring sweep
timer starts, and refreshes the discovered corpus every 30 seconds. The initial
walk is a one-off startup operation outside the per-tick budget. Each refresh
builds a pending work list that is retained across ticks; intervening sweeps
consume that list without walking the directories again. A new, changed, or
vanished file becomes pending at the next refresh. Status reads the retained
list and does not trigger its own discovery walk.

A tick's budget is only enforceable when the unit of work is smaller than the
budget, so the indexer must never read a whole transcript in one operation. The
largest transcripts observed on a working machine are 65 MB, which take roughly
90 ms to 500 ms to read and parse in full: reading one whole would overshoot a
10 ms slice by more than an order of magnitude. The indexer therefore reads a
bounded window of bytes from `byte_offset`, stops at the last complete newline
in that window, and commits. A large file is consumed across as many ticks as
it needs, which is the same mechanism the append-only resume already uses.

The budget controls whether another indexing unit may start; it cannot preempt
a parser or transaction already in progress. When discovered work exists, a
sweep always commits or attempts at least one bounded unit before checking the
deadline. If that unit takes longer than 10 ms, the sweep returns immediately
after it instead of making no progress forever. Subsequent units start only
while time remains. Event ingest and the SSE stream have priority, so parsing
and database writes yield after the current bounded unit.

### First build and status

Measured on a working machine: 1248 transcripts totalling approximately 1.2 GB
yield roughly 65,000 turns and 38 MB of indexed text, because turn text is only
about 3 percent of raw transcript bytes. Parsing runs at roughly 125 MB/s cold.
The first build is therefore on the order of 10 to 15 seconds of CPU, spread by
the sweep budget across approximately 6 minutes of wall clock. Progress is
observable through `signalbox index --status` and the Settings surface,
including whether the first build is running and how much work from the most
recent discovery remains. Both surfaces must update as batches commit. A first
build must never present as a silent freeze.

## Out of scope for v1

- OpenCode's SQLite transcript store at `~/.local/share/opencode/opencode.db`
- Search across remote or forwarded machines
- Spawning or automatically resuming an ended session
