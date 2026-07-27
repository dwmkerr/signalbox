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

// Store is the LWW reducer over events keyed by session_key.
export class Store {
  private sessions = new Map<string, Event>();

  // apply folds one event in. "ended" removes the session (stays in the
  // log). "seen" marks dealt-with without touching recency. "hide"
  // suppresses until the next agent event. "label" sets the user's display
  // name only.
  apply(incoming: Event): void {
    const e: Event = { ...incoming };
    switch (e.event) {
      case ev.Ended:
        this.sessions.delete(e.session_key);
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
    this.sessions.set(e.session_key, e);
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
