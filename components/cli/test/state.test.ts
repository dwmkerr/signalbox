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

function applyTurn(s: Store, key: string, turn: number): void {
  s.apply({ ...mk(key, ev.Busy, t(turn * 2 - 1), turn * 2 - 1), prompt: `prompt ${turn}` });
  s.apply({ ...mkReason(key, ev.Done, "stop", t(turn * 2), turn * 2), reply: `reply ${turn}` });
}

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

describe("show", () => {
  test("returns a hidden row to its place, not the top, without acking", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1));
    s.apply(mk("b", ev.Done, t(1), 2));
    s.apply(mk("c", ev.Busy, t(2), 3));
    expect(keys(s)).toEqual(["c", "b", "a"]);
    const hide = ev.newHide("b");
    hide.ts = t(3);
    s.apply(hide);
    expect(s.list().find((e) => e.session_key === "b")?.hidden).toBe(true);
    // A show much later must not float b to the top or bump its engagement.
    const show = ev.newShow("b");
    show.ts = t(9);
    s.apply(show);
    expect(keys(s)).toEqual(["c", "b", "a"]);
    const row = s.list().find((e) => e.session_key === "b")!;
    expect(row.hidden).toBeUndefined();
    expect(row.acked).toBeUndefined();
    expect(row.engaged_ts).toBe(t(1));
  });

  test("show on a non-hidden row is a no-op (idempotent)", () => {
    const s = new Store();
    s.apply(mk("a", ev.Done, t(0), 1));
    s.apply(ev.newShow("a"));
    const row = s.list()[0];
    expect(row.hidden).toBeUndefined();
    expect(row.acked).toBeUndefined();
  });

  test("show/pin/unpin on unknown sessions are no-ops", () => {
    const s = new Store();
    s.apply(ev.newShow("ghost"));
    s.apply(ev.newPin("ghost"));
    s.apply(ev.newUnpin("ghost"));
    expect(s.list().length).toBe(0);
  });
});

describe("pin", () => {
  test("pin floats a row above a more-recently-engaged unpinned row", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1)); // engaged t0
    s.apply(mk("b", ev.Busy, t(5), 2)); // engaged t5, currently on top
    expect(keys(s)).toEqual(["b", "a"]);
    s.apply(ev.newPin("a"));
    // Pinned partition sorts first even though b engaged more recently.
    expect(keys(s)).toEqual(["a", "b"]);
    const row = s.list()[0];
    expect(row.pinned).toBe(true);
    // Pin neither acks nor bumps engagement.
    expect(row.acked).toBeUndefined();
    expect(row.engaged_ts).toBe(t(0));
  });

  test("engagement-MRU still orders within the pinned partition", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1));
    s.apply(mk("b", ev.Busy, t(1), 2));
    s.apply(mk("c", ev.Busy, t(2), 3));
    s.apply(ev.newPin("a"));
    s.apply(ev.newPin("b"));
    // a and b pinned (b engaged after a), c the only unpinned row.
    expect(keys(s)).toEqual(["b", "a", "c"]);
  });

  test("unpin restores engagement order; pin and unpin are idempotent", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1));
    s.apply(mk("b", ev.Busy, t(5), 2));
    s.apply(ev.newPin("a"));
    s.apply(ev.newPin("a")); // idempotent
    expect(keys(s)).toEqual(["a", "b"]);
    s.apply(ev.newUnpin("a"));
    s.apply(ev.newUnpin("a")); // idempotent
    expect(keys(s)).toEqual(["b", "a"]);
    expect(s.list().find((e) => e.session_key === "a")?.pinned).toBeUndefined();
  });

  test("a pin survives agent events, unlike acked/hidden", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1));
    s.apply(ev.newPin("a"));
    s.apply(mk("a", ev.Done, t(1), 2)); // new activity
    expect(s.list()[0].pinned).toBe(true);
    // And persists across a rebuild-from-log: replaying the same event
    // sequence through a fresh reducer reconstructs the pin.
    const replay = new Store();
    replay.apply(mk("a", ev.Busy, t(0), 1));
    replay.apply(ev.newPin("a"));
    replay.apply(mk("a", ev.Done, t(1), 2));
    expect(replay.list()[0].pinned).toBe(true);
  });

  test("hide drops a pin, then applies its normal rule", () => {
    // Pinned + not busy: hide unpins and hides.
    const s = new Store();
    s.apply(mk("a", ev.Done, t(0), 1));
    s.apply(ev.newPin("a"));
    const hide = ev.newHide("a");
    hide.ts = t(1);
    s.apply(hide);
    let row = s.list()[0];
    expect(row.pinned).toBeUndefined();
    expect(row.hidden).toBe(true);

    // Pinned + busy: hide unpins and downgrades to seen (stays visible).
    const s2 = new Store();
    s2.apply(mk("b", ev.Busy, t(0), 1));
    s2.apply(ev.newPin("b"));
    const hide2 = ev.newHide("b");
    hide2.ts = t(2);
    s2.apply(hide2);
    row = s2.list()[0];
    expect(row.pinned).toBeUndefined();
    expect(row.hidden).toBeUndefined();
    expect(row.acked).toBe(true);
  });

  test("ended removes a pinned session; a pin does not resurrect it", () => {
    const s = new Store();
    s.apply(mk("a", ev.Busy, t(0), 1));
    s.apply(ev.newPin("a"));
    s.apply(mk("a", ev.Ended, t(1), 2));
    expect(s.list().length).toBe(0);
  });

  test("an agent event cannot smuggle pinned onto a new session", () => {
    const s = new Store();
    const e = mk("a", ev.Busy, t(0), 1);
    e.pinned = true;
    s.apply(e);
    expect(s.list()[0].pinned).toBeUndefined();
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

  test("machine identity carries across omitting events", () => {
    const s = new Store();
    const busy = mk("a", ev.Busy, t(0), 1);
    busy.machine = "m-1";
    s.apply(busy);
    s.apply(mk("a", ev.Done, t(1), 2));
    expect(s.list()[0].machine).toBe("m-1");
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

describe("ask no-clobber", () => {
  // One blocked dialog can reach the hub twice: a rich attention
  // (permission_request/question, reply = the actual ask) and a bare
  // notification. The rich ask must survive either arrival order.
  test("a bare attention duplicate keeps the enriched reply and reason", () => {
    const s = new Store();
    s.apply({ ...mkReason("a", ev.Attention, "permission_request", t(1), 1), reply: "Bash: git push" });
    s.apply({ ...mkReason("a", ev.Attention, "notification", t(2), 2), reply: "Claude needs your permission" });
    const row = s.list()[0];
    expect(row.reply).toBe("Bash: git push");
    expect(row.reason).toBe("permission_request");
  });

  test("rich after bare replaces it", () => {
    const s = new Store();
    s.apply({ ...mkReason("a", ev.Attention, "notification", t(1), 1), reply: "Claude needs your permission" });
    s.apply({ ...mkReason("a", ev.Attention, "question", t(2), 2), reply: "Which colour? (Red / Blue)" });
    const row = s.list()[0];
    expect(row.reply).toBe("Which colour? (Red / Blue)");
    expect(row.reason).toBe("question");
  });

  test("a rich question is not clobbered by a bare twin either", () => {
    const s = new Store();
    s.apply({ ...mkReason("a", ev.Attention, "question", t(1), 1), reply: "Which colour? (Red / Blue)" });
    s.apply(mkReason("a", ev.Attention, "notification", t(2), 2));
    expect(s.list()[0].reply).toBe("Which colour? (Red / Blue)");
  });

  test("a non-attention event ends the ask - a later bare attention stands alone", () => {
    const s = new Store();
    s.apply({ ...mkReason("a", ev.Attention, "permission_request", t(1), 1), reply: "Bash: git push" });
    s.apply(mk("a", ev.Busy, t(2), 2));
    s.apply({ ...mkReason("a", ev.Attention, "notification", t(3), 3), reply: "Claude needs your permission" });
    const row = s.list()[0];
    expect(row.reason).toBe("notification");
    expect(row.reply).toBe("Claude needs your permission");
  });
});

describe("exchange history", () => {
  test("a full turn commits one exchange", () => {
    const s = new Store();
    s.apply(mkReason("a", ev.Busy, "session_start", t(0), 1));
    s.apply({ ...mk("a", ev.Busy, t(1), 2), prompt: "fix the bug" });
    s.apply({ ...mkReason("a", ev.Done, "stop", t(2), 3), reply: "fixed" });

    const history = s.exchanges("a", { limit: 10 });
    expect(history).toHaveLength(1);
    expect(history?.[0].prompt).toBe("fix the bug");
    expect(history?.[0].reply).toBe("fixed");
  });

  test("a later reply-only event amends the last committed exchange", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "p1" });
    s.apply({ ...mk("a", ev.Done, t(1), 2), reply: "r1-stale" });
    s.apply({ ...mkReason("a", ev.Done, "idle", t(2), 3), reply: "r1-final" });

    const history = s.exchanges("a", { limit: 10 });
    expect(history).toHaveLength(1);
    expect(history?.[0]).toMatchObject({ prompt: "p1", reply: "r1-final", seq: 2 });
  });

  test("a busy carrying prompt and reply heals the previous exchange", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "p1" });
    s.apply({ ...mk("a", ev.Done, t(1), 2), reply: "r1-stale" });
    s.apply({ ...mk("a", ev.Busy, t(2), 3), prompt: "p2", reply: "r1-final" });
    s.apply({ ...mk("a", ev.Done, t(3), 4), reply: "r2" });

    expect(s.exchanges("a", { limit: 10 })?.map((x) => ({ prompt: x.prompt, reply: x.reply }))).toEqual([
      { prompt: "p1", reply: "r1-final" },
      { prompt: "p2", reply: "r2" },
    ]);
  });

  test("a busy reply fills an open prompt-only pending before the new prompt displaces it", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "p1" });
    // No done ever arrived for p1 - the busy's reply must heal the OPEN
    // pending, not amend history, and displacement commits the healed pair.
    s.apply({ ...mk("a", ev.Busy, t(1), 2), prompt: "p2", reply: "r1-final" });
    s.apply({ ...mk("a", ev.Done, t(2), 3), reply: "r2" });

    expect(s.exchanges("a", { limit: 10 })?.map((x) => ({ prompt: x.prompt, reply: x.reply }))).toEqual([
      { prompt: "p1", reply: "r1-final" },
      { prompt: "p2", reply: "r2" },
    ]);
  });

  test("amend ORs cropped", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "p1" });
    s.apply({ ...mk("a", ev.Done, t(1), 2), reply: "r1" });
    s.apply({ ...mk("a", ev.Done, t(2), 3), reply: "r1", cropped: true });

    expect(s.exchanges("a", { limit: 10 })?.[0].cropped).toBe(true);
  });

  test("amend is idempotent", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "p1" });
    s.apply({ ...mk("a", ev.Done, t(1), 2), reply: "r1-stale" });
    const final = { ...mk("a", ev.Done, t(2), 3), reply: "r1-final" };
    s.apply(final);
    s.apply(final);

    const history = s.exchanges("a", { limit: 10 });
    expect(history).toHaveLength(1);
    expect(history?.[0].reply).toBe("r1-final");
  });

  test("attention still never amends", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "p1" });
    s.apply({ ...mk("a", ev.Done, t(1), 2), reply: "r1" });
    s.apply({ ...mk("a", ev.Attention, t(2), 3), reply: "ask-text" });

    expect(s.exchanges("a", { limit: 10 })?.[0].reply).toBe("r1");
  });

  test("reply-only with empty history still opens a pending", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Done, t(0), 1), reply: "old-reply" });
    s.apply({ ...mk("a", ev.Busy, t(1), 2), prompt: "p1" });
    s.apply({ ...mk("a", ev.Done, t(2), 3), reply: "r1" });

    expect(s.exchanges("a", { limit: 10 })?.map((x) => ({ prompt: x.prompt, reply: x.reply }))).toEqual([
      { prompt: undefined, reply: "old-reply" },
      { prompt: "p1", reply: "r1" },
    ]);
  });

  test("attention asks do not create history entries", () => {
    const s = new Store();
    s.apply(mkReason("a", ev.Busy, "session_start", t(0), 1));
    s.apply({ ...mk("a", ev.Busy, t(1), 2), prompt: "fix the bug" });
    s.apply({
      ...mkReason("a", ev.Attention, "permission_request", t(2), 3),
      reply: "Bash: git push",
    });
    s.apply(mkReason("a", ev.Attention, "notification", t(3), 4));
    s.apply({ ...mkReason("a", ev.Done, "stop", t(4), 5), reply: "fixed" });

    const history = s.exchanges("a", { limit: 10 });
    expect(history).toHaveLength(1);
    expect(history?.[0].reply).toBe("fixed");
  });

  test("an enriched ask with no pending never enters history", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "p1" });
    s.apply({ ...mk("a", ev.Done, t(1), 2), reply: "r1" });
    s.apply({
      ...mkReason("a", ev.Attention, "permission_request", t(2), 3),
      reply: "Bash: git push",
    });
    s.apply({ ...mk("a", ev.Busy, t(3), 4), prompt: "p2" });
    s.apply({ ...mk("a", ev.Done, t(4), 5), reply: "r2" });

    const history = s.exchanges("a", { limit: 10 });
    expect(history?.map((x) => ({ prompt: x.prompt, reply: x.reply }))).toEqual([
      { prompt: "p1", reply: "r1" },
      { prompt: "p2", reply: "r2" },
    ]);
    expect(JSON.stringify(history)).not.toContain("Bash: git push");
  });

  test("an abandoned ask does not commit ask text", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "p1" });
    s.apply({
      ...mkReason("a", ev.Attention, "permission_request", t(1), 2),
      reply: "Claude needs your permission",
    });
    s.apply({ ...mk("a", ev.Busy, t(2), 3), prompt: "p2" });
    s.apply({ ...mk("a", ev.Done, t(3), 4), reply: "r2" });

    const history = s.exchanges("a", { limit: 10 });
    expect(history?.map((x) => ({ prompt: x.prompt, reply: x.reply }))).toEqual([
      { prompt: "p1", reply: undefined },
      { prompt: "p2", reply: "r2" },
    ]);
    expect(JSON.stringify(history)).not.toContain("Claude needs your permission");
  });

  test("an error event closes a pending exchange", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "p" });
    s.apply({ ...mk("a", ev.Error, t(1), 2), reply: "boom" });

    expect(s.exchanges("a", { limit: 10 })?.map((x) => ({ prompt: x.prompt, reply: x.reply }))).toEqual([
      { prompt: "p", reply: "boom" },
    ]);
  });

  test("a returned exchange is a copy", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "p" });
    s.apply({ ...mk("a", ev.Done, t(1), 2), reply: "r" });

    const history = s.exchanges("a", { limit: 10 })!;
    history[0].reply = "changed";

    expect(s.exchanges("a", { limit: 10 })?.[0].reply).toBe("r");
  });

  test("a second prompt closes the previous exchange", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "a" });
    s.apply({ ...mk("a", ev.Busy, t(1), 2), prompt: "b" });
    s.apply({ ...mk("a", ev.Done, t(2), 3), reply: "R" });

    expect(s.exchanges("a", { limit: 10 })?.map((x) => ({ prompt: x.prompt, reply: x.reply }))).toEqual([
      { prompt: "a", reply: undefined },
      { prompt: "b", reply: "R" },
    ]);
  });

  test("carried breadcrumbs do not duplicate history", () => {
    const s = new Store();
    applyTurn(s, "a", 1);
    s.apply(mk("a", ev.Done, t(3), 3));

    expect(s.exchanges("a", { limit: 10 })).toHaveLength(1);
  });

  test("cropped rides along", () => {
    const s = new Store();
    s.apply({ ...mk("a", ev.Busy, t(0), 1), prompt: "fix the bug" });
    s.apply({ ...mk("a", ev.Done, t(1), 2), reply: "fixed", cropped: true });

    expect(s.exchanges("a", { limit: 10 })?.[0].cropped).toBe(true);
  });

  test("the ring evicts the oldest at the limit", () => {
    const s = new Store(3);
    for (let turn = 1; turn <= 5; turn++) applyTurn(s, "a", turn);

    expect(s.exchanges("a", { limit: 10 })?.map((x) => x.prompt)).toEqual([
      "prompt 3",
      "prompt 4",
      "prompt 5",
    ]);
  });

  test("exchanges returns the newest limit, oldest first", () => {
    const s = new Store();
    for (let turn = 1; turn <= 5; turn++) applyTurn(s, "a", turn);

    expect(s.exchanges("a", { limit: 2 })?.map((x) => x.prompt)).toEqual(["prompt 4", "prompt 5"]);
  });

  test("before pages backwards", () => {
    const s = new Store();
    for (let turn = 1; turn <= 5; turn++) applyTurn(s, "a", turn);
    const all = s.exchanges("a", { limit: 5 })!;

    expect(s.exchanges("a", { limit: 2, before: all[3].seq })?.map((x) => x.prompt)).toEqual([
      "prompt 2",
      "prompt 3",
    ]);
  });

  test("exchanges returns null for an unknown session", () => {
    expect(new Store().exchanges("ghost", { limit: 10 })).toBeNull();
  });

  test("ended clears history", () => {
    const s = new Store();
    applyTurn(s, "a", 1);
    s.apply(mk("a", ev.Ended, t(3), 3));
    s.apply(mk("a", ev.Busy, t(4), 4));

    expect(s.exchanges("a", { limit: 10 })).toEqual([]);
  });

  test("user actions never touch history", () => {
    const s = new Store();
    applyTurn(s, "a", 1);
    const before = s.exchanges("a", { limit: 10 });

    s.apply(ev.newSeen("a"));
    s.apply(ev.newPin("a"));
    s.apply(ev.newLabel("a", "named"));
    s.apply(ev.newTag("a", "work"));

    expect(s.exchanges("a", { limit: 10 })).toEqual(before);
  });

  test("/state is unchanged", () => {
    const s = new Store();
    applyTurn(s, "a", 1);
    const state = JSON.stringify(s.list());

    expect(state).not.toContain('"history"');
    expect(state).not.toContain('"exchanges"');
    expect(state).not.toContain('"pending"');
  });
});
