// Delivery from hook-path commands. Must never block a calling agent: one
// short POST timeout, spool to disk on failure, drain opportunistically on
// the next invocation.

import {
  appendFileSync, mkdirSync, openSync, closeSync, unlinkSync, readFileSync,
  writeFileSync, renameSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { Event, StateDoc } from "./event";

export const DefaultURL = "http://127.0.0.1:8377";

const postTimeoutMs = 200;
// Drain bounds keep the hook path fast even with a large backlog.
const maxDrainEvents = 100;
const drainBudgetMs = 2000;

export function hubURL(): string {
  return process.env.SIGNALBOX_URL || DefaultURL;
}

export function stateDir(): string {
  if (process.env.SIGNALBOX_STATE_DIR) return process.env.SIGNALBOX_STATE_DIR;
  const home = homedir();
  if (!home) return join(tmpdir(), "signalbox");
  return join(home, ".local", "state", "signalbox");
}

// logTo appends to cli.log - the only place hook-path errors may go, because
// stdout/stderr noise could confuse the calling agent.
export function logTo(dir: string, message: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "cli.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging is best-effort by definition
  }
}

// ---- lock ------------------------------------------------------------------

// Spool access is serialised across concurrent hook invocations with an
// O_EXCL lockfile (Bun has no flock; the spike verified this pattern intact
// under 5-way contention). The holder's pid is written inside so a lock
// whose holder died can be broken instead of wedging every future hook.
function acquireLock(path: string, blocking: boolean): (() => void) | null {
  const deadline = Date.now() + (blocking ? 2000 : 0);
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {}
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") return null;
      // Stale lock: holder gone → break it and retry immediately.
      try {
        const holder = parseInt(readFileSync(path, "utf8"), 10);
        if (holder > 0) {
          try {
            process.kill(holder, 0);
          } catch (probeErr: any) {
            if (probeErr?.code === "ESRCH") {
              unlinkSync(path);
              continue;
            }
          }
        }
      } catch {}
      if (Date.now() >= deadline) return null;
      Bun.sleepSync(5);
    }
  }
}

// ---- client ----------------------------------------------------------------

// permanentError marks an HTTP 4xx: the hub saw the event and said no, so
// retrying forever would just wedge the spool.
class PermanentError extends Error {}

export class Client {
  constructor(
    private url: string,
    private dir: string
  ) {}

  logf(message: string): void {
    logTo(this.dir, message);
  }

  private spoolPath(): string {
    return join(this.dir, "spool.jsonl");
  }

  private async post(line: string): Promise<void> {
    const res = await fetch(`${this.url}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: line,
      signal: AbortSignal.timeout(postTimeoutMs),
    });
    const body = (await res.text()).slice(0, 4096).trim();
    if (res.ok) return;
    if (res.status >= 400 && res.status < 500) {
      throw new PermanentError(`hub rejected event: ${res.status}: ${body}`);
    }
    throw new Error(`hub returned ${res.status}`);
  }

  private spool(line: string): void {
    mkdirSync(this.dir, { recursive: true });
    // Block on the lock: appends are instant, and losing an event to a
    // concurrent drain's rewrite would defeat the spool's purpose.
    const unlock = acquireLock(this.spoolPath() + ".lock", true);
    try {
      appendFileSync(this.spoolPath(), line + "\n");
    } finally {
      unlock?.();
    }
  }

  // deliver drains the spool then posts e. A thrown error means the hub did
  // not receive the event now - it is spooled, so callers only log.
  async deliver(e: Event): Promise<void> {
    const line = JSON.stringify(e);
    let drainErr: unknown = null;
    try {
      await this.drain();
    } catch (err) {
      drainErr = err;
    }
    if (drainErr) {
      // The hub just refused a spooled event; a fresh POST would only burn
      // another timeout.
      this.spool(line);
      throw new Error(`hub unreachable, event spooled: ${drainErr}`);
    }
    try {
      await this.post(line);
    } catch (err) {
      this.spool(line);
      throw new Error(`post failed, event spooled: ${err}`);
    }
  }

  // drain sends spooled events oldest-first, bounded by count and time.
  // Returns how many were delivered; throws the transient failure that
  // stopped it (remainder stays spooled). 4xx-rejected events are dropped so
  // a poisoned line cannot wedge the spool.
  async drain(): Promise<number> {
    const spoolPath = this.spoolPath();
    const unlock = acquireLock(spoolPath + ".lock", false);
    // Another invocation is already draining; ours is not needed.
    if (!unlock) return 0;
    try {
      if (!existsSync(spoolPath)) return 0;
      const lines = readFileSync(spoolPath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) {
        try {
          unlinkSync(spoolPath);
        } catch {}
        return 0;
      }

      const deadline = Date.now() + drainBudgetMs;
      const kept: string[] = [];
      let sent = 0;
      let attempts = 0;
      let stopErr: unknown = null;
      for (const line of lines) {
        if (stopErr || attempts >= maxDrainEvents || Date.now() > deadline) {
          kept.push(line);
          continue;
        }
        attempts++;
        try {
          await this.post(line);
          sent++;
        } catch (err) {
          if (err instanceof PermanentError) {
            this.logf(`drain: dropping event rejected by hub: ${err.message}`);
            continue;
          }
          stopErr = err;
          kept.push(line);
        }
      }

      if (kept.length === 0) {
        try {
          unlinkSync(spoolPath);
        } catch {}
        if (stopErr) throw stopErr;
        return sent;
      }
      // Rewrite via rename so a crash mid-drain can never lose the remainder.
      const tmp = spoolPath + ".tmp";
      writeFileSync(tmp, kept.join("\n") + "\n");
      renameSync(tmp, spoolPath);
      if (stopErr) throw stopErr;
      return sent;
    } finally {
      unlock();
    }
  }
}

// fetchState GETs /state, returning both the decoded doc (order preserved)
// and the raw body for `state --json`.
export async function fetchState(
  url: string,
  timeoutMs: number
): Promise<{ doc: StateDoc; raw: string }> {
  const res = await fetch(`${url}/state`, { signal: AbortSignal.timeout(timeoutMs) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`hub returned ${res.status}: ${raw.trim()}`);
  return { doc: JSON.parse(raw) as StateDoc, raw };
}
