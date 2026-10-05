// A forwarder is a loopback bridge to an upstream hub. It owns no source-of-
// truth store, writes no durable event log, and never assigns seq: its Store is
// only a materialised view of the upstream downlink. The cache therefore cannot
// echo a local write because nothing local ever originates state.

import * as cmd from "./command";
import type { Command } from "./command";
import { logTo } from "./client";
import * as ev from "./event";
import type { Event } from "./event";
import {
  parseExchangeQuery, exchangesBody, isLoopbackHost, noStoreJSON,
  searchResultLimit, searchSweepBudgetMs, searchSweepIntervalMs,
} from "./hub";
import type { RequestHandler } from "./hub";
import { PermanentError, Spool } from "./spool";
import { Store } from "./state";
import { openIndex, type SearchIndex } from "./searchindex";
import { loadSettings } from "./config";
import { buildStamp } from "./build";
import { hubLog } from "./log";

// A bounded replay ring prevents a long-running forwarder from retaining the
// upstream's entire history in memory.
const maxCachedEvents = 2000;
// Matching the hub's cadence keeps the app's 90s request timeout from firing
// while a local stream is quiet.
const heartbeatMs = 15_000;
// The app already tolerates this reconnect cadence, so the forwarder recovers
// promptly without hammering an unavailable upstream.
const reconnectMinMs = 1_000;
// A ceiling keeps prolonged outages gentle while still noticing recovery
// within a useful interval.
const reconnectMaxMs = 15_000;
// The upstream heartbeats every 15s, so three missed beats mean a socket is
// dead even when the network stack has not noticed.
const uplinkIdleMs = 45_000;
// A periodic pass catches a failed event POST even when the stream itself
// stayed connected and therefore has no reconnect transition to trigger one.
const drainTickMs = 10_000;
// Bounding each pass prevents a large backlog from monopolising the runtime.
const drainMaxEvents = 500;
// A time budget lets other local requests proceed during a long recovery.
const drainBudgetMs = 5_000;
// The event cap keeps an offline machine from growing its forward spool without
// bound while preserving a substantial recent history.
const spoolMaxEvents = 10_000;
// The byte cap bounds disk use even when individual events approach the input
// body limit.
const spoolMaxBytes = 16 * 1024 * 1024;
// Forwarding happens away from the hook's latency-sensitive call, so a WAN POST
// can have a generous timeout without delaying the hook.
const postTimeoutMs = 10_000;
// Events are small; a larger local POST is junk and should not consume memory
// or disk merely because the forwarder trusts loopback callers.
const maxBodyBytes = 1 << 20;

type Subscriber = (e: Event) => void;
type CommandSubscriber = (c: Command) => void;

export interface ForwarderOptions {
  upstream: string;
  token: string;
  stateDir: string;
  version: string;
  port: number;
  historyLimit: number;
  /** Index local transcripts and serve /search from them. Off by default. */
  searchEnabled?: boolean;
  /** Whether search is still enabled, asked once per sweep. See Hub. */
  searchEnabledNow?: () => boolean;
}

export class Forwarder implements RequestHandler {
  private store: Store;
  private events: Event[] = [];
  private subs = new Set<Subscriber>();
  private cmdSubs = new Set<CommandSubscriber>();
  private lastSeq = 0;
  private connected = false;
  private hasConnected = false;
  private spool: Spool;
  private closed = false;
  private started = false;
  private uplinkController: AbortController | null = null;
  // The local transcript index. A forwarder owns no session state, but the
  // transcripts live on ITS machine, so it is the only process that can answer
  // a contents search for them without the text crossing to another machine.
  private searchIndex: SearchIndex | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectResolve: (() => void) | null = null;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private searchTimer: ReturnType<typeof setInterval> | null = null;
  private streamCleanups = new Set<() => void>();
  private failureLogged = false;
  private initialReplayComplete = false;
  private deliveredHighWater = 0;
  private synchronizationWaiters = new Set<{
    resolve: () => void;
    reject: (reason: Error) => void;
  }>();

  constructor(private opts: ForwarderOptions) {
    this.store = new Store(opts.historyLimit);

    this.spool = new Spool(
      opts.stateDir,
      "forward-spool.jsonl",
      { maxEvents: spoolMaxEvents, maxBytes: spoolMaxBytes },
      (message) => this.log(message)
    );
  }

  handle(req: Request, server: Bun.Server<undefined>): Response | Promise<Response> | undefined {
    const url = new URL(req.url);
    // Health remains reachable even when a caller's Host header is unsuitable,
    // matching the hub's platform-health contract.
    if (req.method === "GET" && url.pathname === "/healthz") {
      // `mode` is an explicit enum rather than "the caller can tell because
      // there is an `upstream` key", because a client that sniffs shape breaks
      // the moment the shape changes for an unrelated reason.
      return Response.json({
        ok: true,
        version: this.opts.version,
        build: buildStamp,
        mode: "forwarder",
        port: this.opts.port,
        upstream: {
          url: this.opts.upstream,
          connected: this.connected,
          lastSeq: this.lastSeq,
          spooled: this.spool.count(),
        },
      });
    }
    // The forwarder is unauthenticated by design: local trust is the point and
    // the token lives in one place, so DNS-rebinding defence is the one guard
    // that still matters.
    if (!isLoopbackHost(req.headers.get("host") ?? "")) {
      return jsonError(403, "forbidden: hub only answers loopback hosts");
    }
    if (req.method === "POST" && url.pathname === "/events") return this.handleEvents(req);
    if (req.method === "POST" && url.pathname === "/command") return this.handleCommand(req);
    if (req.method === "GET" && url.pathname === "/state") {
      return Response.json({ sessions: this.store.list() });
    }
    if (req.method === "GET" && url.pathname === "/exchanges") {
      return this.handleExchanges(url);
    }
    if (req.method === "GET" && url.pathname === "/search/status") {
      return this.handleSearchStatus();
    }
    if (req.method === "POST" && url.pathname === "/search/rebuild") {
      return this.handleSearchRebuild();
    }
    if (req.method === "GET" && url.pathname === "/search") {
      return this.handleSearch(url);
    }
    if (req.method === "GET" && url.pathname === "/stream") {
      return this.handleStream(req, url, server);
    }
    // Pairing trades a code for the hub's own token. A forwarder holds neither
    // the slot nor that authority, and proxying would expose the upstream
    // credential through an unauthenticated local endpoint.
    if (
      (req.method === "POST" && url.pathname === "/pair") ||
      (req.method === "POST" && url.pathname === "/pair/new") ||
      (req.method === "GET" && url.pathname === "/pair/status")
    ) {
      return jsonError(
        409,
        `this signalbox is a forwarder (hub.upstream is set); pair against the upstream hub instead: signalbox pair --url ${this.opts.upstream}`
      );
    }
    return undefined;
  }

  // The forwarder serves exchanges from its downlink-fed reducer using the
  // same response contract as the upstream.
  private handleExchanges(url: URL): Response {
    const parsed = parseExchangeQuery(url, this.opts.historyLimit);
    if (parsed.error) return jsonError(400, parsed.error);
    const list = this.store.exchanges(parsed.session!, { limit: parsed.limit!, before: parsed.before });
    if (list === null) return jsonError(404, "unknown session");
    return Response.json(exchangesBody(parsed.session!, list), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.runUplink();
    // Connect-time drains cover a dead link coming back; this timer covers the
    // case where the link is fine but one event POST failed.
    this.drainTimer = setInterval(() => {
      if (this.spool.count() > 0) this.kickDrain();
    }, drainTickMs);
  }

  // A local listener must not expose the upstream's historical replay as live
  // transitions. The hub's sync frame is the exact boundary; an older upstream
  // has no such frame, so its first heartbeat is the compatible boundary that
  // is structurally emitted only after the replay has been queued.
  synchronize(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("forwarder is closed"));
    const waiting = new Promise<void>((resolve, reject) => {
      this.synchronizationWaiters.add({ resolve, reject });
    });
    this.start();
    if (this.initialReplayComplete) this.kickDrain();
    this.checkSynchronization();
    return waiting;
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.uplinkController?.abort();
    this.uplinkController = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectResolve?.();
    this.reconnectResolve = null;
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    for (const cleanup of this.streamCleanups) cleanup();
    this.streamCleanups.clear();
    for (const waiter of this.synchronizationWaiters) {
      waiter.reject(new Error("forwarder closed before synchronization"));
    }
    this.synchronizationWaiters.clear();
  }

  // The startup importer and local POST path share the same durable outbound
  // queue, so switching to an upstream cannot strand the hook-path spool.
  async enqueue(event: Event): Promise<void> {
    await this.spool.append(JSON.stringify(event));
  }

  private async handleEvents(req: Request): Promise<Response> {
    const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return jsonError(415, "Content-Type must be application/json");
    }
    const body = await req.arrayBuffer();
    if (body.byteLength > maxBodyBytes) return jsonError(400, "body too large");
    let e: Event;
    try {
      e = JSON.parse(new TextDecoder().decode(body));
    } catch (err) {
      return jsonError(400, `invalid json: ${err}`);
    }
    let invalid: string | null;
    try {
      ev.normalizeInbound(e);
      invalid = ev.validate(e);
    } catch (err) {
      return jsonError(400, `invalid event: ${String(err)}`);
    }
    if (invalid) return jsonError(400, invalid);
    delete e.acked;
    delete e.hidden;
    delete e.pinned;
    delete e.engaged_ts;
    delete e.seq;
    // A local hub uses this path to match search hits, but an upstream hub
    // cannot read another machine's transcripts, so forwarding it only leaks.
    delete e.transcript;
    // The hook gives its POST only 200 ms. Waiting for a WAN round trip would
    // make the hook spool locally after this process had also delivered the
    // event, creating a duplicate; one local append and one async drain avoid it.
    try {
      await this.enqueue(e);
    } catch (err) {
      return jsonError(500, String(err));
    }
    this.kickDrain();
    return Response.json({ spooled: true }, { status: 202 });
  }

  // Opened when the setting first says yes and dropped when it says no, so the
  // Settings toggle works without restarting the hub the app supervises.
  private activeIndex(): SearchIndex | null {
    const enabled = (this.opts.searchEnabledNow ?? (() => loadSettings().searchEnabled))();
    if (!enabled) {
      this.searchIndex?.close();
      this.searchIndex = null;
      return null;
    }
    if (!this.searchIndex) this.searchIndex = openIndex(this.opts.stateDir);
    return this.searchIndex;
  }

  private handleSearch(url: URL): Response {
    const index = this.activeIndex();
    if (!index) {
      return noStoreJSON({ error: "search_disabled", enabled: false }, 409);
    }
    const query = url.searchParams.get("q");
    if (!query) return noStoreJSON({ error: "q is required" }, 400);
    return noStoreJSON({
      enabled: true,
      query,
      results: index.search(query, searchResultLimit, this.store.list()),
    });
  }

  // Rebuilding is the hub's job because it owns the open connection. It empties
  // the index and returns at once: the sweep refills it, so the caller sees
  // progress where it already watches for it rather than waiting on this.
  private handleSearchRebuild(): Response {
    const index = this.activeIndex();
    if (!index) return noStoreJSON({ error: "search_disabled", enabled: false }, 409);
    index.rebuild();
    return noStoreJSON({ enabled: true, status: index.status() });
  }

  private handleSearchStatus(): Response {
    const index = this.activeIndex();
    if (!index) return noStoreJSON({ enabled: false, status: "disabled" });
    return noStoreJSON({ enabled: true, status: index.status() });
  }

  // startSearch runs the same bounded sweep the hub runs. Discovery walks this
  // machine's transcript directories, so the index it builds is local by
  // construction.
  startSearch(): void {
    // Re-read per tick for the same reason as the hub: turning the setting off
    // has to stop transcripts being read without waiting for a restart.
    this.searchTimer = setInterval(
      () => this.activeIndex()?.sweep({ budgetMs: searchSweepBudgetMs }),
      searchSweepIntervalMs,
    );
  }

  private async handleCommand(req: Request): Promise<Response> {
    const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return jsonError(415, "Content-Type must be application/json");
    }
    const body = await req.arrayBuffer();
    if (body.byteLength > maxBodyBytes) return jsonError(400, "body too large");
    let c: Command;
    try {
      c = JSON.parse(new TextDecoder().decode(body));
    } catch (err) {
      return jsonError(400, `invalid json: ${err}`);
    }
    let invalid: string | null;
    try {
      invalid = cmd.validateCommand(c);
    } catch (err) {
      return jsonError(400, `invalid command: ${String(err)}`);
    }
    if (invalid) return jsonError(400, invalid);
    // A command is a request and is meaningless once stale, the same reason
    // the hub never logs one, so a failed command is never spooled.
    try {
      const res = await fetch(`${this.opts.upstream}/command`, {
        method: "POST",
        headers: this.postHeaders(),
        body: JSON.stringify(c),
        signal: AbortSignal.timeout(postTimeoutMs),
      });
      if (!res.ok) {
        const detail = (await res.text()).trim();
        return jsonError(502, `upstream unreachable: ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      const headers = new Headers();
      const contentType = res.headers.get("content-type");
      if (contentType) headers.set("Content-Type", contentType);
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      return jsonError(502, `upstream unreachable: ${String(err)}`);
    }
  }

  private handleStream(req: Request, url: URL, server: Bun.Server<undefined>): Response {
    const sinceRaw = url.searchParams.get("since");
    let since = 0;
    if (sinceRaw) {
      since = parseInt(sinceRaw, 10);
      if (Number.isNaN(since)) return jsonError(400, "since must be an integer seq");
    }
    server.timeout(req, 0);

    const subs = this.subs;
    const cmdSubs = this.cmdSubs;
    // The replay ring is bounded, so a sufficiently long-absent client can
    // miss frames. Every consumer, including the macOS app and phone, performs
    // a full /state resync on reconnect, making that gap harmless.
    const backlog = this.events.filter((e) => (e.seq ?? 0) > since);
    let last = since;
    const enc = new TextEncoder();
    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream({
      start: (controller) => {
        const write = (text: string) => controller.enqueue(enc.encode(text));
        write(": connected\n\n");
        for (const e of backlog) {
          write(`event: signal\ndata: ${JSON.stringify(e)}\n\n`);
          last = e.seq ?? last;
        }
        const send: Subscriber = (e) => {
          if ((e.seq ?? 0) <= last) return;
          last = e.seq ?? last;
          write(`event: signal\ndata: ${JSON.stringify(e)}\n\n`);
        };
        subs.add(send);
        const sendCmd: CommandSubscriber = (c) => {
          write(`event: command\ndata: ${JSON.stringify(c)}\n\n`);
        };
        cmdSubs.add(sendCmd);
        const hb = setInterval(() => {
          try {
            write(": heartbeat\n\n");
          } catch {
            cleanup?.();
          }
        }, heartbeatMs);
        cleanup = () => {
          clearInterval(hb);
          subs.delete(send);
          cmdSubs.delete(sendCmd);
          try {
            controller.close();
          } catch {
            // Closing an already-errored stream controller throws.
          }
          if (cleanup) this.streamCleanups.delete(cleanup);
        };
        this.streamCleanups.add(cleanup);
      },
      cancel: () => {
        cleanup?.();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private async runUplink(): Promise<void> {
    let backoff = reconnectMinMs;
    while (!this.closed) {
      const controller = new AbortController();
      this.uplinkController = controller;
      try {
        const res = await fetch(`${this.opts.upstream}/stream?since=${this.lastSeq}`, {
          headers: this.authHeaders(),
          signal: controller.signal,
        });
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error(`upstream stream returned ${res.status}`);
        }
        if (!res.body) throw new Error("upstream stream returned no body");
        this.connected = true;
        if (this.hasConnected) {
          // The first connect must not flap clients at boot; a re-connect must
          // close them so their existing reconnect path resyncs from /state.
          // Closing before the replay lands is safe: within one upstream the
          // cache's domain matches, so a client that resyncs against a
          // momentarily stale cache catches up from the next relayed frames.
          // A REPLACED upstream (regressed domain) is not healed here at all -
          // the uplink cursor itself is stale then and the forwarder needs a
          // restart (see the seq-domain note in events.md).
          for (const cleanup of this.streamCleanups) cleanup();
        }
        this.hasConnected = true;
        this.failureLogged = false;
        backoff = reconnectMinMs;
        if (this.synchronizationWaiters.size === 0) this.kickDrain();
        this.resetIdleWatchdog(controller);
        await this.consumeStream(res.body, controller);
        if (!this.closed) throw new Error("upstream stream ended");
      } catch (err) {
        if (!this.closed) this.logFailure(err);
      } finally {
        this.connected = false;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        if (this.uplinkController === controller) this.uplinkController = null;
      }
      if (this.closed) break;
      await this.waitForReconnect(backoff);
      backoff = Math.min(backoff * 2, reconnectMaxMs);
    }
  }

  private async consumeStream(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let label = "signal";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.resetIdleWatchdog(controller);
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (line.startsWith("event:")) {
            label = line.slice("event:".length).trim();
          } else if (line.startsWith("data:")) {
            this.dispatchDownlink(label, line.slice("data:".length).trimStart());
            label = "signal";
          } else if (line.startsWith(": heartbeat")) {
            this.markReplayComplete();
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private dispatchDownlink(label: string, payload: string): void {
    try {
      if (label === "sync") {
        const boundary = JSON.parse(payload) as { seq?: unknown };
        if (typeof boundary.seq === "number" && boundary.seq <= this.lastSeq) {
          this.markReplayComplete();
        }
        return;
      }
      if (label === "command") {
        const c = JSON.parse(payload) as Command;
        for (const send of this.cmdSubs) {
          try {
            send(c);
          } catch {
            // One broken local subscriber must not break the shared downlink.
          }
        }
        return;
      }
      if (label !== "signal") return;
      const e = JSON.parse(payload) as Event;
      ev.normalizeInbound(e);
      this.store.apply(e);
      this.events.push(e);
      if (this.events.length > maxCachedEvents) {
        this.events.splice(0, this.events.length - maxCachedEvents);
      }
      if ((e.seq ?? 0) > this.lastSeq) this.lastSeq = e.seq!;
      this.checkSynchronization();
      for (const send of this.subs) {
        try {
          send(e);
        } catch {
          // One broken local subscriber must not break the shared downlink.
        }
      }
    } catch {
      // A malformed upstream frame is skipped so later frames can still flow.
    }
  }

  private resetIdleWatchdog(controller: AbortController): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => controller.abort(), uplinkIdleMs);
  }

  private waitForReconnect(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectResolve = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectResolve = null;
        resolve();
      }, delayMs);
    });
  }

  private kickDrain(): void {
    void this.drain()
      .then(() => {
        if (this.synchronizationWaiters.size > 0 && this.spool.count() > 0) {
          this.kickDrain();
          return;
        }
        this.checkSynchronization();
      })
      .catch((err) => this.log(`drain: ${String(err)}`));
  }

  private drain(): Promise<number> {
    return this.spool.drain((line) => this.sendEvent(line), {
      maxEvents: drainMaxEvents,
      budgetMs: drainBudgetMs,
    });
  }

  private async sendEvent(line: string): Promise<void> {
    const res = await fetch(`${this.opts.upstream}/events`, {
      method: "POST",
      headers: this.postHeaders(),
      body: line,
      signal: AbortSignal.timeout(postTimeoutMs),
    });
    const body = (await res.text()).trim();
    if (res.ok) {
      try {
        const accepted = JSON.parse(body) as { seq?: unknown };
        if (typeof accepted.seq === "number") {
          this.deliveredHighWater = Math.max(this.deliveredHighWater, accepted.seq);
        }
      } catch {}
      return;
    }
    if (res.status >= 400 && res.status < 500) {
      throw new PermanentError(`upstream rejected event: ${res.status}${body ? `: ${body}` : ""}`);
    }
    throw new Error(`upstream returned ${res.status}${body ? `: ${body}` : ""}`);
  }

  private authHeaders(): Record<string, string> {
    return this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {};
  }

  private postHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", ...this.authHeaders() };
  }

  private logFailure(err: unknown): void {
    if (this.failureLogged) return;
    this.log(`upstream disconnected: ${String(err)}`);
    this.failureLogged = true;
  }

  private markReplayComplete(): void {
    this.initialReplayComplete = true;
    if (this.synchronizationWaiters.size > 0 && this.spool.count() > 0) {
      this.kickDrain();
    }
    this.checkSynchronization();
  }

  private checkSynchronization(): void {
    if (!this.initialReplayComplete) return;
    if (this.spool.count() > 0) return;
    if (this.lastSeq < this.deliveredHighWater) return;
    for (const waiter of this.synchronizationWaiters) waiter.resolve();
    this.synchronizationWaiters.clear();
  }

  private log(message: string): void {
    logTo(this.opts.stateDir, message);
    // cli.log is the CLI-wide hook log, while hub.log is what the app shows a
    // person, so an uplink failure must be visible in the log they inspect.
    hubLog(message);
  }
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
