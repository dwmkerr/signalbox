import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Chat, validateCommand, type Command } from "./command";
import { machineID, type Event } from "./event";
import { sendTmuxChat, type TmuxChatOutcome } from "./tmuxchat";

/** Maximum age of an input request. Input is never replayed after reconnect. */
export const chatExpiryMs = 15_000;
/** Maximum wait for the owning machine to acknowledge a paste. */
export const chatWaitMs = 10_000;

/** Correlated outcome returned to the phone and relayed by a forwarder. */
export interface ChatResult extends TmuxChatOutcome {
  /** Original command UUID. */
  id: string;
  /** Conversation addressed by the command. */
  session_key: string;
  /** Stable machine identity of the executor. */
  target_machine: string;
}

/** Construct a correlated outcome without retaining prompt text. */
export function chatResult(c: Command, status: ChatResult["status"], message: string): ChatResult {
  return { id: c.id, session_key: c.session_key, target_machine: c.target_machine!, status, message };
}

function fingerprint(c: Command): string {
  return createHash("sha256").update(JSON.stringify([c.session_key, c.target_machine, c.target_host, c.text])).digest("hex");
}

/** Executes only this machine's input, with receipts written before paste to prevent duplicate submission. */
export class ChatExecutor {
  private active = new Set<string>();

  constructor(
    private directory: string,
    private sessions: () => Event[],
    private send: (session: Event, text: string) => Promise<TmuxChatOutcome> = sendTmuxChat,
  ) {}

  /** A different machine's command is ignored; local failures produce a receipt. */
  async execute(c: Command): Promise<ChatResult | null> {
    if (c.command !== Chat || validateCommand(c) || c.target_machine !== machineID(this.directory)) return null;
    const result = (status: ChatResult["status"], message: string) => chatResult(c, status, message);
    const receipts = join(this.directory, "chat-receipts");
    const path = join(receipts, c.id + ".json");
    const hash = fingerprint(c);
    try {
      mkdirSync(receipts, { recursive: true, mode: 0o700 });
    } catch {
      return result("failed", "Could not prepare a delivery receipt. Nothing was sent.");
    }
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved.hash !== hash) return result("failed", "This message ID was already used for a different message.");
      return saved.result ?? result("unknown", "Delivery is unconfirmed. Check the terminal before sending again.");
    } catch (error: any) {
      if (error?.code !== "ENOENT") return result("unknown", "Could not read the delivery receipt. Check the terminal.");
    }
    const age = Date.now() - Date.parse(c.ts);
    if (age > chatExpiryMs || age < -60_000) return result("failed", "This message expired. Send it again when connected.");
    const session = this.sessions().find(e => e.session_key === c.session_key && e.machine === c.target_machine);
    if (!session || session.host !== c.target_host) return result("failed", "This session is no longer available on that computer.");
    if (this.active.has(c.session_key)) return result("failed", "Another message is being sent to this session.");
    try {
      writeFileSync(path, JSON.stringify({ hash }), { flag: "wx", mode: 0o600 });
    } catch {
      return result("unknown", "Delivery is already pending or its receipt could not be saved. Check the terminal.");
    }
    this.active.add(c.session_key);
    let outcome: ChatResult;
    try {
      outcome = { ...result("unknown", "Delivery is unconfirmed. Check the terminal before sending again."), ...await this.send(session, c.text!) };
    } catch {
      outcome = result("unknown", "Delivery is unconfirmed. Check the terminal before sending again.");
    } finally {
      this.active.delete(c.session_key);
    }
    try {
      writeFileSync(path + ".tmp", JSON.stringify({ hash, result: outcome }), { mode: 0o600 });
      renameSync(path + ".tmp", path);
    } catch {
      return result("unknown", "Delivery could not be recorded. Check the terminal before sending again.");
    }
    return outcome;
  }
}

interface PendingChat {
  command: Command;
  hash: string;
  promise: Promise<ChatResult>;
  resolve: (result: ChatResult) => void;
  timer: ReturnType<typeof setTimeout>;
  result?: ChatResult;
}

/** Waits for execution receipts without putting input commands into the replayable event log. */
export class ChatBroker {
  private pending = new Map<string, PendingChat>();

  /** Deduplicate simultaneous HTTP submissions and await the owning executor. */
  submit(c: Command, dispatch: () => void, timeout = chatWaitMs): Promise<ChatResult> {
    const previous = this.pending.get(c.id);
    if (previous) {
      if (previous.hash !== fingerprint(c)) return Promise.resolve(chatResult(c, "failed", "This message ID was already used."));
      return previous.result ? Promise.resolve(previous.result) : previous.promise;
    }
    const age = Date.now() - Date.parse(c.ts);
    if (age > chatExpiryMs || age < -60_000) return Promise.resolve(chatResult(c, "failed", "This message expired. Send it again when connected."));
    // Completed requests can be evicted: the executor's durable receipt still prevents replay.
    if (this.pending.size >= 1024) {
      for (const [id, item] of this.pending) {
        if (item.result) this.pending.delete(id);
        if (this.pending.size < 1024) break;
      }
      if (this.pending.size >= 1024) return Promise.resolve(chatResult(c, "failed", "Too many messages are pending. Try again shortly."));
    }
    let resolve!: (result: ChatResult) => void;
    const promise = new Promise<ChatResult>(done => { resolve = done; });
    const timer = setTimeout(() => this.accept(chatResult(c, "unknown", "The computer did not confirm delivery. Check the session before sending again.")), timeout);
    this.pending.set(c.id, { command: c, hash: fingerprint(c), promise, resolve, timer });
    dispatch();
    return promise;
  }

  /** Accept only a receipt for the exact pending conversation and machine. */
  accept(result: ChatResult): boolean {
    if (!result || !["sent", "failed", "unknown"].includes(result.status) || typeof result.message !== "string" || result.message.length > 1024) return false;
    const pending = this.pending.get(result.id);
    if (!pending || result.session_key !== pending.command.session_key || result.target_machine !== pending.command.target_machine) return false;
    if (pending.result && pending.result.status !== "unknown") return true;
    clearTimeout(pending.timer);
    pending.result = result;
    pending.resolve(result);
    return true;
  }

  /** Release waits when the hub shuts down. */
  close(): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.resolve(chatResult(item.command, "unknown", "The hub disconnected before delivery was confirmed."));
    }
    this.pending.clear();
  }
}
