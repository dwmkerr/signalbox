// signalbox pair: mint a short-lived code on the hub (loopback by default,
// --url for a remote hub with the bearer attached), render it as a QR the
// phone scans, and wait for the phone to redeem it. Only the code - never the
// token - crosses the screen; redeeming it trades it for the bearer token,
// which the phone then stores. See specs/events.md#pairing.

import { networkInterfaces } from "node:os";
import qr from "qrcode";
import { hubURL } from "./client";

// Interfaces that are never a real LAN address to hand a phone: VPN/tunnel
// endpoints (utun/tun/ppp) and Apple's peer-to-peer links (awdl/llw). The corp
// VPN in particular carries an RFC1918 10.x that would otherwise beat the real
// Wi-Fi address, so these are filtered by NAME before the RFC1918 preference.
const skipPrefixes = ["utun", "tun", "ppp", "awdl", "llw"];

function isPrivate(ip: string): boolean {
  if (ip.startsWith("192.168.") || ip.startsWith("10.")) return true;
  // 172.16.0.0 - 172.31.255.255
  const m = ip.match(/^172\.(\d+)\./);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

// lanIPv4 returns this machine's best LAN IPv4 for a phone to reach, or null.
// Preference: a real (non-tunnel) interface carrying an RFC1918 address; else
// the first real non-internal IPv4; else null. Never throws.
export function lanIPv4(): string | null {
  let fallback: string | null = null;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (skipPrefixes.some((p) => name.startsWith(p))) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (isPrivate(a.address)) return a.address;
      if (!fallback) fallback = a.address;
    }
  }
  return fallback;
}

interface MintResponse {
  code: string;
  expires_in: number;
  bind: string;
  // Present when the hub's LAN listener is TLS (#25): the SHA-256 pin the phone
  // uses to verify the self-signed cert, and the port that listener is on. Their
  // presence flips the QR to https on that port.
  fp?: string;
  port?: number;
}

// concreteHost is true when addr is a real dialable IP: not a wildcard bind
// (0.0.0.0/::) and not loopback. A wildcard bind tells the phone nothing about
// which interface to reach, so lanIPv4() must fill it in instead.
function concreteHost(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a === "" || a === "0.0.0.0" || a === "::") return false;
  if (a === "localhost" || a === "::1" || a.startsWith("127.")) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function pairTarget(mint: MintResponse, host: string, url: string, defaultPort: string): string {
  // A pin is usable only with its TLS port, so an incomplete TLS mint must not
  // manufacture an endpoint that the phone cannot verify.
  if (mint.fp && mint.port) return `https://${host}:${mint.port}`;
  if (url) return url;
  return `http://${host}:${defaultPort}`;
}

export function pairHost(mint: MintResponse, host: string, url: string): string {
  if (host) return host;
  // A complete pin selects the LAN path, so its advertised bind must win over
  // the otherwise preferred public URL host.
  if (!(mint.fp && mint.port) && url) return new URL(url).hostname;
  if (concreteHost(mint.bind)) return mint.bind;
  return lanIPv4() ?? "";
}

const pairURLError = "pair --url needs an https URL, e.g. --url https://my-hub.fly.dev";

export function parsePairArgs(args: string[]): { host: string; url: string } {
  let hostFlag = "";
  let urlFlag = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host") hostFlag = args[++i] ?? "";
    if (args[i] === "--url") {
      const value = args[++i] ?? "";
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(pairURLError);
      }
      if (
        parsed.protocol !== "https:"
        || parsed.username
        || parsed.password
        || parsed.pathname !== "/"
        || parsed.search
        || parsed.hash
      ) {
        throw new Error(pairURLError);
      }
      urlFlag = value;
    }
  }
  return { host: hostFlag, url: urlFlag };
}

export async function runPair(args: string[]): Promise<void> {
  const { host: hostFlag, url: urlFlag } = parsePairArgs(args);
  const base = urlFlag || hubURL();
  // A remote mint is not loopback, so the hub only honours it with a valid
  // bearer; fail here with a plain instruction instead of relaying its 401.
  const token = process.env.SIGNALBOX_TOKEN ?? "";
  if (urlFlag && !token) {
    throw new Error("pairing against --url needs SIGNALBOX_TOKEN set (the remote hub requires a bearer to mint)");
  }
  const auth: Record<string, string> = urlFlag ? { Authorization: `Bearer ${token}` } : {};

  let mint: MintResponse;
  try {
    const res = await fetch(new URL("/pair/new", base), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: "{}",
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.trim();
      try {
        msg = JSON.parse(text).error ?? msg;
      } catch {}
      throw new Error(msg || `hub returned ${res.status}`);
    }
    mint = JSON.parse(text) as MintResponse;
  } catch (err) {
    throw new Error(`could not mint a pairing code: ${err instanceof Error ? err.message : err}`);
  }

  // A remote QR should name the public host that accepted the mint; a local
  // bind is meaningful only for LAN pairing.
  const host = pairHost(mint, hostFlag, urlFlag);
  if (!host) throw new Error("could not determine a LAN IP to advertise; pass --host <ip>");

  const target = pairTarget(mint, host, urlFlag, new URL(base).port || "8377");
  // Encoding only the target keeps the base64url code and hex pin stable for
  // the iOS deep-link parser.
  const fpParam = mint.fp && mint.port ? `&fp=${mint.fp}` : "";
  const link = `signalbox://pair?url=${encodeURIComponent(target)}&code=${mint.code}${fpParam}`;

  const art = await qr.toString(link, { type: "terminal", small: true });
  process.stdout.write(art + "\n");
  console.log(link);
  console.log(`url:  ${target}`);
  console.log(`code: ${mint.code}`);
  console.log(`expires in ${mint.expires_in}s`);

  const deadline = Date.now() + mint.expires_in * 1000;
  for (;;) {
    let status = "none";
    try {
      const res = await fetch(new URL("/pair/status", base), { headers: auth });
      if (res.ok) status = ((await res.json()) as { status?: string }).status ?? "none";
    } catch {
      // A transient hub blip must not abort the wait; poll again.
    }
    if (status === "redeemed") {
      console.log("phone paired");
      return;
    }
    if (Date.now() >= deadline) throw new Error("code expired - run signalbox pair again");
    await sleep(2000);
  }
}
