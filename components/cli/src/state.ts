// The hub's in-memory session view: last-write-wins per session_key with
// field carry, the seen/hide/label lifecycle, and engagement-MRU ordering
// per specs/events.md.

import * as ev from "./event";
import type { Event } from "./event";

// engages reports whether e is *user* engagement: a seen (ack or jump) or a
// busy whose reason is not session_start/retry - i.e. a prompt the user
// typed. Agent status changes are signals, not engagement.
function engages(e: Event): boolean {
  if (e.event === ev.Seen) return true;
  if (e.event === ev.Busy) return e.reason !== "session_start" && e.reason !== "retry";
  return false;
}

function after(a: string | undefined, b: string | undefined): boolean {
  // RFC3339 UTC strings compare correctly lexicographically.
  return !!a && (!b || a > b);
}

// One turn of the conversation. `seq` is the seq of the event that closed the
// exchange, which makes it the paging cursor: it is monotonic within a hub's
// log, exactly like /stream's `since`.
export interface Exchange {
  prompt?: string;
  reply?: string;
  ts: string;
  cropped?: boolean;
  seq: number;
}

export const DefaultHistoryLimit = 1000;

// Store is the LWW reducer over events keyed by session_key.
export class Store {
  private sessions = new Map<string, Event>();
  private history = new Map<string, Exchange[]>();
  private pending = new Map<string, Exchange>();

  constructor(private historyLimit: number = DefaultHistoryLimit) {}

  // apply folds one event in. "ended" removes the session (stays in the
  // log). "seen" marks dealt-with without touching recency. "hide"
  // suppresses until the next agent event. "label" sets the user's display
  // name only.
  apply(incoming: Event): void {
    const e: Event = { ...incoming };
    switch (e.event) {
      case ev.Ended:
        this.sessions.delete(e.session_key);
        this.history.delete(e.session_key);
        this.pending.delete(e.session_key);
        return;
      case ev.Seen: {
        const cur = this.sessions.get(e.session_key);
        if (cur) {
          cur.acked = true;
          // Ack/jump is engagement. Max, not assignment, so a skewed clock
          // cannot regress the sort key.
          if (after(e.ts, cur.engaged_ts)) cur.engaged_ts = e.ts;
        }
        return;
      }
      case ev.Hide: {
        const cur = this.sessions.get(e.session_key);
        if (cur) {
          // Hide is the stronger, more recent intent than a pin, so it always
          // drops the pin before applying its own rule.
          delete cur.pinned;
          if (cur.event === ev.Busy) {
            // Hide on a busy row is treated as seen: a running session must
            // stay visible.
            cur.acked = true;
            if (after(e.ts, cur.engaged_ts)) cur.engaged_ts = e.ts;
          } else {
            // Order untouched so the row reappears in place when the next
            // agent event resets hidden.
            cur.hidden = true;
          }
        }
        return;
      }
      case ev.Show: {
        // Unhide in place: clear hidden with no ack, no engagement bump, and
        // no reorder, so the row reappears exactly where it sat. Idempotent on
        // a row that is not hidden.
        const cur = this.sessions.get(e.session_key);
        if (cur) delete cur.hidden;
        return;
      }
      case ev.Pin: {
        // Float the row into the top partition and keep it there until the user
        // clears it. No ack, no engagement change. Idempotent.
        const cur = this.sessions.get(e.session_key);
        if (cur) cur.pinned = true;
        return;
      }
      case ev.Unpin: {
        const cur = this.sessions.get(e.session_key);
        if (cur) delete cur.pinned;
        return;
      }
      case ev.Label: {
        // User rename: display label only - no ack, no engagement bump, no
        // recency change. Empty label clears back to the agent title.
        const cur = this.sessions.get(e.session_key);
        if (cur) {
          if (e.label) cur.label = e.label;
          else delete cur.label;
        }
        return;
      }
      case ev.Tag: {
        const cur = this.sessions.get(e.session_key);
        if (cur) cur.tags = [...new Set([...(cur.tags ?? []), ...(e.tags ?? [])])];
        return;
      }
      case ev.Untag: {
        const cur = this.sessions.get(e.session_key);
        if (cur && cur.tags) {
          cur.tags = cur.tags.filter((t) => !(e.tags ?? []).includes(t));
          if (cur.tags.length === 0) delete cur.tags;
        }
        return;
      }
    }

    const prev = this.sessions.get(e.session_key);
    // Any agent event is new activity: a prior ack or hide no longer applies.
    delete e.acked;
    delete e.hidden;
    if (prev) {
      // Field carry: keep last known values rather than blanking the board.
      if (!e.prompt) e.prompt = prev.prompt;
      if (!e.reply) e.reply = prev.reply;
      if (!e.origin) e.origin = prev.origin;
      if (!e.proc) e.proc = prev.proc;
      // Machine identity is a breadcrumb too, so an older emitter cannot blank it.
      if (!e.machine) e.machine = prev.machine;
      // The user's label always carries: agent events never set it.
      if (prev.label) e.label = prev.label;
      else delete e.label;
      // A pin carries like label, not like acked/hidden: new activity does not
      // clear it, so a pinned session that speaks again stays pinned. Only
      // unpin or hide removes it.
      if (prev.pinned) e.pinned = true;
      else delete e.pinned;
      // Tags carry like prompt/reply - filled from prev only when the event
      // does not carry its own. An agent event usually has none (so it
      // inherits), but an event may bake tags in, and those must survive even
      // when the session already existed untagged. Only tag/untag events clear
      // them.
      if (!e.tags) e.tags = prev.tags;
      // An enriched ask is not clobbered by its bare twin: one blocked dialog
      // can reach the hub twice (a permission_request/question attention with
      // the real ask in reply, plus a bare notification). While the row is
      // already in attention with a rich reason, a plain attention duplicate
      // keeps the rich reply and reason, whatever order they arrived in. Any
      // non-attention agent event ends the ask and normal rules resume.
      const richAsk = (r?: string) => r === "permission_request" || r === "question";
      if (prev.event === ev.Attention && e.event === ev.Attention && richAsk(prev.reason) && !richAsk(e.reason)) {
        e.reply = prev.reply;
        e.reason = prev.reason;
      }
      e.engaged_ts = prev.engaged_ts;
    } else {
      // Never-engaged sessions take their arrival slot.
      e.engaged_ts = e.ts;
      // Only a "label" event may set label - an agent event that smuggles
      // one in must not name a brand-new session. Tags are different: a
      // creating event may carry them, so they pass through untouched.
      delete e.label;
      // Likewise a pin is set only by a pin event, never smuggled onto a
      // brand-new session by a creating agent event.
      delete e.pinned;
    }
    if (engages(e) && after(e.ts, e.engaged_ts)) e.engaged_ts = e.ts;
    // Drop empty-string optionals so /state JSON matches the Go hub's
    // omitempty semantics.
    for (const k of ["reason", "cwd", "title", "prompt", "reply"] as const) {
      if (e[k] === "") delete e[k];
    }
    this.recordExchange(incoming, incoming.seq ?? 0);
    this.sessions.set(e.session_key, e);
  }

  // Attention events never touch history because their reply is ask text. The
  // event TYPE decides which turn a reply belongs to: a busy is a turn
  // STARTING, so a reply riding on it can only be the previous turn's final
  // text (the new turn has produced nothing yet) - it heals the outgoing
  // exchange. A done/error is a turn ENDING, so a prompt+reply on one event
  // are the same turn's pair (single-shot emitters like `fire` and the
  // opencode plugin). The heal exists because Stop-time capture can lose the
  // transcript write race; the next idle notification or prompt
  // deterministically carries the corrected final text.
  private recordExchange(incoming: Event, seq: number): void {
    if (![ev.Busy, ev.Done, ev.Error].includes(incoming.event)) return;

    const key = incoming.session_key;
    const commit = (exchange: Exchange): void => {
      const history = this.history.get(key) ?? [];
      history.push({ ...exchange, seq });
      while (history.length > this.historyLimit) history.shift();
      this.history.set(key, history);
    };
    // The reply lands on the exchange in flight: fill the pending if one is
    // open, amend the latest committed exchange if not (the write-race heal;
    // replacing with an identical value keeps at-least-once delivery
    // idempotent), or cold-start a reply-only pending when there is nothing
    // to amend.
    const applyReply = (): void => {
      const pending = this.pending.get(key);
      if (pending) {
        pending.reply = incoming.reply;
        pending.ts = incoming.ts;
        if (incoming.cropped === true) pending.cropped = true;
        return;
      }
      const history = this.history.get(key);
      const latest = history?.[history.length - 1];
      if (latest) {
        latest.reply = incoming.reply;
        if (incoming.cropped === true) latest.cropped = true;
        return;
      }
      this.pending.set(key, {
        reply: incoming.reply,
        ts: incoming.ts,
        cropped: incoming.cropped === true ? true : undefined,
        seq: 0,
      });
    };
    const openPrompt = (): void => {
      const existing = this.pending.get(key);
      if (existing) commit(existing);
      this.pending.set(key, {
        prompt: incoming.prompt,
        ts: incoming.ts,
        cropped: incoming.cropped === true ? true : undefined,
        seq: 0,
      });
    };

    if (incoming.event === ev.Busy) {
      // Turn start: heal the outgoing exchange first, then open the new one.
      // A busy never closes a pair - its reply belongs to the turn before it.
      if (incoming.reply) applyReply();
      if (incoming.prompt) openPrompt();
      return;
    }

    // Turn end (done/error): prompt then reply, so a single event carrying
    // both pairs them; then a completed pair commits.
    if (incoming.prompt) openPrompt();
    if (incoming.reply) applyReply();
    const pending = this.pending.get(key);
    if (pending?.prompt && pending.reply) {
      commit(pending);
      this.pending.delete(key);
    }
  }

  // exchanges returns the newest `limit` exchanges, OLDEST FIRST (both surfaces
  // render a conversation top to bottom). `before` pages backwards: only
  // exchanges with a lower seq are considered. Returns null when the session is
  // not on the board, so a caller can answer 404 rather than an empty list -
  // "no history yet" and "no such session" are different answers.
  exchanges(sessionKey: string, opts: { limit: number; before?: number }): Exchange[] | null {
    if (!this.sessions.has(sessionKey)) return null;
    const all = this.history.get(sessionKey) ?? [];
    const eligible = opts.before === undefined ? all : all.filter((x) => x.seq < opts.before!);
    // Return copies so callers cannot mutate the ring through shared references.
    return eligible.slice(Math.max(0, eligible.length - opts.limit)).map((x) => ({ ...x }));
  }

  // list returns the display ordering - pinned first, then engagement MRU:
  // engaged_ts descending, ts then seq breaking ties, so ordering is
  // deterministic. Pinned sessions form a top partition (all pinned before all
  // unpinned); engagement-MRU orders each partition internally, so a pin floats
  // a row above more-recently-engaged unpinned rows without reordering the
  // pinned group among itself. The hub owns this order; surfaces adopt it.
  list(): Event[] {
    return [...this.sessions.values()].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (a.engaged_ts !== b.engaged_ts) return (b.engaged_ts ?? "") < (a.engaged_ts ?? "") ? -1 : 1;
      if (a.ts !== b.ts) return b.ts < a.ts ? -1 : 1;
      return (b.seq ?? 0) - (a.seq ?? 0);
    });
  }
}
