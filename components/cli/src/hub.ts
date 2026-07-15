// The signalbox hub: ingest, state, SSE stream, JSONL persistence, and the
// expiry/liveness sweeps. Behaviour per specs/events.md.

import { appendFileSync, mkdirSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import * as ev from "./event";
import type { Event } from "./event";
import { Store } from "./state";
import { procAlive } from "./proc";

const heartbeatMs = 15_000;
// Bounds a single POST body; events are tiny, so anything bigger is junk.
const maxBodyBytes = 1 << 20;

type Subscriber = (e: Event) => void;

export class Hub {
  private seq = 0;
  private log: Event[] = [];
  private store = new Store();
  private subs = new Set<Subscriber>();
  private logFd: number;
  private timers: ReturnType<typeof setInterval>[] = [];
  private logPath: string;

  // Rebuilds state from events.jsonl in stateDir (creating it if needed).
  // Seq continues from the highest persisted value.
  constructor(
    stateDir: string,
    private version: string
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.logPath = join(stateDir, "events.jsonl");
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
  }

  // ingest is the single write path - POST /events and the sweeps all go
  // through it, so every event gets a seq and is persisted, applied and
  // broadcast identically. Persist failure refuses the event rather than
  // acknowledging one that would vanish on restart.
  ingest(e: Event): number {
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

  sessions(): Event[] {
    return this.store.list();
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

  // fetch handles one HTTP request; returns undefined for unknown routes.
  handle(req: Request, server: Bun.Server<undefined>): Response | Promise<Response> | undefined {
    // 403 any request whose Host header is not a loopback literal: a hostile
    // page can point a DNS name it controls at 127.0.0.1 (DNS rebinding) and
    // read /state same-origin. No bearer auth: loopback-with-no-auth is the
    // v0 contract.
    if (!isLoopbackHost(req.headers.get("host") ?? "")) {
      return jsonError(403, "forbidden: hub only answers loopback hosts");
    }
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/events") return this.handleEvents(req);
    if (req.method === "GET" && url.pathname === "/state") {
      return Response.json({ sessions: this.sessions() });
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, version: this.version });
    }
    if (req.method === "GET" && url.pathname === "/stream") {
      return this.handleStream(req, url, server);
    }
    return undefined;
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
    // acked/hidden/engaged_ts are reducer-derived; a wire event must not
    // smuggle them in (they would also corrupt rebuild-from-log).
    delete e.acked;
    delete e.hidden;
    delete e.engaged_ts;
    try {
      const seq = this.ingest(e);
      return Response.json({ seq });
    } catch (err) {
      return jsonError(500, String(err));
    }
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
        };
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

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

// listen starts the hub's HTTP server on loopback.
export function listen(hub: Hub, port: number): Bun.Server<undefined> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // Route dispatch happens in hub.handle so tests can drive it without a
    // socket; unknown paths 404 here.
    fetch: (req, srv) => hub.handle(req, srv) ?? jsonError(404, "not found"),
    // Overridden per-request for /stream; generous default elsewhere.
    idleTimeout: 30,
  });
  return server;
}
