import { describe, expect, test } from "bun:test";
import { Store } from "../src/state";
import * as ev from "../src/event";
import type { Event } from "../src/event";

function mk(key: string, eventType: string, ts: string, seq = 0): Event {
  return {
    v: 1, id: `${key}-${eventType}-${seq}`, ts, host: "h", agent: "script",
    event: eventType, session_key: key, seq,
  };
}

function mkReason(key: string, eventType: string, reason: string, ts: string, seq = 0): Event {
  return { ...mk(key, eventType, ts, seq), reason };
}

const t = (m: number) => `2026-07-07T10:${String(m).padStart(2, "0")}:00Z`;

function keys(s: Store): string[] {
  return s.list().map((e) => e.session_key);
}

describe("engagement MRU", () => {
  test("session_start does not engage; prompt busy does; seen does", () => {
    const s = new Store();
    s.apply(mkReason("a", ev.Busy, "session_start", t(0), 1));
    expect(s.list()[0].engaged_ts).toBe(t(0)); // first-seen fallback

    s.apply(mk("a", ev.Busy, t(1), 2)); // prompt-shaped busy
    expect(s.list()[0].engaged_ts).toBe(t(1));

    s.apply(mk("a", ev.Done, t(2), 3)); // status change: no reorder
    expect(s.list()[0].engaged_ts).toBe(t(1));

    const seen = ev.newSeen("a");
    seen.ts = t(3);
    s.apply(seen);
    expect(s.list()[0].engaged_ts).toBe(t(3));
  });

  test("ordering is engaged_ts desc; agent events do not reorder", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1));
    s.apply(mk("b", ev.Busy, t(1), 2));
    expect(keys(s)).toEqual(["b", "a"]);
    // Agent status change on a must not move it above b.
    s.apply(mk("a", ev.Done, t(5), 3));
    expect(keys(s)).toEqual(["b", "a"]);
    // But a new prompt on a does.
    s.apply(mk("a", ev.Busy, t(6), 4));
    expect(keys(s)).toEqual(["a", "b"]);
  });

  test("skewed clock cannot regress the sort key", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(5), 1));
    const seen = ev.newSeen("a");
    seen.ts = t(1); // older than current engagement
    s.apply(seen);
    expect(s.list()[0].engaged_ts).toBe(t(5));
  });
});

describe("lifecycle", () => {
  test("last write wins per key", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1));
    s.apply(mk("a", ev.Done, t(1), 2));
    expect(s.list().length).toBe(1);
    expect(s.list()[0].event).toBe(ev.Done);
  });

  test("ended removes the session", () => {
    const s = new Store();
    s.apply(mk("a", ev.Done, t(0), 1));
    s.apply(mk("a", ev.Ended, t(1), 2));
    expect(s.list().length).toBe(0);
  });

  test("seen sets acked; any agent event resets it", () => {
    const s = new Store();
    s.apply(mk("a", ev.Done, t(0), 1));
    s.apply(ev.newSeen("a"));
    expect(s.list()[0].acked).toBe(true);
    expect(s.list()[0].event).toBe(ev.Done); // displayed event unchanged
    s.apply(mk("a", ev.Attention, t(2), 3));
    expect(s.list()[0].acked).toBeUndefined();
  });

  test("hide suppresses until the next agent event", () => {
    const s = new Store();
    s.apply(mk("a", ev.Done, t(0), 1));
    s.apply(ev.newHide("a"));
    expect(s.list()[0].hidden).toBe(true);
    s.apply(mk("a", ev.Attention, t(2), 3));
    expect(s.list()[0].hidden).toBeUndefined();
  });

  test("hide on a busy row is treated as seen", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1));
    const hide = ev.newHide("a");
    hide.ts = t(1);
    s.apply(hide);
    const row = s.list()[0];
    expect(row.hidden).toBeUndefined();
    expect(row.acked).toBe(true);
    expect(row.engaged_ts).toBe(t(1));
  });

  test("seen/hide/label for unknown sessions are no-ops", () => {
    const s = new Store();
    s.apply(ev.newSeen("ghost"));
    s.apply(ev.newHide("ghost"));
    s.apply(ev.newLabel("ghost", "name"));
    expect(s.list().length).toBe(0);
  });
});

describe("carry", () => {
  test("detail, reply, origin and proc carry across omitting events", () => {
    const s = new Store();
    const first = mk("a", ev.Busy, t(0), 1);
    first.prompt = "the prompt";
    first.reply = "the reply";
    first.origin = { tmux: { session: "s", window: 1, pane: "%1" } };
    first.proc = { pid: 123, name: "claude" };
    s.apply(first);
    s.apply(mk("a", ev.Done, t(1), 2));
    const row = s.list()[0];
    expect(row.prompt).toBe("the prompt");
    expect(row.reply).toBe("the reply");
    expect(row.origin?.tmux?.pane).toBe("%1");
    expect(row.proc?.pid).toBe(123);
  });

  test("latest non-empty wins", () => {
    const s = new Store();
    const first = mk("a", ev.Busy, t(0), 1);
    first.prompt = "old";
    s.apply(first);
    const second = mk("a", ev.Busy, t(1), 2);
    second.prompt = "new";
    s.apply(second);
    expect(s.list()[0].prompt).toBe("new");
  });
});

describe("label", () => {
  test("sets, carries, and never engages", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1));
    const label = ev.newLabel("a", "prod deploy");
    label.ts = t(1);
    s.apply(label);
    let row = s.list()[0];
    expect(row.label).toBe("prod deploy");
    expect(row.acked).toBeUndefined();
    expect(row.engaged_ts).toBe(t(0));
    expect(row.event).toBe(ev.Busy);
    // Carries across agent events.
    s.apply(mk("a", ev.Done, t(2), 3));
    row = s.list()[0];
    expect(row.label).toBe("prod deploy");
  });

  test("empty label clears", () => {
    const s = new Store();
    s.apply(mk("a", ev.Done, t(0), 1));
    s.apply(ev.newLabel("a", "temp"));
    s.apply(ev.newLabel("a", ""));
    expect(s.list()[0].label).toBeUndefined();
  });

  test("agent events cannot smuggle a label", () => {
    const s = new Store();
    const e = mk("a", ev.Busy, t(0), 1);
    e.label = "smuggled";
    s.apply(e);
    expect(s.list()[0].label).toBeUndefined();
  });
});

describe("tags", () => {
  test("tag adds, untag removes, carries across agent events", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1));
    s.apply(ev.newTag("a", "demo"));
    expect(s.list()[0].tags).toEqual(["demo"]);
    // carries across an agent event
    s.apply(mk("a", ev.Done, t(1), 2));
    expect(s.list()[0].tags).toEqual(["demo"]);
    // a second tag accumulates, no dupes
    s.apply(ev.newTag("a", "work"));
    s.apply(ev.newTag("a", "demo"));
    expect(new Set(s.list()[0].tags)).toEqual(new Set(["demo", "work"]));
    // untag removes
    s.apply(ev.newUntag("a", "demo"));
    expect(s.list()[0].tags).toEqual(["work"]);
    // removing the last tag clears the field
    s.apply(ev.newUntag("a", "work"));
    expect(s.list()[0].tags).toBeUndefined();
  });

  test("an event may carry tags on creation (demo)", () => {
    const s = new Store();
    const e = mk("a", ev.Busy, t(0), 1);
    e.tags = ["demo"];
    s.apply(e);
    expect(s.list()[0].tags).toEqual(["demo"]);
  });

  test("a tagged event tags an already-untagged session (demo re-run)", () => {
    const s = new Store();
    // Session first seen without tags (e.g. a prior real event or old data).
    s.apply(mk("a", ev.Busy, t(0), 1));
    expect(s.list()[0].tags).toBeUndefined();
    // A later event that carries its own tags must apply them, not inherit the
    // absent prev tags.
    const e = mk("a", ev.Done, t(1), 2);
    e.tags = ["demo"];
    s.apply(e);
    expect(s.list()[0].tags).toEqual(["demo"]);
  });

  test("tag/untag on unknown session is a no-op", () => {
    const s = new Store();
    s.apply(ev.newTag("ghost", "demo"));
    expect(s.list().length).toBe(0);
  });
});
