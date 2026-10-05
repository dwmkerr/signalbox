// Delivery from hook-path commands. Must never block a calling agent: one
// short POST timeout, spool to disk on failure, drain opportunistically on
// the next invocation.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { Event, StateDoc } from "./event";
import { PermanentError, Spool } from "./spool";

export const DefaultURL = "http://127.0.0.1:8377";

const postTimeoutMs = 200;
// Drain bounds keep the hook path fast even with a large backlog.
const maxDrainEvents = 100;
const drainBudgetMs = 2000;

export function hubURL(): string {
  return process.env.SIGNALBOX_URL || DefaultURL;
}

// authHeaders attaches the bearer token when SIGNALBOX_TOKEN is set. A loopback
// hub ignores it; a non-loopback hub requires it. The token is never logged.
function authHeaders(): Record<string, string> {
  const token = process.env.SIGNALBOX_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function stateDir(): string {
  if (process.env.SIGNALBOX_DATA_DIR) return process.env.SIGNALBOX_DATA_DIR;
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

// ---- client ----------------------------------------------------------------

export class Client {
  private spoolFile: Spool;

  constructor(
    private url: string,
    private dir: string
  ) {
    this.spoolFile = new Spool(this.dir, "spool.jsonl", {}, (message) => this.logf(message));
  }

  logf(message: string): void {
    logTo(this.dir, message);
  }

  private async post(line: string): Promise<void> {
    const res = await fetch(`${this.url}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
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

  private spool(line: string): Promise<void> {
    return this.spoolFile.append(line);
  }

  // An event enters the durable queue before any POST. That ordering lets a
  // starting hub consume it on the pre-ready side of its spool boundary, or
  // lets this invocation deliver it normally once the listener is ready.
  async deliver(e: Event): Promise<void> {
    const line = JSON.stringify(e);
    try {
      await this.spool(line);
    } catch (err) {
      throw new Error(`event could not be spooled: ${err}`);
    }

    let delivered = false;
    try {
      await this.spoolFile.drain(async (candidate) => {
        await this.post(candidate);
        if (candidate === line) delivered = true;
      }, {
        maxEvents: maxDrainEvents,
        budgetMs: drainBudgetMs,
      });
    } catch (err) {
      throw new Error(`hub unreachable, event spooled: ${err}`);
    }

    if (delivered) return;
    // Another process may own the drain lock, or a bounded pass may have left
    // this newest line queued. A direct send keeps this event prompt; its id
    // makes a later at-least-once spool delivery harmless.
    try {
      await this.post(line);
    } catch (err) {
      throw new Error(`post failed, event spooled: ${err}`);
    }
  }

  // drain sends spooled events oldest-first, bounded by count and time.
  // Returns how many were delivered; throws the transient failure that
  // stopped it (remainder stays spooled). 4xx-rejected events are dropped so
  // a poisoned line cannot wedge the spool.
  async drain(): Promise<number> {
    return this.spoolFile.drain((line) => this.post(line), {
      maxEvents: maxDrainEvents,
      budgetMs: drainBudgetMs,
    });
  }
}

// fetchState GETs /state, returning both the decoded doc (order preserved)
// and the raw body for `state --json`.
export async function fetchState(
  url: string,
  timeoutMs: number
): Promise<{ doc: StateDoc; raw: string }> {
  const res = await fetch(`${url}/state`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`hub returned ${res.status}: ${raw.trim()}`);
  return { doc: JSON.parse(raw) as StateDoc, raw };
}
