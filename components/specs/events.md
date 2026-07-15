signalbox specifications: [jumplist](https://dwmkerr.github.io/signalbox/specs/hub-jumplist.html) | [settings](https://dwmkerr.github.io/signalbox/specs/settings.html) | [menu bar](https://dwmkerr.github.io/signalbox/specs/menubar.html) | [cli](cli.md) | data model | [agent integrations](adapters.md)

# Specification: signalbox data model

Everything in signalbox is an event. Agents fire **events** as they work; the hub folds them into one **session** per key, and the surfaces show the sessions. So there are two shapes: the event an agent fires, and the session row the hub returns. They share their fields; the session adds the four the hub derives (`seq`, `acked`, `hidden`, `engaged_ts`).

## The event

What an agent fires. Never carries `seq`, `acked`, `hidden`, or `engaged_ts` - the hub sets those.

Every field explained in place. Optional fields are omitted from the JSON when empty.

```jsonc
{
  // Schema version. Always 1 today.
  "v": 1,

  // Unique id for this event (uuid), and when it was fired (UTC).
  "id": "0197-...",
  "ts": "2026-07-07T18:04:11Z",

  // The machine the event fired on.
  "host": "daves-mbp",

  // Who is doing the work. This is also the row's icon: claude, opencode,
  // pi and github have glyphs, anything else gets the fallback ring.
  "agent": "claude",

  // What happened. Agent lifecycle: busy, attention, done, error, ended.
  // User actions: seen, hide, label, tag, untag (they change how a session
  // is shown, never what the agent did).
  "event": "done",

  // Optional detail on the event: permission_prompt, stop, session_end, ...
  "reason": "stop",

  // The stable identity of the session: "<agent>:<session id>". Every event
  // with the same key updates the same row.
  "session_key": "claude:9f2a...",

  // Where the work is happening.
  "cwd": "/Users/dave/repos/work-project",

  // Names, in priority order: label is the user's own name for the session
  // (max 80 chars, set with `signalbox session rename` or the jumplist rename, and
  // only ever by a label event); title is the agent's name for it (a
  // /rename, or the cwd folder name).
  "label": "deploy",
  "title": "work-project",

  // Discreet, free-form tags. Carried across agent events; added or removed
  // with tag/untag events (or set on the creating event).
  "tags": ["work"],

  // The exchange breadcrumb: your last prompt (max 160 chars) and the
  // agent's last message (max 280 chars). One line each, cropped before
  // they leave the emitting process. Never transcripts. (`prompt` was
  // `detail` before v0.2; the hub still reads `detail` from old events.)
  "prompt": "good enough. commit work for now.",
  "reply": "Done - the dashboard now shows per-post traffic.",

  // Where to jump to. `kind` names the origin type so more can be added
  // later (ssh); today tmux, url, or cursor (an editor window - the kind
  // covers every VS Code-family editor: Cursor, VS Code, other Electron
  // forks). Exactly one of the payload fields may be set; old events
  // without `kind` get it inferred from whichever field that is. Captured
  // when the event fires, so jumping never depends on the local setup.
  "origin": {
    "kind": "tmux",
    "tmux": {
      "session": "work-project", "window": 1, "pane": "%12",
      "socket": "/private/tmp/tmux-501/default",
      "terminal": "com.googlecode.iterm2"
    }
    // or: "url": "https://github.com/dwmkerr/signalbox/actions/runs/9182"
    // or: "cursor": { "bundle": "com.todesktop.230313mzl4w4u92" } - just the
    // editor's bundle id; jump finds the window by app plus the event's cwd,
    // so redact has nothing extra to strip.
  },

  // The agent's process, so the hub can end sessions whose process died
  // without a goodbye (a killed TUI, a crash).
  "proc": { "pid": 12345, "name": "claude" },

  // Diagnostic only: the untouched adapter payload, attached when
  // SIGNALBOX_RAW is set so the raw hook JSON can be inspected from the
  // hub's event log. Never set in normal operation; the redacted profile
  // strips it.
  "raw": "{\"hook_event_name\":\"Stop\", ...}",

  // Set by the hub, never by the sender: seq is the ingest order; acked,
  // hidden and engaged_ts are derived state (see below) that the hub
  // serializes onto /state rows.
  "seq": 118,
  "acked": true,
  "hidden": false,
  "engaged_ts": "2026-07-07T18:02:40Z"
}
```

## The session

What `GET /state` returns: an event plus the four fields the hub derives.
`seq` is ingest order; `acked`, `hidden`, and `engaged_ts` come from the
rules below. A fired event that tries to set them is ignored.

## How events become sessions

The hub keeps one row per `session_key`, following these rules:

- **Latest event wins.** A new agent event replaces the row's status. `ended` removes the row (the event log keeps everything).
- **Breadcrumbs carry.** `prompt`, `reply`, `origin` and `proc` persist across events that omit them, so a done without prompt text keeps showing the prompt that started it. `label` always carries, and only a `label` event can change or clear it.
- **Tags carry.** `tags` persist across agent events that omit them (like `prompt`/`reply`), but an event carrying its own `tags` keeps them - even when the session already existed untagged. `tag`/`untag` events add or remove them. Filter with `state --tag` / `--exclude-tag`.
- **New activity resets your flags.** Any agent event clears `acked` and `hidden` - a hidden session that speaks again comes back.

## Read, hidden, and gone

Three user actions, three different strengths:

- **seen** (`signalbox ack`, or any jump): the row is dealt with. It stays on the board, drawn quiet, until the agent speaks again.
- **hide** (`signalbox hide`, jumplist `⌃X`): the row disappears until the agent speaks again. Hiding a running session downgrades to seen - running work must stay visible.
- **ended** (`signalbox remove`, jumplist `⌃⌫`): the row is gone now.

The hub also ends sessions on its own, with an `ended` event like any other (reason `expired` or `exited`; `signalbox remove` fires reason `removed`): after `SIGNALBOX_EXPIRE` (default 24h) without an agent event - checked every 10 minutes and once at boot - and within about 30 seconds of the agent's process dying without an exit event (only processes on the hub's own host are checked). A dead process is ended, never done - dying is not finishing.

## Ordering

Rows keep the order you work in, like the app switcher: most recently engaged first. Engagement means you did something - a prompt you typed, a jump, an ack. Status changes never reorder rows, so the board stays spatially stable while you cycle between sessions.

`engaged_ts` on each `/state` row is this sort key. Sessions you never engaged hold their arrival position.

## The hub API

Default `http://127.0.0.1:8377`, loopback only, no auth (a bearer token is reserved for the future shared hub).

| Endpoint | Behaviour |
|---|---|
| `POST /events` | Validate, assign `seq`, append to the log, update state, broadcast. Returns `{"seq": 118}`. Requires `Content-Type: application/json`. |
| `GET /state` | `{"sessions": [...]}` in display order. |
| `GET /stream?since=N` | Server-sent events: replay everything after seq N, then live. Heartbeat every 15s. |
| `GET /healthz` | `{"ok": true, "version": "0.1.0"}` (the running CLI's version). |

The hub appends every event to `events.jsonl` in the state dir and rebuilds its state from that file on boot; `seq` continues from the highest persisted value. Requests with a non-loopback `Host` header are rejected (DNS rebinding defence), only `application/json` may post (blocks cross-origin form posts from hostile pages), and bodies are capped at 1 MiB.

## Privacy

Signals and a two-line breadcrumb of the exchange, never transcripts. `prompt` and `reply` are the only content-bearing fields in normal operation and both are cropped at the emitter (the diagnostic `raw` field is opt-in via `SIGNALBOX_RAW`). The redacted profile (`SIGNALBOX_PROFILE=redacted`) drops cwd, title, prompt, reply and raw, and hashes the session id - for machines where even one line must not leave.
