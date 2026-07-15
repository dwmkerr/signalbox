// Process identity for the liveness sweep: a pid alone cannot prove
// identity (pids recycle), so capture and check both compare comm.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { Proc } from "./event";

// comm resolves a pid to its command name via `ps -o comm=`, trimmed to the
// basename (macOS reports the full executable path). Empty when the process
// cannot be resolved.
export function comm(pid: number): string {
  const out = spawnSync("ps", ["-o", "comm=", "-p", String(pid)]);
  if (out.status !== 0) return "";
  const s = (out.stdout?.toString() ?? "").trim();
  return s ? basename(s) : "";
}

// captureProc builds the Proc for a pid. Name stays empty when the process
// cannot be read - the event still fires and the sweep falls back to
// pid-only liveness.
export function captureProc(pid: number): Proc {
  const name = comm(pid);
  return name ? { pid, name } : { pid };
}

const shells = new Set(["bash", "sh", "zsh", "dash", "fish"]);

function parentOf(pid: number): number {
  const out = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)]);
  if (out.status !== 0) return 0;
  return parseInt((out.stdout?.toString() ?? "").trim(), 10) || 0;
}

// captureAgentProc walks up from pid past shell wrappers to the real agent.
// Hook commands run through a shell (Claude Code's sh -c, or a dispatcher
// script like agent-notify.sh), so the immediate parent is a transient bash
// that dies milliseconds later - capturing it makes the liveness sweep kill
// the session within a tick. Bounded walk so a genuinely shell-run agent
// (someone's bash-based script agent) cannot loop us to init.
export function captureAgentProc(pid: number): Proc {
  let current = pid;
  let name = comm(current);
  for (let hops = 0; hops < 4 && name && shells.has(name); hops++) {
    const parent = parentOf(current);
    if (parent <= 1) break;
    current = parent;
    name = comm(current);
  }
  return name ? { pid: current, name } : { pid: current };
}

// procAlive reports whether the captured process still exists as the same
// program. kill(pid, 0) probes existence; a live pid whose comm no longer
// matches is a recycled pid - the original process is dead.
export function procAlive(p: Proc): boolean {
  try {
    process.kill(p.pid, 0);
  } catch (err: any) {
    if (err?.code === "ESRCH") return false;
    // Only ESRCH proves death (EPERM means alive, just not ours). On
    // anything unexpected keep the session - a false "exited" is worse than
    // a stale spinner.
    if (err?.code !== "EPERM") return true;
  }
  if (!p.name) return true;
  return comm(p.pid) === p.name;
}
