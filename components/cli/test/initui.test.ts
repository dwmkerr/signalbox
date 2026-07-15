import { describe, expect, test } from "bun:test";
import { renderStatus, type Component } from "../src/initui";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const comps = (tmuxDone: boolean): Component[] => [
  { id: "app", category: "signalbox", label: "Menu bar app", info: "",
    done: "Menu bar app installed", miss: "not built", configured: true, path: "/x/App" },
  { id: "opencode", category: "Integrations", label: "OpenCode", info: "",
    done: "OpenCode plugin installed", miss: "not set up", configured: true },
  { id: "claude", category: "Integrations", label: "Claude Code", info: "",
    done: "Claude Code hooks active", miss: "hooks not set up", configured: true },
  { id: "tmux", category: "Integrations", label: "tmux", info: "",
    done: "tmux integration active", miss: "not set up - events won't fire",
    configured: tmuxDone, note: "not configured" },
];

describe("renderStatus", () => {
  test("welcome banner over a dotted, status-marked list", () => {
    const out = strip(renderStatus(comps(false), false));
    expect(out).toContain("Welcome to signalbox");
    expect(out).toContain("signalbox");
    expect(out).toContain("Integrations");
    // configured reads as a status with a filled dot
    expect(out).toContain("● Menu bar app installed");
    // missing shows the label plus what breaks
    expect(out).toContain("○ tmux");
    expect(out).toContain("events won't fire");
  });

  test("summarises what is left with the right flag", () => {
    const out = strip(renderStatus(comps(false), false));
    expect(out).toContain("1 to set up");
    expect(out).toContain("signalbox init --tmux");
  });

  test("all configured reads Everything is set up", () => {
    const out = strip(renderStatus(comps(true), false));
    expect(out).toContain("Everything is set up.");
    expect(out).not.toContain("to set up ·");
  });

  test("verbose shows paths", () => {
    expect(strip(renderStatus(comps(false), true))).toContain("/x/App");
    expect(strip(renderStatus(comps(false), false))).not.toContain("/x/App");
  });
});
