import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

const lockWaitMs = 2000;
const lockRetryMs = 5;
const staleLockAgeMs = 30_000;

type Unlock = () => void;

class LockAcquisitionError extends Error {}

interface DrainSnapshot {
  lines: string[];
}

// Spool access is serialised across concurrent hook invocations with an
// O_EXCL lockfile (Bun has no flock; the spike verified this pattern intact
// under 5-way contention). Acquisition itself never waits: callers that need
// to retry do so asynchronously so a forwarder's event loop remains runnable.
export function acquireLock(path: string): Unlock | null {
  for (;;) {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      // The holder's pid lets a later process recover after a crashed writer.
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
      try {
        // A crashed writer can leave an empty or unreadable lock behind, and
        // its lock must not outlive it forever. Spool-file locks cover only
        // brief synchronous transactions, never network I/O, so 30 seconds is
        // far beyond a legitimate hold.
        if (Date.now() - statSync(path).mtime.getTime() > staleLockAgeMs) {
          unlinkSync(path);
          continue;
        }
      } catch {}
      return null;
    }

    const token = `${process.pid}:${randomUUID()}`;
    try {
      writeFileSync(fd, token);
    } catch (err) {
      try {
        unlinkSync(path);
      } catch {}
      throw err;
    } finally {
      closeSync(fd);
    }
    return () => {
      try {
        // A stale-lock recovery must not let an old owner unlink a new lock.
        if (readFileSync(path, "utf8") === token) unlinkSync(path);
      } catch {}
    };
  }
}

async function withLock(path: string, operation: () => void): Promise<void> {
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    let unlock: Unlock | null;
    try {
      unlock = acquireLock(path);
    } catch (err) {
      throw new LockAcquisitionError(String(err), { cause: err });
    }
    if (unlock) {
      try {
        operation();
        return;
      } finally {
        unlock();
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new LockAcquisitionError(`timed out after ${lockWaitMs} ms`);
    await Bun.sleep(Math.min(lockRetryMs, remaining));
  }
}

async function waitForLock(path: string): Promise<Unlock> {
  for (;;) {
    try {
      const unlock = acquireLock(path);
      if (unlock) return unlock;
    } catch (err) {
      throw new LockAcquisitionError(String(err), { cause: err });
    }
    // This delay only yields between condition checks. Acquiring the lock, not
    // elapsed time, is what permits startup to continue.
    await Bun.sleep(lockRetryMs);
  }
}

// permanentError marks an HTTP 4xx: the hub saw the event and said no, so
// retrying forever would just wedge the spool.
export class PermanentError extends Error {}

export interface SpoolBounds {
  // Both default to Infinity: the hook-path spool is unbounded exactly as
  // it is today, and only the forwarder opts into a ring.
  maxEvents?: number;
  maxBytes?: number;
}

// Upstream delivery is at-least-once: a crash after a successful send but
// before reconciliation can resend that event on the next drain. Events have
// unique ids and the reducer is last-write-wins, so duplicate delivery is safe.
export class Spool {
  private readonly spoolPath: string;
  private readonly lockPath: string;
  private readonly drainLockPath: string;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  // The forwarder is the only long-lived writer of its spool, so an in-process
  // count is accurate there and avoids re-reading a 16 MiB file on each append.
  private lineCount: number | null = null;
  private overflowLogged = false;
  private draining = false;

  constructor(
    private dir: string,
    fileName: string,
    bounds: SpoolBounds = {},
    private log: (message: string) => void = () => {}
  ) {
    this.spoolPath = join(dir, fileName);
    this.lockPath = this.spoolPath + ".lock";
    this.drainLockPath = this.spoolPath + ".drain.lock";
    this.maxEvents = bounds.maxEvents ?? Infinity;
    this.maxBytes = bounds.maxBytes ?? Infinity;
  }

  path(): string {
    return this.spoolPath;
  }

  async append(line: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    try {
      // The retry yields to an in-flight network request instead of freezing
      // the event loop while another short filesystem transaction completes.
      await withLock(this.lockPath, () => {
        const bounded = Number.isFinite(this.maxEvents) || Number.isFinite(this.maxBytes);
        if (bounded) this.loadCount();
        appendFileSync(this.spoolPath, line + "\n");
        if (this.lineCount !== null) this.lineCount++;
        // Keep appends as a suffix of the drain's snapshot until reconciliation.
        // The final rewrite enforces the bounds after removing processed lines.
        if (bounded && !this.draining) this.enforceBounds();
      });
    } catch (err) {
      if (!(err instanceof LockAcquisitionError)) throw err;
      const message = `append: failed to acquire spool lock: ${String(err)}`;
      try {
        this.log(message);
      } catch {}
      throw new Error(message, { cause: err });
    }
  }

  count(): number {
    this.loadCount();
    return this.lineCount ?? 0;
  }

  // drain holds the drain lock across every snapshot send and reconcile, so
  // only one process drains this spool. It does not hold the append lock while
  // awaiting a send; appended events remain a suffix until reconciliation.
  async drain(
    send: (line: string) => Promise<void>,
    opts: { maxEvents: number; budgetMs: number }
  ): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let unlockDrain: Unlock | null = null;

    try {
      mkdirSync(this.dir, { recursive: true });
      unlockDrain = acquireLock(this.drainLockPath);
      if (!unlockDrain) return 0;

      const deadline = Date.now() + opts.budgetMs;
      let attempts = 0;
      let sent = 0;
      while (attempts < opts.maxEvents && Date.now() <= deadline) {
        const snapshot = this.takeSnapshot();
        if (!snapshot) return sent;

        let index = 0;
        let stopErr: unknown = null;
        for (; index < snapshot.lines.length; index++) {
          if (attempts >= opts.maxEvents || Date.now() > deadline) break;
          attempts++;
          try {
            await send(snapshot.lines[index]);
            sent++;
          } catch (err) {
            if (err instanceof PermanentError) {
              this.log(`drain: dropping event rejected by hub: ${err.message}`);
              continue;
            }
            stopErr = err;
            break;
          }
        }

        await this.reconcileSnapshot(snapshot.lines, index);
        if (stopErr) throw stopErr;
        if (index < snapshot.lines.length) return sent;
      }
      return sent;
    } finally {
      unlockDrain?.();
      this.draining = false;
    }
  }

  // Startup has a stronger contract than the latency-bounded hook drain: it
  // consumes every queued line, then crosses the readiness boundary while the
  // append lock excludes a writer from appearing between "empty" and ready.
  async drainBeforeReady(
    send: (line: string) => Promise<void>,
    onReady: () => void,
    beforeReady: () => Promise<void> = async () => {}
  ): Promise<number> {
    if (this.draining) throw new Error("spool is already draining");
    this.draining = true;
    let unlockDrain: Unlock | null = null;

    try {
      mkdirSync(this.dir, { recursive: true });
      unlockDrain = await waitForLock(this.drainLockPath);
      let sent = 0;

      for (;;) {
        const snapshot = this.takeSnapshot();
        if (snapshot && snapshot.lines.length > 0) {
          let index = 0;
          let stopErr: unknown = null;
          for (; index < snapshot.lines.length; index++) {
            try {
              await send(snapshot.lines[index]);
              sent++;
            } catch (err) {
              if (err instanceof PermanentError) {
                this.log(`drain: dropping event rejected by hub: ${err.message}`);
                continue;
              }
              stopErr = err;
              break;
            }
          }

          await this.reconcileSnapshot(snapshot.lines, index);
          if (stopErr) throw stopErr;
          continue;
        }

        // A forwarder uses this phase to finish its upstream replay and flush
        // the outbound queue. Appends remain available while it waits, then
        // the locked recheck below decides whether another pass is required.
        await beforeReady();

        const unlockAppend = await waitForLock(this.lockPath);
        try {
          const lines = existsSync(this.spoolPath) ? this.readLines() : [];
          if (lines.length > 0) {
            this.lineCount = lines.length;
            continue;
          }
          this.unlinkIfExists(this.spoolPath);
          this.lineCount = 0;
          this.resetOverflowLog();

          // A hook that appends before posting waits on the append lock here.
          // Releasing the drain lock first lets that hook own normal delivery
          // immediately after the synchronous listener bind in onReady.
          unlockDrain();
          unlockDrain = null;
          onReady();
          return sent;
        } finally {
          unlockAppend();
        }
      }
    } finally {
      unlockDrain?.();
      this.draining = false;
    }
  }

  private takeSnapshot(): DrainSnapshot | null {
    if (!existsSync(this.dir)) return null;
    const unlock = acquireLock(this.lockPath);
    // Another invocation is appending; its next scheduled drain will make the
    // spool useful again.
    if (!unlock) return null;
    try {
      if (!existsSync(this.spoolPath)) {
        this.lineCount = 0;
        this.resetOverflowLog();
        return null;
      }
      const lines = this.readLines();
      this.lineCount = lines.length;
      this.resetOverflowLog();
      return { lines };
    } finally {
      unlock();
    }
  }

  private async reconcileSnapshot(snapshot: string[], processed: number): Promise<void> {
    await withLock(this.lockPath, () => {
      const current = existsSync(this.spoolPath) ? this.readLines() : [];
      const appended = current.slice(snapshot.length);
      const remainder = [...snapshot.slice(processed), ...appended];
      if (remainder.length === 0) {
        this.unlinkIfExists(this.spoolPath);
      } else {
        const tmp = this.spoolPath + ".tmp";
        this.writeLines(tmp, remainder);
        renameSync(tmp, this.spoolPath);
      }
      this.lineCount = remainder.length;
      const bounded = Number.isFinite(this.maxEvents) || Number.isFinite(this.maxBytes);
      if (bounded && remainder.length > 0) this.enforceBounds();
      this.resetOverflowLog();
    });
  }

  private loadCount(): void {
    if (this.lineCount !== null) return;
    this.lineCount = existsSync(this.spoolPath) ? this.readLines(this.spoolPath).length : 0;
  }

  private readLines(path = this.spoolPath): string[] {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private writeLines(path: string, lines: string[]): void {
    writeFileSync(path, lines.length > 0 ? lines.join("\n") + "\n" : "");
  }

  private unlinkIfExists(path: string): void {
    try {
      unlinkSync(path);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  private enforceBounds(): void {
    const size = statSync(this.spoolPath).size;
    if ((this.lineCount ?? 0) <= this.maxEvents && size <= this.maxBytes) return;

    const lines = this.readLines();
    let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
    let dropped = 0;
    while (lines.length > this.maxEvents || bytes > this.maxBytes) {
      const line = lines.shift();
      if (line === undefined) break;
      bytes -= Buffer.byteLength(line) + 1;
      dropped++;
    }

    const tmp = this.spoolPath + ".tmp";
    this.writeLines(tmp, lines);
    renameSync(tmp, this.spoolPath);
    this.lineCount = lines.length;

    // A stale board is worth less than a fresh one, and the upstream hub's
    // own events.jsonl remains the durable record. Log once per full episode
    // so a disconnected forwarder does not flood its log on every append.
    if (!this.overflowLogged) {
      const name = basename(this.spoolPath).replace(/\.jsonl$/, "").replaceAll("-", " ");
      this.log(`${name} full (${this.boundsLabel()}): dropped ${dropped} oldest events`);
      this.overflowLogged = true;
    }
  }

  private boundsLabel(): string {
    const bounds: string[] = [];
    if (Number.isFinite(this.maxEvents)) bounds.push(`${this.maxEvents} events`);
    if (Number.isFinite(this.maxBytes)) bounds.push(`${this.formatBytes(this.maxBytes)} cap`);
    return bounds.join(", ");
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
    if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
    return `${bytes} B`;
  }

  private resetOverflowLog(): void {
    const size = existsSync(this.spoolPath) ? statSync(this.spoolPath).size : 0;
    if ((this.lineCount ?? 0) < this.maxEvents && size < this.maxBytes) {
      this.overflowLogged = false;
    }
  }
}
