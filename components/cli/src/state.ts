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
      // Tags carry like prompt/reply - filled from prev only when the event
      // does not carry its own. An agent event usually has none (so it
      // inherits), but an event may bake tags in, and those must survive even
      // when the session already existed untagged. Only tag/untag events clear
      // them.
      if (!e.tags) e.tags = prev.tags;
      e.engaged_ts = prev.engaged_ts;
    } else {
      // Never-engaged sessions take their arrival slot.
      e.engaged_ts = e.ts;
      // Only a "label" event may set label - an agent event that smuggles
      // one in must not name a brand-new session. Tags are different: a
      // creating event may carry them, so they pass through untouched.
      delete e.label;
    }
    if (engages(e) && after(e.ts, e.engaged_ts)) e.engaged_ts = e.ts;
    // Drop empty-string optionals so /state JSON matches the Go hub's
    // omitempty semantics.
    for (const k of ["reason", "cwd", "title", "prompt", "reply"] as const) {
      if (e[k] === "") delete e[k];
    }
    this.sessions.set(e.session_key, e);
  }

  // list returns the display ordering - engagement MRU: engaged_ts
  // descending, ts then seq breaking ties, so ordering is deterministic.
  list(): Event[] {
    return [...this.sessions.values()].sort((a, b) => {
      if (a.engaged_ts !== b.engaged_ts) return (b.engaged_ts ?? "") < (a.engaged_ts ?? "") ? -1 : 1;
      if (a.ts !== b.ts) return b.ts < a.ts ? -1 : 1;
      return (b.seq ?? 0) - (a.seq ?? 0);
    });
  }
}
