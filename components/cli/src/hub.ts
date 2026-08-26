// The signalbox hub: ingest, state, SSE stream, JSONL persistence, and the
// expiry/liveness sweeps. Behaviour per specs/events.md.

import { appendFileSync, mkdirSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import * as ev from "./event";
import type { Event } from "./event";
import * as cmd from "./command";
import type { Command } from "./command";
import { Store, DefaultHistoryLimit } from "./state";
import type { Exchange } from "./state";
import { procAlive } from "./proc";
import { buildStamp } from "./build";
import { openIndex, type SearchIndex } from "./searchindex";
import { loadSettings } from "./config";

const heartbeatMs = 15_000;
export const searchSweepIntervalMs = 250;
export const searchSweepBudgetMs = 10;
export const searchResultLimit = 50;
// Bounds a single POST body; events are tiny, so anything bigger is junk.
const maxBodyBytes = 1 << 20;

type Subscriber = (e: Event) => void;
type CommandSubscriber = (c: Command) => void;

// listen() serves anything that can answer a request; the Hub and the
// forwarder are both such a thing, and neither needs to know about the other.
export interface RequestHandler {
  handle(req: Request, server: Bun.Server<undefined>): Response | Promise<Response> | undefined;
}

export class Hub {
  private seq = 0;
  private log: Event[] = [];
  private store: Store;
  private subs = new Set<Subscriber>();
  // Commands ride the same /stream connection but a separate set, so the event
  // subscriber's seq-dedupe closure never has to reason about a seq-less thing.
  private cmdSubs = new Set<CommandSubscriber>();
  // The single ephemeral pairing slot: the current mintable code, when it
  // expires, and whether it has been redeemed. NEVER persisted - the
  // constructor only replays events.jsonl, so this is naturally empty on boot,
  // exactly like the in-flight command path (dispatch never touches ingest).
  private pairing: { code: string; expiresAt: number; redeemed: boolean } | null = null;
  private logFd: number;
  private timers: ReturnType<typeof setInterval>[] = [];
  private logPath: string;
  private searchIndex: SearchIndex | null = null;

  // Rebuilds state from events.jsonl in stateDir (creating it if needed).
  // Seq continues from the highest persisted value. token is the bearer secret
  // non-loopback clients must present; empty means no token configured (the
  // loopback-only default, where a token is never required).
  constructor(
    private stateDirPath: string,
    private version: string,
    private token: string = "",
    // The hub's own bind address, echoed to a freshly minted pairing code so
    // the phone learns which interface to reach. This is not the loopback vs
    // LAN policy decision (that is isLoopbackAddress on the peer at mint time);
    // it is only what a mint advertises.
    private bind: string = "127.0.0.1",
    // SHA-256 fingerprint of the LAN listener's self-signed cert, or empty when
    // the LAN path is plain http. Advertised in the mint so the phone can pin
    // the cert and dial https; empty means the QR stays http (see specs/ios).
    private tlsFingerprint: string = "",
    // The port the TLS LAN listener is on - distinct from the loopback http
    // port, because two Bun listeners cannot share one port. Advertised in the
    // mint so the phone dials the https port, not the local http one.
    private tlsPort: number = 0,
    // Remote mode (hub --remote): the hub sits behind a platform proxy that
    // terminates TLS (e.g. Fly). The peer address the server reports is then
    // the proxy's, which may look like loopback - so the loopback auth
    // exemption is never granted and EVERY request needs the bearer, except
    // /healthz and /pair which are unauthenticated by design.
    private remote: boolean = false,
    // The port this hub listens on, echoed by /healthz. A surface that wants
    // to tell a person where to reach the hub must not have to guess it from
    // the URL it happened to dial.
    private port: number = 0,
    private historyLimit: number = DefaultHistoryLimit,
    // Whether search is enabled, asked on every sweep and every request rather
    // than captured once, so ticking the box in Settings takes effect within a
    // sweep instead of at the next restart. Injectable so a test does not need
    // a settings file on disk to exercise indexing.
    private searchEnabledNow: () => boolean = () => loadSettings().searchEnabled
  ) {
    this.store = new Store(historyLimit);
    mkdirSync(this.stateDirPath, { recursive: true });
    this.logPath = join(this.stateDirPath, "events.jsonl");
    if (existsSync(this.logPath)) {
      for (const line of readFileSync(this.logPath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let e: Event;
        try {
          e = JSON.parse(trimmed);
        } catch {
          // A corrupt line (crash mid-append) must not stop the hub booting.
          continue;
        }
        ev.normalizeInbound(e);
        this.log.push(e);
        if ((e.seq ?? 0) > this.seq) this.seq = e.seq!;
        this.store.apply(e);
        // Seed the dedupe window from the log so a redelivery spanning a hub
        // restart is still recognized.
        if (e.id) {
          this.seenIds.add(e.id);
          this.seenIdOrder.push(e.id);
          if (this.seenIdOrder.length > 4096) this.seenIds.delete(this.seenIdOrder.shift()!);
        }
      }
    }
    // Keep an fd open for appends (append mode).
    this.logFd = openSync(this.logPath, "a");

  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    try {
      closeSync(this.logFd);
    } catch {}
    this.searchIndex?.close();
    this.searchIndex = null;
  }

  // The forwarder's drain is at-least-once, so a crash between send and
  // reconcile can resend events. Last-write-wins makes duplicates harmless for
  // session rows. Duplicate done or busy events can corrupt exchange history,
  // so ingest deduplicates them by id. Redeliveries are near-adjacent, so a
  // bounded FIFO window suffices.
  private seenIds = new Set<string>();
  private seenIdOrder: string[] = [];

  // ingest is the single write path - POST /events and the sweeps all go
  // through it, so every event gets a seq and is persisted, applied and
  // broadcast identically. Persist failure refuses the event rather than
  // acknowledging one that would vanish on restart.
  ingest(e: Event): number {
    if (e.id) {
      if (this.seenIds.has(e.id)) return this.seq;
      this.seenIds.add(e.id);
      this.seenIdOrder.push(e.id);
      if (this.seenIdOrder.length > 4096) this.seenIds.delete(this.seenIdOrder.shift()!);
    }
    e.seq = ++this.seq;
    appendFileSync(this.logFd, JSON.stringify(e) + "\n");
    this.log.push(e);
    this.store.apply(e);
    for (const send of this.subs) {
      try {
        send(e);
      } catch {
        // A broken subscriber must not block ingest.
      }
    }
    return e.seq;
  }

  // dispatch is the command path, and it is deliberately everything ingest is
  // not: no seq, no log, no reducer. Commands live only in flight, so the
  // backlog that /stream replays structurally cannot contain one. Returns how
  // many listeners it reached, which is how a phone learns instantly that no
  // machine is listening rather than waiting out a timeout.
  dispatch(c: Command): number {
    let delivered = 0;
    for (const send of this.cmdSubs) {
      try {
        send(c);
        delivered++;
      } catch {
        // A broken subscriber must not block the command.
      }
    }
    return delivered;
  }

  sessions(): Event[] {
    return this.store.list();
  }

  // The mode is STATED, never inferred by a caller from the bind address or
  // from the shape of this response. A surface that inferred it ("a wide
  // bind means devices can reach this Mac") told the user the opposite of
  // the truth while a forwarder was running, which is what this field ends.
  private modeName(): "local" | "lan" | "remote" {
    if (this.remote) return "remote";
    return isLoopbackAddress(this.bind) || this.bind === "" ? "local" : "lan";
  }

  // startExpiry runs the sweep once now - dead sessions from before a
  // restart must not wait for the first tick - then on every interval.
  startExpiry(intervalMs: number, maxAgeMs: number): void {
    const sweep = () => {
      const cutoff = Date.now() - maxAgeMs;
      for (const s of this.store.list()) {
        // ts is the last *agent* event - seen never touches it - so an
        // acked-but-alive session still expires while active work never does.
        if (Date.parse(s.ts) < cutoff) {
          try {
            this.ingest(ev.newEnded(s.session_key, "expired"));
          } catch {
            return; // persist failed; retry next tick
          }
        }
      }
    };
    sweep();
    this.timers.push(setInterval(sweep, intervalMs));
  }

  // startLiveness ends sessions whose captured process died without an exit
  // event. Ended, never done: dying is not finishing. Only sessions on the
  // hub's own host with a captured proc are checked.
  startLiveness(intervalMs: number): void {
    const host = ev.shortHostname();
    const sweep = () => {
      for (const s of this.store.list()) {
        if (!s.proc || s.host !== host) continue;
        if (procAlive(s.proc)) continue;
        try {
          this.ingest(ev.newEnded(s.session_key, "exited"));
        } catch {
          return;
        }
      }
    };
    sweep();
    this.timers.push(setInterval(sweep, intervalMs));
  }

  /** Starts bounded local transcript indexing when the privacy-sensitive feature is enabled. */
  startSearch(): void {
    // The setting is re-read every tick rather than captured at startup, so
    // turning search off stops reading transcripts immediately. Captured once,
    // a hub would keep indexing until it was restarted while the app reported
    // the feature as off.
    const sweep = () => this.activeIndex()?.sweep({ budgetMs: searchSweepBudgetMs });
    sweep();
    this.timers.push(setInterval(sweep, searchSweepIntervalMs));
  }

  // fetch handles one HTTP request; returns undefined for unknown routes.
  handle(req: Request, server: Bun.Server<undefined>): Response | Promise<Response> | undefined {
    const url = new URL(req.url);
    // /healthz stays unauthenticated from anywhere: platform health checks need
    // it before any credential. The added fields disclose only what the hub
    // already announces on stderr at startup.
    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        version: this.version,
        build: buildStamp,
        mode: this.modeName(),
        bind: this.bind,
        port: this.port,
      });
    }
    // unauthenticated exemptions: /healthz and /pair ONLY - everything above the
    // auth gate bypasses ALL auth. /pair is unauthenticated by design: the
    // pairing code itself is the credential, and this route trades it for the
    // token. It must therefore be miserly (one uniform 401 for every failure).
    if (req.method === "POST" && url.pathname === "/pair") return this.handlePair(req);
    // Auth is decided by the connection's real origin, never the Host header
    // (which the client controls). requestIP is the peer's address. In remote
    // mode the peer address is the platform proxy's and proves nothing about
    // the client, so the loopback exemption is never granted there.
    const remoteIP = server.requestIP(req)?.address;
    if (!this.remote && isLoopbackAddress(remoteIP)) {
      // Loopback peer: exactly the v0 contract. The loopback-literal Host check
      // is DNS-rebinding defence (a hostile page can point a name it controls
      // at 127.0.0.1 and read /state same-origin); no token is required, so a
      // 0.0.0.0 bind still serves local hooks and the menu bar app unchanged.
      if (!isLoopbackHost(req.headers.get("host") ?? "")) {
        return jsonError(403, "forbidden: hub only answers loopback hosts");
      }
    } else {
      // Non-loopback peer: the bearer token is the auth. A hostile webpage
      // cannot attach an Authorization header cross-origin (the hub grants no
      // CORS), so the loopback-Host rebinding check is redundant here and is
      // skipped - the token has already proved the caller.
      const denied = this.checkBearer(req);
      if (denied) return denied;
    }
    if (req.method === "POST" && url.pathname === "/events") return this.handleEvents(req);
    if (req.method === "POST" && url.pathname === "/command") return this.handleCommand(req);
    if (req.method === "GET" && url.pathname === "/state") {
      // no-store: /state doubles as the clients' liveness probe, and a
      // cached answer makes a dead hub look alive.
      return Response.json({ sessions: this.sessions() }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (req.method === "GET" && url.pathname === "/exchanges") {
      return this.handleExchanges(url);
    }
    if (req.method === "GET" && url.pathname === "/search/status") {
      return this.handleSearchStatus();
    }
    if (req.method === "GET" && url.pathname === "/search") {
      return this.handleSearch(url);
    }
    if (req.method === "GET" && url.pathname === "/stream") {
      return this.handleStream(req, url, server);
    }
    // /pair/new and /pair/status sit below the auth gate: a loopback peer (the
    // v0 contract) or any valid bearer holder may mint and inspect a pairing.
    // Gating mint behind loopback bought nothing against a token holder - they
    // can already read every prompt and forge events - and it blocked the
    // legitimate remote-admin flow (`pair --url` against a remote hub).
    if (req.method === "POST" && url.pathname === "/pair/new") return this.handlePairNew(req);
    if (req.method === "GET" && url.pathname === "/pair/status") return this.handlePairStatus();
    return undefined;
  }

  // Both handlers query Store.exchanges, which keeps their paging semantics
  // aligned.
  private handleExchanges(url: URL): Response {
    const parsed = parseExchangeQuery(url, this.historyLimit);
    if (parsed.error) return jsonError(400, parsed.error);
    const list = this.store.exchanges(parsed.session!, { limit: parsed.limit!, before: parsed.before });
    if (list === null) return jsonError(404, "unknown session");
    return Response.json(exchangesBody(parsed.session!, list), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  // The index is opened the first time the setting says yes, and dropped when
  // it says no, so ticking the box in Settings takes effect within a sweep
  // rather than at the next restart. Opened once at construction, a hub that
  // started with the setting off could never serve search however the user
  // changed it.
  private activeIndex(): SearchIndex | null {
    if (!this.searchEnabledNow()) {
      this.searchIndex?.close();
      this.searchIndex = null;
      return null;
    }
    if (!this.searchIndex) this.searchIndex = openIndex(this.stateDirPath);
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
      results: index.search(query, searchResultLimit, this.sessions()),
    });
  }

  private handleSearchStatus(): Response {
    const index = this.activeIndex();
    if (!index) return noStoreJSON({ enabled: false, status: "disabled" });
    return noStoreJSON({ enabled: true, status: index.status() });
  }

  // checkBearer returns a 401 Response when the request does not carry the
  // configured token, or null when it does. The comparison is constant-time:
  // both sides are SHA-256'd first so the buffers are always equal length
  // (timingSafeEqual throws on a length mismatch, and a raw length compare
  // would leak the token length). No token configured means no non-loopback
  // client can ever authenticate, so an empty this.token always denies.
  private checkBearer(req: Request): Response | null {
    const header = req.headers.get("authorization") ?? "";
    const prefix = "Bearer ";
    const presented = header.startsWith(prefix) ? header.slice(prefix.length) : "";
    if (this.token && presented && timingSafeEqualStr(presented, this.token)) return null;
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
    });
  }

  private async handleEvents(req: Request): Promise<Response> {
    // Only application/json may post: text/plain and form encodings are CORS
    // "simple requests" a hostile page can send without a preflight.
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
    ev.normalizeInbound(e);
    const invalid = ev.validate(e);
    if (invalid) return jsonError(400, invalid);
    // acked/hidden/pinned/engaged_ts are reducer-derived; a wire event must not
    // smuggle them in (they would also corrupt rebuild-from-log). pinned is set
    // only by a pin event through the reducer, never carried on the wire.
    delete e.acked;
    delete e.hidden;
    delete e.pinned;
    delete e.engaged_ts;
    try {
      const seq = this.ingest(e);
      return Response.json({ seq });
    } catch (err) {
      return jsonError(500, String(err));
    }
  }

  // handleCommand deliberately never calls ingest. ingest is documented as the
  // single write path where every event gets a seq and is persisted, and that
  // stays literally true: a command is not an event and never enters it.
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
    const invalid = cmd.validateCommand(c);
    if (invalid) return jsonError(400, invalid);
    // The hub does not adjudicate targets: whoever owns the session decides
    // whether to act, so a command for a session this hub has never seen is
    // still delivered. `delivered` counts listeners reached, never work done.
    return Response.json({ ok: true, delivered: this.dispatch(c) });
  }

  // handlePair trades a valid pairing code for the bearer token. Unauthenticated
  // by design (the code is the credential), so every failure - no code, expired,
  // wrong, already redeemed, or a non-string - returns ONE uniform 401 body with
  // no oracle. There is deliberately no attempt counter and no failed-attempt
  // invalidation: a cap is a denial-of-pairing lever and useless against the
  // code's >=128-bit space.
  private async handlePair(req: Request): Promise<Response> {
    // application/json is load-bearing CSRF/CORS defence, exactly as /events:
    // text/plain and form encodings are CORS "simple requests" a hostile page
    // can send cross-origin without a preflight.
    const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return jsonError(415, "Content-Type must be application/json");
    }
    const body = await req.arrayBuffer();
    if (body.byteLength > maxBodyBytes) return jsonError(400, "body too large");
    let parsed: { code?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch (err) {
      return jsonError(400, `invalid json: ${err}`);
    }
    const code = parsed.code;
    // A non-string into timingSafeEqualStr's createHash().update throws, which a
    // 500 would turn into an oracle; fold it into the uniform 401.
    if (typeof code !== "string") return pairError();
    // MUST stay synchronous: an await between the lookup and marking redeemed
    // reopens double-redeem - two concurrent requests could both pass the
    // !redeemed check before either sets it. No yield happens in this block.
    const p = this.pairing;
    const ok =
      p !== null && !p.redeemed && Date.now() < p.expiresAt && timingSafeEqualStr(code, p.code);
    if (!ok) return pairError();
    p!.redeemed = true;
    return Response.json({ token: this.token });
  }

  // handlePairNew mints a fresh code into the single pairing slot, replacing any
  // prior one. Reachable by a loopback peer or any valid bearer holder - the
  // auth gate in handle() has already decided that, so no peer check here.
  private async handlePairNew(req: Request): Promise<Response> {
    const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return jsonError(415, "Content-Type must be application/json");
    }
    if (!this.token) {
      return jsonError(409, "no token configured: start the hub with SIGNALBOX_TOKEN and --bind to pair devices");
    }
    // 0.0.0.0 and :: are wildcards, NOT loopback, so they pass here (a remote
    // hub binds wide and passes too). A loopback bind means no phone could
    // reach the hub even holding the token, so a code would be useless -
    // refuse rather than mint one that cannot be redeemed.
    if (isLoopbackAddress(this.bind)) {
      return jsonError(409, "hub is bound to 127.0.0.1; restart with --bind 0.0.0.0 (or a LAN IP) and SIGNALBOX_TOKEN set");
    }
    // 16 bytes = 128 bits, base64url ~22 chars. Single slot: a new mint drops
    // any prior code, so only the most recently shown QR is ever live.
    const code = base64url(crypto.getRandomValues(new Uint8Array(16)));
    this.pairing = { code, expiresAt: Date.now() + 180_000, redeemed: false };
    // fp+port are present only when the LAN listener is TLS: they tell the
    // pairing UI (CLI and macOS app) to render an https QR on the TLS port,
    // carrying the pin. Omitted when empty so an older/plain-http hub's response
    // shape (and the phone dialling the loopback-derived port) is unchanged.
    return Response.json({
      code,
      expires_in: 180,
      bind: this.bind,
      ...(this.tlsFingerprint ? { fp: this.tlsFingerprint, port: this.tlsPort } : {}),
    });
  }

  // handlePairStatus reports the pairing slot for the CLI's poll loop; same
  // audience as /pair/new (loopback or bearer, decided at the auth gate). A
  // redeemed code reads "redeemed" even once expired, so the poll sees the
  // redemption it waited for.
  private handlePairStatus(): Response {
    const p = this.pairing;
    let status: "pending" | "redeemed" | "none";
    if (p && p.redeemed) status = "redeemed";
    else if (p && Date.now() < p.expiresAt) status = "pending";
    else status = "none";
    return Response.json({ status });
  }

  private handleStream(req: Request, url: URL, server: Bun.Server<undefined>): Response {
    const sinceRaw = url.searchParams.get("since");
    let since = 0;
    if (sinceRaw) {
      since = parseInt(sinceRaw, 10);
      if (Number.isNaN(since)) return jsonError(400, "since must be an integer seq");
    }
    // Bun kills idle HTTP connections after 10s by default - our heartbeat
    // is 15s, so a quiet stream would die before the first one (verified in
    // the rewrite spike). Zero disables the idle timeout for this request.
    server.timeout(req, 0);

    const subs = this.subs;
    const cmdSubs = this.cmdSubs;
    const backlog = this.log.filter((e) => (e.seq ?? 0) > since);
    let last = since;
    const enc = new TextEncoder();
    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream({
      start: (controller) => {
        const write = (text: string) => controller.enqueue(enc.encode(text));
        for (const e of backlog) {
          write(`event: signal\ndata: ${JSON.stringify(e)}\n\n`);
          last = e.seq ?? last;
        }
        const send: Subscriber = (e) => {
          // Events published between snapshot and subscribe were already
          // replayed from the backlog.
          if ((e.seq ?? 0) <= last) return;
          last = e.seq ?? last;
          write(`event: signal\ndata: ${JSON.stringify(e)}\n\n`);
        };
        subs.add(send);
        // Commands share this connection but not the backlog: there is nothing
        // to replay, because a command is never stored. `since` is meaningless
        // to them, which is exactly why they need their own subscriber - the
        // gate above would read a seq-less command as seq 0 and drop it.
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
        };
      },
      cancel: () => {
        cleanup?.();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        // no-store, matching /state: liveness surfaces must never be cached.
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  }
}

export function parseExchangeQuery(
  url: URL,
  historyLimit: number
): { session?: string; limit?: number; before?: number; error?: string } {
  const session = url.searchParams.get("session");
  if (session === null || session === "") return { error: "session is required" };
  const limitRaw = url.searchParams.get("limit");
  let limit = 20;
  if (limitRaw !== null) {
    // parseInt accepts a numeric prefix, so strict digits keep the 400 contract honest.
    if (!/^[0-9]+$/.test(limitRaw)) return { error: "limit must be a positive integer" };
    limit = parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1) return { error: "limit must be a positive integer" };
  }
  if (limit > historyLimit) limit = historyLimit;
  const beforeRaw = url.searchParams.get("before");
  let before: number | undefined;
  if (beforeRaw !== null) {
    if (!/^[0-9]+$/.test(beforeRaw)) return { error: "before must be a non-negative integer seq" };
    before = parseInt(beforeRaw, 10);
    if (!Number.isInteger(before) || before < 0) return { error: "before must be a non-negative integer seq" };
  }
  return { session, limit, before };
}

// next_before is the oldest returned seq on a non-empty page. An empty page
// returns null, so clients discover the end by requesting the next page.
export function exchangesBody(sessionKey: string, list: Exchange[]) {
  const oldest = list.length > 0 ? list[0].seq : null;
  return {
    session_key: sessionKey,
    exchanges: list,
    next_before: list.length > 0 ? oldest : null,
  };
}

export function isLoopbackHost(hostport: string): boolean {
  let host = hostport;
  // Strip :port - but not from a bare IPv6 literal.
  const bracket = hostport.match(/^\[(.+)\](?::\d+)?$/);
  if (bracket) host = bracket[1];
  else if (hostport.includes(":") && hostport.indexOf(":") === hostport.lastIndexOf(":")) {
    host = hostport.split(":")[0];
  }
  switch (host.toLowerCase()) {
    case "127.0.0.1":
    case "localhost":
    case "::1":
      return true;
  }
  return false;
}

// isLoopbackAddress classifies a peer address (from server.requestIP) or a bind
// host as loopback. It covers the whole 127.0.0.0/8 block, ::1, the IPv4-mapped
// loopback form Bun can report for a v4 connection, and the literal "localhost"
// a bind flag may carry. Anything else (0.0.0.0, ::, a LAN or public address)
// is non-loopback.
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "localhost" || a === "::1") return true;
  if (a.startsWith("127.")) return true;
  if (a.startsWith("::ffff:127.")) return true;
  return false;
}

// timingSafeEqualStr compares two strings in constant time. Hashing both sides
// first guarantees equal-length buffers (timingSafeEqual throws otherwise) and
// hides the secret's length.
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// validateBindConfig gates hub startup: binding to a non-loopback address with
// no token would expose the board to the network with no auth at all, so that
// combination is refused. Returns an error string to print, or null when the
// bind/token pair is safe. Loopback binds never need a token.
export function validateBindConfig(bind: string, token: string): string | null {
  if (isLoopbackAddress(bind)) return null;
  if (token) return null;
  return `refusing to bind ${bind} with no token: set SIGNALBOX_TOKEN so non-loopback clients must authenticate (a loopback bind needs no token)`;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export function noStoreJSON(body: unknown, status: number = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

// pairError is the one uniform /pair failure body. No code, expired, wrong,
// already redeemed and non-string all return it, so an attacker learns nothing
// about which of those it hit.
function pairError(): Response {
  return jsonError(401, "invalid or expired pairing code");
}

// base64url encodes bytes with the URL-safe alphabet and no padding, so a
// pairing code drops straight into a deep-link query with no percent-encoding.
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// listen starts one of the hub's servers. hostname defaults to loopback; pass a
// wider bind (e.g. a LAN IP) only alongside a token - runHub enforces that. When
// tls is given the listener serves https with that self-signed cert; the hub
// runs a plain-http loopback listener and a TLS LAN listener side by side, so
// local clients are never asked to trust the cert (see runHub, specs/ios).
export function listen(
  handler: RequestHandler,
  port: number,
  hostname: string = "127.0.0.1",
  tls?: { cert: string; key: string }
): Bun.Server<undefined> {
  const server = Bun.serve({
    hostname,
    port,
    ...(tls ? { tls } : {}),
    // Route dispatch happens in hub.handle so tests can drive it without a
    // socket; unknown paths 404 here.
    fetch: (req, srv) => handler.handle(req, srv) ?? jsonError(404, "not found"),
    // Overridden per-request for /stream; generous default elsewhere.
    idleTimeout: 30,
  });
  return server;
}
