import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexTreeWatcher, codexParent, readCodexParent } from "./sessiontree";
import { parseTurns, type TranscriptFile } from "./transcripts";
import { redact, validate, type Event } from "./event";
import { Store } from "./state";
import { mapClaudeHook } from "./claude";

const root = "11111111-1111-4111-8111-111111111111";
const parent = "22222222-2222-4222-8222-222222222222";
const child = "33333333-3333-4333-8333-333333333333";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function metadata(boundary: number | undefined = 1) {
  return { type: "session_meta", payload: { id: child, session_id: root, cwd: "/work/child", agent_nickname: "Worker",
    ...(boundary === undefined ? {} : { subagent_history_start_ordinal: boundary }),
    source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 2 } } } } };
}
function activity(type: string, turn = "turn-a") {
  return { type: "event_msg", timestamp: "2026-10-15T10:00:00.000Z", payload: { type, turn_id: turn, last_agent_message: "Verified the change." } };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "signalbox-tree-")); dirs.push(dir);
  const path = join(dir, `rollout-2026-10-15T10-00-00-${child}.jsonl`);
  const file: TranscriptFile = { path, agent: "codex", sessionUuid: child };
  const files: TranscriptFile[] = [];
  const emitted: Event[] = [];
  const watcher = new CodexTreeWatcher(async e => { emitted.push(e); }, () => files, dir);
  return { dir, path, file, files, emitted, watcher };
}
const lines = (...records: unknown[]) => records.map(r => JSON.stringify(r) + "\n").join("");

describe("deterministic session relationships", () => {
  test("grandchild identity and direct parent survive inherited session_id", () => {
    const x = fixture(); writeFileSync(x.path, lines(metadata(), { type: "session_meta", payload: { id: root, session_id: root, cwd: "/work/root" } }));
    expect(readCodexParent(x.path, child)).toMatchObject({ sessionKey: `codex:${child}`, parentKey: `codex:${parent}` });
    expect(parseTurns(x.path, "codex", 0)).toMatchObject({ sessionUuid: child, cwd: "/work/child" });
  });
  test("fork provenance, spoofed file identity, and self-parent do not create edges", () => {
    expect(codexParent({ type: "session_meta", payload: { id: child, forked_from_id: parent } }, child)).toBeUndefined();
    expect(codexParent(metadata(), root)).toBeUndefined();
    const m = metadata(); m.payload.source.subagent.thread_spawn.parent_thread_id = child;
    expect(codexParent(m, child)).toBeUndefined();
  });
  test("new worker excludes copied history and emits each complete live record once", async () => {
    const x = fixture(); x.watcher.baseline();
    writeFileSync(x.path, lines(metadata(3), activity("task_started", "ancestor"), activity("task_complete", "ancestor"), activity("task_started")));
    x.files.push(x.file); await x.watcher.sweep();
    expect(x.emitted.map(e => e.event)).toEqual(["busy"]);
    appendFileSync(x.path, JSON.stringify(activity("task_complete")));
    await x.watcher.sweep(); expect(x.emitted).toHaveLength(1);
    appendFileSync(x.path, "\n"); await x.watcher.sweep(); await x.watcher.sweep();
    expect(x.emitted.map(e => e.event)).toEqual(["busy", "done"]);
    expect(x.emitted[1]).toMatchObject({ parent_session_key: `codex:${parent}`, reply: "Verified the change." });
    expect(x.emitted.every(e => validate(e) === null)).toBe(true);
  });
  test("startup never imports old turns; later activity remains observable", async () => {
    const x = fixture(); writeFileSync(x.path, lines(metadata(), activity("task_complete", "old"))); x.files.push(x.file);
    x.watcher.baseline(); await x.watcher.sweep(); expect(x.emitted).toHaveLength(0);
    appendFileSync(x.path, lines(activity("task_started", "new"))); await x.watcher.sweep();
    expect(x.emitted).toHaveLength(1);
  });
  test("partial header is retried without losing the relationship", async () => {
    const x = fixture(); x.watcher.baseline(); writeFileSync(x.path, JSON.stringify(metadata())); x.files.push(x.file);
    await x.watcher.sweep(); expect(x.emitted).toHaveLength(0);
    appendFileSync(x.path, "\n" + lines(activity("task_started"))); await x.watcher.sweep(); expect(x.emitted).toHaveLength(1);
  });
  test("starting during a history copy still excludes inherited turns", async () => {
    const x = fixture(); writeFileSync(x.path, lines(metadata(4), activity("task_started", "ancestor"))); x.files.push(x.file);
    x.watcher.baseline();
    appendFileSync(x.path, lines(activity("task_complete", "ancestor"), { type: "session_meta", payload: { id: root } }, activity("task_started", "live")));
    await x.watcher.sweep();
    expect(x.emitted.map(e => e.event)).toEqual(["busy"]);
  });
  test("failed delivery retries without drifting the copy boundary or event identity", async () => {
    const x = fixture(); const attempts: Event[] = [];
    const watcher = new CodexTreeWatcher(async e => { attempts.push(e); if (attempts.length === 1) throw new Error("offline"); }, () => x.files, x.dir);
    writeFileSync(x.path, lines(metadata(3), activity("task_started", "ancestor"), activity("task_complete", "ancestor"), activity("task_started", "live")));
    x.files.push(x.file);
    await expect(watcher.sweep()).rejects.toThrow("offline");
    await watcher.sweep();
    expect(attempts).toHaveLength(2);
    expect(attempts[0].id).toBe(attempts[1].id);
  });
  test("unknown copy boundary fails closed rather than treating inherited turns as live", async () => {
    const x = fixture(); const m = metadata(); delete (m.payload as any).subagent_history_start_ordinal;
    writeFileSync(x.path, lines(m, activity("task_complete"))); x.files.push(x.file);
    await x.watcher.sweep(); expect(x.emitted).toHaveLength(0);
  });
  test("root and title-helper content cannot manufacture a parent", async () => {
    const x = fixture(); writeFileSync(x.path, lines({ type: "session_meta", payload: { id: child, source: "exec" } }, activity("task_complete")));
    x.files.push(x.file); await x.watcher.sweep(); expect(x.emitted).toHaveLength(0);
  });
  test("Claude worker lifecycle requires explicit agent identity", () => {
    expect(mapClaudeHook({ hook_event_name: "SubagentStart" })).toBeNull();
    expect(mapClaudeHook({ hook_event_name: "SubagentStart", agent_id: "worker" })?.eventType).toBe("busy");
    expect(mapClaudeHook({ hook_event_name: "SubagentStop", agent_id: "worker" })?.eventType).toBe("done");
  });
  test("redaction transforms both ends consistently and carries creation parent", async () => {
    const x = fixture(); writeFileSync(x.path, lines(metadata(), activity("task_started"))); x.files.push(x.file); await x.watcher.sweep();
    const e = x.emitted[0]; const p = { ...e, session_key: e.parent_session_key!, parent_session_key: undefined, parent_relation: undefined };
    await redact(e); await redact(p); expect(e.parent_session_key).toBe(p.session_key);
    const store = new Store(); store.apply(e);
    store.apply({ ...e, id: "next", event: "done", parent_session_key: "codex:other", parent_relation: "owned" });
    expect(store.list()[0].parent_session_key).toBe(p.session_key);
    expect(validate({ ...e, parent_session_key: e.session_key })).not.toBeNull();
  });
});
