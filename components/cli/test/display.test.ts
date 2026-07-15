import { describe, expect, test } from "bun:test";
import {
  glyph, coloredGlyph, tmuxStatusLine, titleOf, age, cropRunes, visibleWidth,
  dimOn, dimOff,
} from "../src/display";
import type { Event } from "../src/event";

function e(eventType: string, extra: Partial<Event> = {}): Event {
  return {
    v: 1, id: "x", ts: "2026-07-07T10:00:00Z", host: "h", agent: "claude",
    event: eventType, session_key: "claude:1", ...extra,
  };
}

describe("glyphs (amber scheme)", () => {
  test("marks per status; no ? suffix", () => {
    expect(glyph(e("busy"))).toBe("◌");
    expect(glyph(e("done"))).toBe("●");
    expect(glyph(e("attention"))).toBe("●");
    expect(glyph(e("error"))).toBe("✕");
    expect(glyph(e("done", { acked: true }))).toBe("·");
    expect(glyph(e("attention", { acked: true }))).toBe("·");
    // A running session keeps its spinner even after a seen.
    expect(glyph(e("busy", { acked: true }))).toBe("◌");
  });

  test("temperatures: amber ask, blue unread, red failed, dim rest", () => {
    expect(coloredGlyph(e("attention"))).toBe("\x1b[38;5;214m●\x1b[0m");
    expect(coloredGlyph(e("done"))).toBe("\x1b[34m●\x1b[0m");
    expect(coloredGlyph(e("error"))).toBe("\x1b[31m✕\x1b[0m");
    expect(coloredGlyph(e("busy"))).toBe(dimOn + "◌" + dimOff);
    expect(coloredGlyph(e("done", { acked: true }))).toBe(dimOn + "·" + dimOff);
  });
});

describe("tmuxStatusLine", () => {
  test("empty when nothing waits", () => {
    expect(tmuxStatusLine([])).toBe("");
    expect(tmuxStatusLine([e("busy")])).toBe("");
    expect(tmuxStatusLine([e("done", { acked: true })])).toBe("");
    expect(tmuxStatusLine([e("attention", { hidden: true })])).toBe("");
  });
  test("per-temperature counts, act first", () => {
    expect(tmuxStatusLine([e("done")])).toBe("#[fg=blue]● 1#[default]");
    expect(tmuxStatusLine([e("attention")])).toBe("#[fg=colour214]● 1#[default]");
    expect(tmuxStatusLine([e("error")])).toBe("#[fg=red]✕ 1#[default]");
    expect(tmuxStatusLine([e("done"), e("attention"), e("error")])).toBe(
      "#[fg=colour214]● 1#[default] #[fg=blue]● 1#[default] #[fg=red]✕ 1#[default]"
    );
  });
});

describe("titleOf", () => {
  test("label beats title beats cwd basename", () => {
    expect(titleOf(e("done", { title: "agent-title", cwd: "/x/repo" }))).toBe("agent-title");
    expect(titleOf(e("done", { label: "my label", title: "agent-title" }))).toBe("my label");
    expect(titleOf(e("done", { cwd: "/x/repo" }))).toBe("repo");
    expect(titleOf(e("done"))).toBe("-");
  });
});

describe("formatting", () => {
  test("age buckets", () => {
    const now = Date.parse("2026-07-07T10:01:00Z");
    expect(age("2026-07-07T10:00:30Z", now)).toBe("30s");
    expect(age("2026-07-07T09:31:00Z", now)).toBe("30m");
    expect(age("2026-07-07T04:01:00Z", now)).toBe("6h");
    expect(age("2026-07-01T10:01:00Z", now)).toBe("6d");
    expect(age("2026-07-07T10:02:00Z", now)).toBe("0s");
  });
  test("cropRunes marks the cut", () => {
    expect(cropRunes("hello", 10)).toBe("hello");
    expect(cropRunes("hello", 4)).toBe("hel…");
    expect(cropRunes("hello", 1)).toBe("…");
    expect(cropRunes("hello", 0)).toBe("");
  });
  test("visibleWidth skips ANSI", () => {
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth("\x1b[34m●\x1b[0m")).toBe(1);
    expect(visibleWidth(dimOn + "· x" + dimOff)).toBe(3);
  });
});
