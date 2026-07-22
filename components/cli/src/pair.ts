// signalbox pair: mint a short-lived code on the loopback hub, render it as a
// QR the phone scans, and wait for the phone to redeem it. Only the code - never
// the token - crosses the screen; redeeming it over loopback trades it for the
// bearer token, which the phone then stores. See specs/events.md#pairing.

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

export async function runPair(args: string[]): Promise<void> {
  let hostFlag = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host") hostFlag = args[++i] ?? "";
  }
  const base = hubURL();

  // Mint on the loopback hub. /pair/new is loopback-only, so this runs on the
  // hub machine; a 403/409 carries the hub's own guidance, printed verbatim.
  let mint: MintResponse;
  try {
    const res = await fetch(`${base}/pair/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  // The host to advertise: --host wins, else the hub's bind when concrete, else
  // this machine's LAN IPv4.
  let host = hostFlag;
  if (!host && concreteHost(mint.bind)) host = mint.bind;
  if (!host) host = lanIPv4() ?? "";
  if (!host) throw new Error("could not determine a LAN IP to advertise; pass --host <ip>");

  // The phone dials the hub's port; the mint response has no port, so take it
  // from the URL we minted against (loopback and LAN share the one bound port).
  const port = new URL(base).port || "8377";
  const target = `http://${host}:${port}`;
  // Deep-link contract (specs/ios): the url value is percent-encoded, the
  // base64url code rides raw.
  const link = `signalbox://pair?url=${encodeURIComponent(target)}&code=${mint.code}`;

  const art = await qr.toString(link, { type: "terminal", small: true });
  process.stdout.write(art + "\n");
  console.log(link);
  console.log(`url:  ${target}`);
  console.log(`code: ${mint.code}`);
  console.log(`expires in ${mint.expires_in}s`);

  // Poll the loopback status until the phone redeems or the code lapses.
  const deadline = Date.now() + mint.expires_in * 1000;
  for (;;) {
    let status = "none";
    try {
      const res = await fetch(`${base}/pair/status`);
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
