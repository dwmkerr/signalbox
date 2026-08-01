import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, PermanentError, Spool } from "../src/spool";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sbspool-"));
}

function contents(spool: Spool): string[] {
  return readFileSync(spool.path(), "utf8").trim().split("\n");
}

describe("Spool", () => {
  test("appends and drains oldest-first", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl");
    await spool.append("one");
    await spool.append("two");
    await spool.append("three");
    const sent: string[] = [];

    const delivered = await spool.drain(async (line) => {
      sent.push(line);
    }, { maxEvents: 100, budgetMs: 2000 });

    expect(delivered).toBe(3);
    expect(sent).toEqual(["one", "two", "three"]);
    expect(existsSync(spool.path())).toBe(false);
  });

  test("only one Spool instance drains a shared spool at a time", async () => {
    const dir = tempDir();
    const first = new Spool(dir, "spool.jsonl");
    const second = new Spool(dir, "spool.jsonl");
    await first.append("one");
    let sendStarted!: () => void;
    let finishSend!: () => void;
    const started = new Promise<void>((resolve) => { sendStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishSend = resolve; });

    const firstDrain = first.drain(async () => {
      sendStarted();
      await finish;
    }, { maxEvents: 100, budgetMs: 2000 });

    await started;
    let secondCalled = false;
    try {
      const delivered = await second.drain(async () => {
        secondCalled = true;
      }, { maxEvents: 100, budgetMs: 2000 });

      expect(delivered).toBe(0);
      expect(secondCalled).toBe(false);
    } finally {
      finishSend();
      await firstDrain;
    }
  });

  test("preserves FIFO when another instance appends during a slow drain", async () => {
    const dir = tempDir();
    const drainer = new Spool(dir, "spool.jsonl");
    const appender = new Spool(dir, "spool.jsonl");
    await drainer.append("one");
    await drainer.append("two");
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => { sendStarted = resolve; });
    const sent: string[] = [];

    const draining = drainer.drain(async (line) => {
      sent.push(line);
      if (line === "one") sendStarted();
      await Bun.sleep(50);
    }, { maxEvents: 2, budgetMs: 2000 });

    await started;
    await appender.append("new");
    expect(await draining).toBe(2);

    const remaining = existsSync(drainer.path()) ? contents(drainer) : [];
    expect(sent.includes("new") || remaining.includes("new")).toBe(true);
    expect([...sent, ...remaining]).toEqual(["one", "two", "new"]);
  });

  test("keeps the remainder in order after a transient failure", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl");
    await spool.append("one");
    await spool.append("two");
    await spool.append("three");

    await expect(spool.drain(async (line) => {
      if (line === "two") throw new Error("offline");
    }, { maxEvents: 100, budgetMs: 2000 })).rejects.toThrow("offline");

    expect(contents(spool)).toEqual(["two", "three"]);
  });

  test("keeps an in-flight append behind a transient remainder", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl");
    await spool.append("one");
    await spool.append("two");
    let sendStarted!: () => void;
    let finishSend!: () => void;
    const started = new Promise<void>((resolve) => { sendStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishSend = resolve; });

    const draining = spool.drain(async (line) => {
      if (line === "one") {
        sendStarted();
        await finish;
      }
      if (line === "two") throw new Error("offline");
    }, { maxEvents: 100, budgetMs: 2000 });

    await started;
    await spool.append("new");
    finishSend();
    await expect(draining).rejects.toThrow("offline");

    expect(contents(spool)).toEqual(["two", "new"]);
  });

  test("continues with events appended during a successful send", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl");
    await spool.append("one");
    let sendStarted!: () => void;
    let finishSend!: () => void;
    const started = new Promise<void>((resolve) => { sendStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishSend = resolve; });
    const sent: string[] = [];

    const draining = spool.drain(async (line) => {
      sent.push(line);
      if (line === "one") {
        sendStarted();
        await finish;
      }
    }, { maxEvents: 100, budgetMs: 2000 });

    await started;
    await spool.append("two");
    finishSend();

    expect(await draining).toBe(2);
    expect(sent).toEqual(["one", "two"]);
    expect(existsSync(spool.path())).toBe(false);
  });

  test("drops a permanently rejected line and continues", async () => {
    const logs: string[] = [];
    const spool = new Spool(tempDir(), "spool.jsonl", {}, (message) => logs.push(message));
    await spool.append("one");
    await spool.append("poison");
    await spool.append("three");
    const sent: string[] = [];

    const delivered = await spool.drain(async (line) => {
      if (line === "poison") throw new PermanentError("no");
      sent.push(line);
    }, { maxEvents: 100, budgetMs: 2000 });

    expect(delivered).toBe(2);
    expect(sent).toEqual(["one", "three"]);
    expect(existsSync(spool.path())).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test("maxEvents drops the oldest lines", async () => {
    const logs: string[] = [];
    const spool = new Spool(
      tempDir(),
      "forward-spool.jsonl",
      { maxEvents: 3 },
      (message) => logs.push(message)
    );

    for (const line of ["one", "two", "three", "four", "five"]) await spool.append(line);

    expect(contents(spool)).toEqual(["three", "four", "five"]);
    expect(logs).toHaveLength(1);
  });

  test("maxBytes drops oldest lines and preserves the newest", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl", { maxBytes: 12 });
    await spool.append("old");
    await spool.append("middle");
    await spool.append("newest");

    expect(contents(spool)).toEqual(["newest"]);
  });

  test("count reports an absent and live spool", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl");
    expect(spool.count()).toBe(0);

    await spool.append("one");
    await spool.append("two");

    expect(spool.count()).toBe(2);
  });

  test("append yields while waiting for the lock", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl");
    const unlock = acquireLock(spool.path() + ".lock");
    expect(unlock).not.toBeNull();
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
      unlock!();
    }, 10);

    await spool.append("one");

    expect(timerFired).toBe(true);
    expect(contents(spool)).toEqual(["one"]);
  });

  test("recovers an old empty append lock", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl");
    const lockPath = spool.path() + ".lock";
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 31_000);
    utimesSync(lockPath, old, old);

    await spool.append("one");

    expect(contents(spool)).toEqual(["one"]);
  });

  test("a held drain lock makes drain return without blocking", async () => {
    const spool = new Spool(tempDir(), "spool.jsonl");
    await spool.append("one");
    const unlock = acquireLock(spool.path() + ".drain.lock");
    expect(unlock).not.toBeNull();
    let called = false;

    try {
      const delivered = await spool.drain(async () => {
        called = true;
      }, { maxEvents: 100, budgetMs: 2000 });

      expect(delivered).toBe(0);
      expect(called).toBe(false);
    } finally {
      unlock!();
    }
  });
});
