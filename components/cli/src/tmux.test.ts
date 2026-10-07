import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentOrigin } from "./tmux";

// These drive a real tmux server, so they only run where tmux exists. The
// macOS CI image ships without it, and a suite that throws in beforeAll fails
// as one unnamed test with no clue why.
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

// Driven against a REAL tmux server on a private socket. The bug these cover
// was invisible to a mocked tmux: the pane the hook runs in was perfectly
// valid, it just belonged to a different session's agent.
const socket = `/tmp/signalbox-tmux-test-${process.pid}`;
// realpath: macOS resolves /var/folders to /private/var/folders, and tmux
// reports the resolved path. A mismatch here would only lose a correction,
// never cause a wrong one, but the test must compare like with like.
const root = realpathSync(mkdtempSync(join(tmpdir(), "signalbox-panes-")));
const dirA = join(root, "project-a");
const dirB = join(root, "project-b");
const shared = join(root, "shared");

function tmux(...args: string[]): string {
  // -f /dev/null: the user's ~/.tmux.conf sets base-index, so hardcoding
  // window 0 would depend on whose machine this runs on.
  const out = spawnSync("tmux", ["-f", "/dev/null", "-S", socket, ...args]);
  return (out.stdout?.toString() ?? "").trim();
}

let paneA = "";
let paneB = "";
let sharedPanes: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const savedEnv = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };

beforeAll(() => {
  if (!hasTmux) return;
  for (const d of [dirA, dirB, shared]) mkdirSync(d, { recursive: true });
  tmux("new-session", "-d", "-s", "t", "-c", dirA);
  paneA = tmux("list-panes", "-t", "t:", "-F", "#{pane_id}");
  tmux("split-window", "-t", "t:", "-c", dirB);
  tmux("split-window", "-t", "t:", "-c", shared);
  tmux("split-window", "-t", "t:", "-c", shared);
  const panes = tmux("list-panes", "-t", "t:", "-F", "#{pane_id}\t#{pane_current_path}")
    .split("\n")
    .map((l) => l.split("\t"));
  paneA = panes.find((p) => p[1] === dirA)![0]!;
  paneB = panes.find((p) => p[1] === dirB)![0]!;
  sharedPanes = panes.filter((p) => p[1] === shared).map((p) => p[0]!);
  process.env.TMUX = `${socket},0,0`;
});

afterAll(() => {
  if (!hasTmux) return;
  tmux("kill-server");
  rmSync(root, { recursive: true, force: true });
  process.env.TMUX = savedEnv.TMUX;
  process.env.TMUX_PANE = savedEnv.TMUX_PANE;
});

describe.skipIf(!hasTmux)("currentOrigin pane resolution", () => {
  test("keeps TMUX_PANE when it already matches the agent's cwd", () => {
    process.env.TMUX_PANE = paneA;
    expect(currentOrigin(dirA)?.tmux?.pane).toBe(paneA);
  });

  // The Codex daemon case: hooks run under one long-lived `codex app-server`
  // whose TMUX_PANE is wherever it first started, so every session reported
  // that pane and jumping landed in the wrong one.
  test("corrects a pane that belongs to a shared daemon, not this session", () => {
    process.env.TMUX_PANE = paneA;
    expect(currentOrigin(dirB)?.tmux?.pane).toBe(paneB);
  });

  test("drops the origin when no pane sits at the cwd", () => {
    process.env.TMUX_PANE = paneA;
    expect(currentOrigin(join(root, "nowhere"))).toBeNull();
  });

  // Several agents in one directory cannot be told apart, so the least-wrong
  // answer is a pane in the right directory: right project, possibly the wrong
  // conversation. Dropping the origin instead would block jump entirely, which
  // is worse in practice.
  test("picks a pane at the cwd when several share it, and picks the same one twice", () => {
    process.env.TMUX_PANE = paneA;
    const first = currentOrigin(shared)?.tmux?.pane ?? "";
    expect(sharedPanes).toContain(first);
    expect(currentOrigin(shared)?.tmux?.pane).toBe(first);
  });

  test("an empty cwd disables correction entirely", () => {
    process.env.TMUX_PANE = paneA;
    expect(currentOrigin("")?.tmux?.pane).toBe(paneA);
  });

  test("returns null outside tmux", () => {
    const saved = process.env.TMUX;
    delete process.env.TMUX;
    expect(currentOrigin(dirB)).toBeNull();
    process.env.TMUX = saved;
  });
});
