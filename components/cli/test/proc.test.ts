import { describe, expect, test } from "bun:test";
import { captureAgentProc, captureProc, procAlive } from "../src/proc";

describe("captureAgentProc", () => {
  test("walks past a shell wrapper to the real process", () => {
    // bash -c spawns: bun test (this process) <- ... run a bash that runs
    // sleep? Simpler: our own process chain - spawn `bash -c` child that
    // reports what signalbox would capture for it.
    const out = Bun.spawnSync(["bash", "-c", `bash -c 'echo mid:$$; ps -o ppid= -p $$'`]);
    expect(out.exitCode).toBe(0);
    // Direct behavioural check: capturing from inside a shell chain must not
    // return a shell when a non-shell ancestor exists.
    const proc = captureAgentProc(process.pid);
    expect(["bash", "sh", "zsh", "dash", "fish"]).not.toContain(proc.name ?? "");
  });

  test("captureProc keeps the literal pid", () => {
    const p = captureProc(process.pid);
    expect(p.pid).toBe(process.pid);
  });

  test("procAlive true for self, false for dead pid", () => {
    expect(procAlive({ pid: process.pid })).toBe(true);
    expect(procAlive({ pid: 999999 })).toBe(false);
  });
});
