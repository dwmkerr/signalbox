# Remote Hub - Implementation Plan

Branch: `integration/remote-hub` - status: this is a planning artifact; no code changes yet.

## 1. Context and the one idea that makes this cheap

signalbox is local-first: a phone pairs to a laptop hub over the LAN (`components/cli/src/hub.ts`), pinned TLS on port 8378, plain http loopback on 8377. Hotel and corporate wifi with AP client-isolation break phone -> laptop, and Tailscale is out (corporate laptop). The agreed answer is a **remote hub**: the same `signalbox hub` binary running on a routable host (Fly), with the phone and every laptop dialing it.

The load-bearing realisation from reading the code: **most of the remote-hub primitives already exist.**

- The hub already binds wide, requires a bearer token off loopback, and auto-generates/persists one (`runHub` in `main.ts:551`, `validateBindConfig`/`shouldGenerateToken`).
- Events already carry `host` (`event.ts:76`, `ev.shortHostname()`), and jump commands already route by machine: the phone sends `target_host` (`HubClient.swift:452`), and the owning Mac self-selects with `isLocalHost(command.targetHost) && isLocalHost(session.host)` (`AppDelegate.swift:954`).
- The hook client already has a disk spool with an O_EXCL lock and a bounded drain (`client.ts` `Client.deliver`/`drain`/`spool`) - the forwarder's spool is the same pattern applied to the uplink.
- The forwarder shape is already written up as "Accepted: a local proxy (proposed)" in `components/specs/architecture.html:407` - a `signalbox hub --upstream <url>` that keeps no state, forwards POSTs up, relays the stream down, holds a read-through cache.

So this plan is mostly **hardening, packaging, and one genuinely new runtime mode (the forwarder)** - not a rewrite. The store stays a single hub owning state; forwarders are stateless relays. No CRDT, no hub-to-hub replication (already rejected in `architecture.html`).

Terminology used throughout: **hub** (the one that owns state, `Store`), **forwarder** (`hub --upstream`, no store), **viewer** (phone or `state`/menu bar reading a hub).

---

## 2. Design questions - resolved

Each of these is a decision, not an option list. Phases below assume these answers.

### 2.1 Machine identity scheme

**Problem.** Routing today keys on `host = shortHostname()`. Two machines both named `daves-mbp` collide: a jump aimed at one fires on both, and the board groups them as one. On the LAN this never bit because there was one machine per hub; on a shared remote hub it will.

**Decision: introduce a stable per-machine id, keep `host` as the display name.**
- Add `machine` to the event schema: a stable id generated once per machine and persisted at `${stateDir}/machine-id` (sibling of `events.jsonl`; `stateDir()` in `client.ts:31`). Format: `<shortHostname>-<6 hex>` (e.g. `daves-mbp-3f9a2c`) - human-readable, collision-safe, and it degrades gracefully in logs.
- `host` stays exactly as is (display grouping, the "on daves-mbp" text). `machine` is the routing key.
- `buildEvent` (`main.ts:162`) and `newUserEvent` (`event.ts:162`) stamp `machine` from a cached `machineID()` helper (new, in `event.ts`, reads/creates the file once).
- Backward compatibility: `machine` is **optional on read**. `normalizeInbound` (`event.ts:239`) fills `machine = host` when absent, so a pre-upgrade log and older emitters keep routing by hostname exactly as today. `validate` does **not** require it (mirrors how `cwd` is optional).

**Why not a bare UUID:** a UUID is unreadable in `state --json`, logs, and the jump-debug surface, and `host` already exists for humans - the id only needs to be unique, and hostname+suffix is both.

**Why not just "make hostname unique":** we do not control corporate hostnames and cannot rename them.

### 2.2 Command routing by machine

**Decision:** add `target_machine` to `Command` (`command.ts:22`) alongside the existing `target_host` (keep both; `target_host` stays for old clients). The executor requires `target_machine == localMachineID()` when the command carries one, falling back to the current `isLocalHost` pair when it does not. This is a superset of today's behaviour: existing `target_host`-only commands still work, and a `target_machine` command is unambiguous even under hostname collision. Phone `jump()` (`HubClient.swift:452`) and the CLI learn to send `target_machine`; the Mac executor (`AppDelegate.swift:947`) learns to prefer it.

### 2.3 Spool bounds, retention, location (forwarder uplink)

**Decision:** reuse the `client.ts` spool mechanism, second instance, upstream-only.
- **Location:** `${stateDir}/forward-spool.jsonl` (+ `.lock`), distinct from the hook path's `spool.jsonl` so a forwarder and local hooks never contend on one file.
- **Bound:** cap at **10,000 events or 16 MiB, whichever first** (events are ~1 KiB; this is generous for a wifi drop measured in minutes to hours). On overflow, **drop oldest** (ring semantics) and log one line - a stale event board is worth less than a fresh one, and the hub's own `events.jsonl` remains the durable record on the remote side.
- **Retention/replay:** on uplink recovery the forwarder drains oldest-first (existing bounded `drain`), preserving order. Events keep their origin `machine`/`host`, so replay lands correctly regardless of delay. Commands are **never spooled** (they are requests, meaningless once stale - same rule as the hub never logging them, `command.ts:5`).
- **Ordering caveat to document:** `seq` is assigned by the **upstream** hub on ingest, not the forwarder. The forwarder's local `/state` cache is fed by the downlink stream, so its view is always upstream-authoritative; the spool holds not-yet-sent events with no `seq` until the hub assigns one. This preserves the single-writer invariant.

### 2.4 Pairing flow for a remote hub

**Problem.** `/pair/new` and `/pair/status` are **loopback-only even with a valid bearer** (`hub.ts:338`, `hub.ts:375`; `events.md:254`). From your laptop you are never loopback to a Fly host, so no QR can be minted the current way.

**Decision: allow an authenticated bearer to mint remotely; keep loopback-only as the no-token path.**
- In `handlePairNew`/`handlePairStatus`, the guard becomes: allow if the peer is loopback **OR** the request carried a valid bearer token. A token holder is already fully trusted (they can read every prompt and forge events), so gating pairing behind loopback buys nothing against them - it only blocks the legitimate remote-admin flow. The uniform-401 and single-slot semantics are unchanged.
- `signalbox pair` (`pair.ts:64`) gains `--url <remote>`: it mints against that URL with `SIGNALBOX_TOKEN` attached, renders the QR locally, and polls `/pair/status` against the same URL. No SSH required. (SSH-in-and-run-`pair`-loopback still works too, for the token-averse.)
- **Remote TLS has no pin.** The Fly platform terminates real TLS, so the mint returns **no `fp`** and the QR carries `signalbox://pair?url=https://app.fly.dev&code=...` with an https scheme and no fingerprint. This requires two small changes:
  1. `pair.ts` scheme selection currently is `fp ? https : http` (`pair.ts:103`). Change to: **https when the target URL is already https** (remote) OR when `fp` is present (LAN pin); http only for a plain-http loopback/hand-entered hub.
  2. iOS `CertPinner` (`HubClient.swift:39`) currently **cancels** a server-trust challenge when no pin is set. Change to: **`performDefaultHandling`** (system CA validation) when the URL is https and no pin is configured; keep cancel-unless-pinned only when a pin **is** set (the LAN self-signed case). This is the crux iOS change that lets the phone trust a real Fly cert while still refusing an unpinned LAN MITM.

### 2.5 Does the phone keep direct-LAN mode alongside upstream?

**Decision: yes, and it needs no "mode".** The phone dials whatever hub URL it was paired to - a LAN `https://192.168.x` with a pin, or a remote `https://app.fly.dev` with system trust. `HubConfig` is already a list-of-hubs shape (`HubClient.swift:82`) even though the UI shows one. v1 keeps a single active hub; the LAN vs remote distinction is entirely captured by "is there a pin". No branching mode, no new state machine.

### 2.6 Board UI treatment of multi-machine

**Decision: reuse the host chips that already exist.** iOS `adopt()` already builds a `hosts` array and the board shows per-host chips (`HubClient.swift:361`), and the macOS jumplist already renders "on `<host>`" (`AppDelegate.swift:716`). With several laptops on one remote hub these light up naturally. v1 change is display-only: **group/label by `host`** (unchanged) but **de-collide using `machine`** where two hosts share a name (append the suffix in the chip only when needed). No new UI surface. Update `components/specs/ios.html` and `hub-jumplist.html` mocks to show a two-machine board.

### 2.7 What happens to the `/pair/new` loopback-only rule

Relaxed to "loopback **or** valid bearer" (see 2.4). Documented in `events.md` endpoints table (`events.md:233`, `:254`) and `architecture.html`. The security note changes from "only the hub machine starts a pairing" to "the hub machine, or any token holder, starts a pairing - a token holder is already fully trusted."

### 2.8 Auth between forwarder and hub

**Decision: bearer token, exactly like any non-loopback viewer.** The forwarder holds `SIGNALBOX_TOKEN` and attaches it on every upstream POST and on the upstream `/stream` GET. Its **own** loopback listener stays unauthenticated (local trust, per the existing model). This is precisely the `architecture.html:407` proxy: "the token lives in exactly one place per machine" - hooks, menu bar, and picker all speak unauthenticated loopback to the forwarder, which is the sole holder of the upstream credential.

---

## 3. Phasing

Four phases. 1-3 are the critical path; 4 is optional sugar. Each phase is independently shippable and leaves `main` green.

---

### Phase 1 - Remote hub hardening + self-deploy guide

**Goal.** A user can `docker run` / `fly deploy` the existing hub image, pair a phone straight to it over the public URL, and point adapters at it with `SIGNALBOX_URL`. No forwarder yet - this phase proves the hub is safe and reachable when it is the remote.

**Acceptance ("Dave in a hotel can..."):** Dave has previously deployed the hub to Fly from home. In the hotel, his phone (on hotel wifi or LTE) opens the app and sees his live board, because the board lives on Fly, not on the laptop across the isolated AP. His laptop's Claude/Codex hooks post to the Fly hub via `SIGNALBOX_URL` and appear on the phone within seconds.

**Code changes.**

1. **TLS-behind-proxy audit** (`hub.ts`, `main.ts:589`). The hub's TLS path assumes it terminates TLS itself (self-signed, `ensureCert`, `tlsPort = port+1`). Behind Fly, the platform terminates TLS and the hub should serve **plain http on one port, bound wide, token-gated**, with no self-signed listener. Add a startup path (env `SIGNALBOX_TLS=off` or auto-detect "no cert requested + wide bind"): bind `0.0.0.0:8377` http only, require the token, skip `ensureCert`. Verify `server.requestIP(req)?.address` (`hub.ts:187`) reports the **proxy/real peer**, not a loopback sidecar - if Fly presents connections from a loopback address, the loopback-auth branch would wrongly exempt real clients. **This is the single highest-risk item in the phase**; mitigation below.

2. **Bind/token audit.** Confirm `validateBindConfig` (`hub.ts:499`) + `shouldGenerateToken` (`config.ts:155`) refuse a wide bind with no token - already true. Add a container-friendly knob: token supplied via `SIGNALBOX_TOKEN` (already read, `main.ts:567`) as the documented deploy path, so the image never persists a generated token into an ephemeral filesystem.

3. **Remote pairing** (`hub.ts` pair guards + `pair.ts`): implement 2.4 - bearer-or-loopback minting, `signalbox pair --url`, https-when-url-https scheme selection.

4. **iOS system-trust for https-no-pin** (`HubClient.swift:39`): implement 2.4's `CertPinner` change.

5. **Deploy artifacts** (new files):
   - `Dockerfile` (repo root or `packaging/`): multi-stage - `oven/bun` to `bun build --compile` the CLI (`make build` path), copy the single binary into a slim base, `ENTRYPOINT ["signalbox","hub"]`, `EXPOSE 8377`, `HEALTHCHECK` hitting `/healthz` (already unauthenticated, `hub.ts:177`). State dir on a mounted volume so `events.jsonl` survives restarts.
   - `packaging/fly.toml.tmpl`: one app, one service on 8377, `[http_service]` with Fly TLS termination, a persistent volume for `${SIGNALBOX_STATE_DIR}`, `SIGNALBOX_TOKEN` as a Fly secret, health check on `/healthz`.
   - CI: publish `ghcr.io/dwmkerr/signalbox` on release (extend the existing release workflow; note `version` const `main.ts:33` and release-please watches `components/cli`).

**Spec updates (required this phase).**
- `components/specs/cli.md`: `pair --url`, the `SIGNALBOX_TLS` knob, container env.
- `components/specs/events.md`: pair endpoints table (`:233`) - "loopback or valid bearer"; security notes (`:254`, the "only the hub machine" line).
- `components/specs/architecture.html`: add a "remote hub" tier section (platform-terminated TLS, bearer, self-deploy only, no multi-tenant).
- `components/specs/ios.html`: pairing to a remote https hub with system trust (no pin) alongside the pinned-LAN case.
- New `docs/remote-hub.md`: the self-deploy guide (build image, `fly launch`, set the token secret, `pair --url`, point `SIGNALBOX_URL`). Cross-link from `docs/mobile.md`.

**Tests.** `bun test` for pair-guard logic (bearer allows mint off-loopback; no-token still loopback-only; uniform 401 preserved), scheme selection in `pair.ts` (https for https url, http for plain loopback, https+fp for LAN). Manual: `shellwright`/curl against a locally-run wide-bound hub simulating the proxy peer address; a real Fly smoke deploy paired to a physical phone.

**Risks / not included.**
- **Proxy peer-address risk** (item 1): if Fly forwards from a loopback-appearing address, real clients skip auth. Mitigation: an explicit `SIGNALBOX_TRUST_PROXY=off` that **disables the loopback-exemption entirely** when set, forcing bearer for every request regardless of reported peer - the correct posture for any public deployment. Verify actual Fly peer semantics in the smoke deploy before documenting.
- Does **not** include the forwarder, spool, or multi-machine identity. Adapters point at the remote directly and carry the token in their env this phase (the leak the forwarder later closes).
- No hosted multi-tenant service. Self-deploy only.

**Issues:** closes the core of **#4** (bearer auth + Fly self-deploy example). Unblocks **#5** (mobile epic). Amends **#25** (pinned-cert pairing now coexists with system-trust remote pairing). Doc follow-up noted for **#37** (corporate-network guide should point at remote hub) and **#22** (Tailscale doc deprioritised - add a "consider the remote hub instead" note).

---

### Phase 2 - The forwarder (`hub --upstream`) with spool + read replica + machine identity

**Goal.** `signalbox hub --upstream <url>` runs on the laptop: local clients speak unauthenticated loopback to it, it forwards writes upstream with the token, relays the downstream stream, serves `/state` from a read-through cache, and spools+replays across uplink drops. Machine identity (`machine`) is introduced here because a shared remote hub is now real.

**Acceptance ("Dave in a hotel can..."):** Dave runs `signalbox hub --upstream https://app.fly.dev` on his laptop (the menu bar app spawns it). His hooks post to loopback as always - **no token in any hook env**. Events reach Fly; his phone sees them. When the hotel wifi flaps, events spool locally and replay on reconnect with nothing lost, and his menu bar keeps rendering the last known board from the cache instead of going blank.

**Code changes.**

1. **`--upstream` flag** (`main.ts:551` `runHub`): when set, construct a forwarder instead of a `Hub`. New `components/cli/src/forwarder.ts`:
   - Loopback http listener reusing `listen()` (`hub.ts:529`), unauthenticated (local trust).
   - `POST /events` and `POST /command`: forward upstream with `Authorization: Bearer` attached; on `/events` failure, spool (a `Client`-style spool, upstream-only, 2.3). `/command` failures are reported, never spooled.
   - Upstream `/stream?since=N` subscription (long-lived, backoff-reconnecting - mirror `HubClient.runStreamLoop`), feeding the local cache and **re-broadcasting** both `signal` and `command` frames to local subscribers so the menu bar's command executor (`AppDelegate.swift:947`) still receives jumps.
   - `GET /state`: serve the cache (materialised view from the downlink, `architecture.html:448`). `GET /healthz`: local, reports uplink status.
   - Reuse the spool/lock/drain code from `client.ts` (extract the spool into a small shared module rather than copy-paste).

2. **Machine identity** (2.1): `machineID()` helper + `machine` field; stamp in `buildEvent` (`main.ts:192`) and `newUserEvent` (`event.ts:167`); `normalizeInbound` fills `machine=host` when absent (`event.ts:239`); reducer carries it like other breadcrumbs (`state.ts`).

**Spec updates (required).**
- `components/specs/architecture.html`: promote the forwarder from "proposed" to accepted/implemented; add the spool+replay detail.
- `components/specs/events.md`: `machine` field in the schema block (`:30` area), the carry rule (`:134`), and normalization note.
- `components/specs/cli.md`: `hub --upstream <url>` flag and behaviour.
- `components/specs/adapters.md`: adapters point at loopback (the forwarder), token-free - reaffirm.

**Tests.** `bun test`: forwarder forwards with token; spool captures on upstream-down and drains on recovery (drive the existing spool tests against the forwarder path); cache serves `/state` while uplink is down; `machine` stamped and `normalizeInbound` backfills. Integration: forwarder against a local hub, kill/restore the hub, assert no event loss and command relay.

**Risks / not included.**
- Downlink echo / double-count: the forwarder must **not** re-ingest its own relayed stream into any local store - it has no store, which is exactly why the "no state" rule holds. Guard against a local `/events` that both spools and gets echoed back down.
- Not included: command routing changes (Phase 3) - jumps still route by `host` via the relayed command frames, which works for the single-laptop case even before `target_machine` lands.
- Not included: `deploy fly` sugar (Phase 4).

**Issues:** completes **#4**'s proxy half. Progresses **#14** (leader + forwarders topology now exists).

---

### Phase 3 - Command routing by machine (jump-back across machines)

**Goal.** With several laptops on one remote hub, a phone jump lands on the **right** laptop even under hostname collision. This is the small delta that finishes the multi-machine story.

**Acceptance ("Dave in a hotel can..."):** Dave has two laptops (both `daves-mbp`) both forwarding to Fly. He taps a session on his phone that belongs to the work laptop; only the work laptop jumps, not the personal one.

**Code changes.**
- `command.ts:22`: add `target_machine` (keep `target_host`). `validateCommand` accepts it.
- `HubClient.swift:452` `jump()`: send `target_machine` from the tapped row's `machine`.
- iOS `Session`/`SessionEvent` decode `machine`; `adopt()` (`HubClient.swift:361`) carries it.
- macOS executor `perform()` (`AppDelegate.swift:947`): prefer `target_machine == localMachineID()`; fall back to the `isLocalHost` pair when the command has no `target_machine` (old phones).
- CLI: expose `localMachineID()` so the app reads the same id the CLI stamps (single source in `event.ts`).

**Spec updates (required).**
- `components/specs/events.md`: commands table (`:171`) and the command schema (`:186`) - `target_machine`, and the "acts only if both name it" rule extended to machine.
- `components/specs/ios.html` + `hub-jumplist.html`: two-machine board mock (2.6).

**Tests.** `bun test` for `validateCommand` with `target_machine`; a Swift-level unit on `perform()`'s selection precedence. Manual two-machine jump test.

**Risks / not included.** Backward compat is the whole risk: an old phone sends only `target_host`, a new one sends both - the executor must handle both without double-jumping. Not included: any content-bearing command (`message`) - explicitly out of scope per `architecture.html` (needs per-machine authz first).

**Issues:** closes **#14** (multi-machine RFC realised for jump).

---

### Phase 4 (optional) - `signalbox deploy fly` sugar

**Goal.** A thin `flyctl` wrapper so a first deploy is one command instead of a guide. **Only if there is demand** - keep off the critical path.

**Code changes.** `main.ts` dispatch: `deploy fly` subcommand shelling out to `flyctl` with the `fly.toml.tmpl` from Phase 1, prompting for/creating the token secret. No new server behaviour.

**Spec updates.** `components/specs/cli.md`: the `deploy fly` command.

**Tests.** Smoke only (it wraps an external CLI).

**Risks / not included.** Do not reimplement Fly auth or deploy state; if `flyctl` is absent, print the manual guide from Phase 1 and stop. Not a hosted service.

**Issues:** an ergonomic follow-up on **#4**; open a dedicated issue rather than blocking #4's close.

---

## 4. Cross-cutting notes

- **Specs are source of truth** (`CLAUDE.md`): every phase above lists its spec edits; a behaviour change with no spec edit is a failing state. The `.html` mocks (`ios.html`, `hub-jumplist.html`, `settings.html`, `architecture.html`) are living specs, not illustrations.
- **Conventions:** Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`); regular hyphens only, never em-dashes; comments explain *why*. Push at end of day, commit locally as you go.
- **Version/release:** `version` is a single const (`main.ts:33`) release-please stamps; the macOS and iOS apps build from it. A forwarder is CLI-only, so it rides a normal `feat:` release.
- **What stays unchanged:** the reducer's single-writer store, the loopback trust model, the LAN pinned-TLS path (`#25`), and every existing hook/tmux/menu-bar surface. The forwarder's whole value is that nothing local changes.

## 5. Issue map (summary)

| Issue | Phase | Effect |
|---|---|---|
| #4 remote hub bearer + Fly example | 1 (core), 2 (proxy) | Closed after Phase 2 |
| #5 mobile epic | 1 | Unblocked |
| #14 multi-machine (leader+forwarders, one QR) | 2 (topology), 3 (routing) | Closed after Phase 3 |
| #25 pinned-cert HTTPS pairing | 1 | Amended (system-trust remote coexists) |
| #22 Tailscale docs | 1 | Deprioritised; add "prefer remote hub" note |
| #37 corporate-network mobile guide | 1 | Doc follow-up: point at remote hub |

**Open a new issue** for Phase 4 (`deploy fly` sugar) rather than blocking #4.

---

**One assumption to sanity-check before Phase 1 ships:** the proxy peer-address behaviour on Fly (Phase 1, item 1). Whether Fly presents client connections to the hub from a loopback-appearing address decides whether the existing loopback-auth exemption (`hub.ts:187`) is a security hole in a public deployment. The `SIGNALBOX_TRUST_PROXY=off` mitigation is planned, but that assumption needs confirming in a real smoke deploy first.
