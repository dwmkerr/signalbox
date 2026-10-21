import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatBroker, ChatExecutor, chatResult } from "./chat";
import { validateCommand, type Command } from "./command";
import { machineID, type Event } from "./event";
import { ownsChatPane, emptyChatInput, isInteractiveCodexTranscript, sendTmuxChat, type ChatProcess } from "./tmuxchat";
import { Hub, listen } from "./hub";
import { Forwarder } from "./forwarder";

const directories: string[] = [];
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "signalbox-chat-"));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function command(machine = "machine-a", extra: Partial<Command> = {}): Command {
  return { v: 1, id: crypto.randomUUID(), ts: new Date().toISOString(), command: "chat", session_key: "claude:session-a", target_host: "mac", target_machine: machine, text: "Explain the change", ...extra };
}
function session(machine: string, extra: Partial<Event> = {}): Event {
  return { v: 1, id: crypto.randomUUID(), ts: new Date().toISOString(), host: "mac", machine, agent: "claude", event: "done", session_key: "claude:session-a", ...extra };
}

describe("mobile chat validation and delivery", () => {
  test("accepts Unicode and multiline text, rejects empty, oversized and control input", () => {
    expect(validateCommand(command("m", { text: "Hello 👋\nCheck `code` and $HOME literally\tplease" }))).toBeNull();
    for (const text of [" ", "x".repeat(8193), "hello\x1b[31m", "\x03"]) expect(validateCommand(command("m", { text }))).not.toBeNull();
    expect(validateCommand(command(""))).not.toBeNull();
    expect(validateCommand(command("m", { id: "../../receipt" }))).not.toBeNull();
    expect(validateCommand(null as any)).not.toBeNull();
  });

  test("durable receipts prevent duplicates after an executor restart and keep text out of receipts", async () => {
    const dir = directory(), machine = machineID(dir), event = session(machine), c = command(machine);
    let sent = 0;
    const send = async () => { sent++; return { status: "sent" as const, message: "Sent to terminal" }; };
    const first = new ChatExecutor(dir, () => [event], send);
    expect((await first.execute(c))?.status).toBe("sent");
    const restarted = new ChatExecutor(dir, () => [event], send);
    expect((await restarted.execute(c))?.status).toBe("sent");
    expect(sent).toBe(1);
    expect(readFileSync(join(dir, "chat-receipts", c.id + ".json"), "utf8")).not.toContain(c.text!);
    expect((await restarted.execute({ ...c, text: "different" }))?.status).toBe("failed");
    expect(sent).toBe(1);
  });

  test("wrong machine, stale command and stale host cannot send", async () => {
    const dir = directory(), machine = machineID(dir);
    let sent = 0;
    const executor = new ChatExecutor(dir, () => [session(machine)], async () => { sent++; return { status: "sent", message: "sent" }; });
    expect(await executor.execute(command("another-machine"))).toBeNull();
    expect((await executor.execute(command(machine, { ts: new Date(Date.now() - 20_000).toISOString() })))?.status).toBe("failed");
    expect((await executor.execute(command(machine, { target_host: "another-host" })))?.status).toBe("failed");
    expect(sent).toBe(0);
  });

  test("simultaneous sends serialize by session and an incomplete receipt is never retried", async () => {
    const dir = directory(), machine = machineID(dir), c = command(machine);
    let finish!: () => void;
    const executor = new ChatExecutor(dir, () => [session(machine)], async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: "sent", message: "sent" };
    });
    const first = executor.execute(c);
    expect((await executor.execute(c))?.status).toBe("unknown");
    expect((await executor.execute(command(machine)))?.status).toBe("failed");
    finish();
    expect((await first)?.status).toBe("sent");
  });

  test("unsupported, stopped, busy and permission targets fail before using tmux", async () => {
    for (const extra of [{}, { event: "busy" }, { event: "attention" }, { reason: "exited" }, { parent_session_key: "claude:parent" }, { agent: "github" }]) {
      expect((await sendTmuxChat(session("machine", extra), "hello")).status).toBe("failed");
    }
  });
});

describe("tmux process identity", () => {
  test("only an interactive transcript for the exact Codex thread can bind input", () => {
    const path = join(directory(), "rollout.jsonl");
    const meta = { type: "session_meta", payload: { id: "thread", source: "cli", originator: "codex-tui" } };
    writeFileSync(path, JSON.stringify(meta) + "\n{partial");
    expect(isInteractiveCodexTranscript(path, "thread")).toBe(true);
    expect(isInteractiveCodexTranscript(path, "internal-title-thread")).toBe(false);
    expect(isInteractiveCodexTranscript(path + ".missing", "thread")).toBe(false);
    writeFileSync(path, JSON.stringify({ ...meta, payload: { ...meta.payload, source: "exec" } }));
    expect(isInteractiveCodexTranscript(path, "thread")).toBe(false);
  });
  test("input must be empty at the live cursor, with no continuation draft or dialog", () => {
    expect(emptyChatInput("claude", "old output\n❯\u00a0\n────", 2, 1)).toBe(true);
    expect(emptyChatInput("vscode/claude", "❯ \n────", 2, 0)).toBe(true);
    expect(emptyChatInput("codex", "› Ask Codex to do anything\n\n status", 2, 0)).toBe(true);
    for (const screen of ["❯ draft\n────", "❯ \n  second line\n────", "❯ \n────\nYes or no?"]) {
      expect(emptyChatInput("claude", screen, 2, screen.includes("Yes") ? 2 : 0)).toBe(false);
    }
    expect(emptyChatInput("codex", "› unfinished draft\n", 2, 0)).toBe(false);
    expect(emptyChatInput("codex", "› Ask Codex to do anything\n", 20, 0)).toBe(false);
  });
  const processes: ChatProcess[] = [
    { pid: 10, parent: 1, group: 10, foreground: 20, name: "zsh" },
    { pid: 20, parent: 10, group: 20, foreground: 20, name: "codex" },
    { pid: 30, parent: 20, group: 20, foreground: 20, name: "codex" },
    { pid: 40, parent: 1, group: 40, foreground: 0, name: "codex" },
  ];
  test("accepts the pane's foreground agent and its embedded server", () => {
    expect(ownsChatPane(processes, 10, 20, "codex")).toBe(true);
    expect(ownsChatPane(processes, 10, 30, "codex")).toBe(true);
  });
  test("rejects a shared daemon, another pane, dead or recycled PID, and a background job", () => {
    expect(ownsChatPane(processes, 10, 40, "codex")).toBe(false);
    expect(ownsChatPane(processes, 99, 20, "codex")).toBe(false);
    expect(ownsChatPane(processes, 10, 999, "codex")).toBe(false);
    expect(ownsChatPane(processes, 10, 20, "claude")).toBe(false);
    expect(ownsChatPane(processes.map(p => ({ ...p, foreground: 50 })), 10, 20, "codex")).toBe(false);
  });
});

describe("chat acknowledgements", () => {
  test("fan-out is not success, duplicate requests dispatch once, and receipts must match the target", async () => {
    const broker = new ChatBroker(), c = command();
    let dispatched = 0;
    const response = broker.submit(c, () => { dispatched++; });
    const duplicate = broker.submit(c, () => { dispatched++; });
    expect(broker.accept({ ...chatResult(c, "sent", "sent"), target_machine: "other" })).toBe(false);
    expect(broker.accept(chatResult(c, "sent", "Sent to terminal"))).toBe(true);
    expect((await response).status).toBe("sent");
    expect(await duplicate).toEqual(await response);
    expect(dispatched).toBe(1);
    broker.close();
  });

  test("timeout is explicitly unknown and a late receipt can resolve a status check", async () => {
    const broker = new ChatBroker(), c = command();
    expect((await broker.submit(c, () => {}, 5)).status).toBe("unknown");
    broker.accept(chatResult(c, "sent", "sent"));
    expect((await broker.submit(c, () => { throw new Error("must not redispatch"); })).status).toBe("sent");
    broker.close();
  });

  test("authenticated remote command reaches its owning forwarder and returns an execution failure without replay", async () => {
    const remoteDir = directory(), localDir = directory(), machine = machineID(localDir);
    const hub = new Hub(remoteDir, "test", "chat-test-token", "127.0.0.1", "", 0, true);
    const server = listen(hub, 0);
    const base = `http://127.0.0.1:${server.port}`;
    const forwarder = new Forwarder({ upstream: base, token: "chat-test-token", stateDir: localDir, version: "test", port: 0, historyLimit: 10 });
    try {
      hub.ingest(session(machine));
      forwarder.start();
      const fakeServer = { requestIP: () => ({ address: "127.0.0.1" }) } as any;
      for (let i = 0; i < 100; i++) {
        const state = await forwarder.handle(new Request("http://127.0.0.1/state", { headers: { Host: "127.0.0.1" } }), fakeServer);
        if ((await state!.json()).sessions.length) break;
        await Bun.sleep(10);
      }
      const c = command(machine);
      const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) };
      expect((await fetch(base + "/command", options)).status).toBe(401);
      const res = await fetch(base + "/command", { ...options, headers: { ...options.headers, Authorization: "Bearer chat-test-token" } });
      const receipt = await res.json();
      expect(receipt.id).toBe(c.id);
      expect(receipt.status).toBe("failed");
      expect(receipt.message).toContain("Set up mobile chat");
      expect(readFileSync(join(remoteDir, "events.jsonl"), "utf8")).not.toContain(c.id);
      expect(hub.sessions()).toHaveLength(1);
    } finally {
      forwarder.close(); hub.close(); server.stop(true);
    }
  }, 15_000);
});
