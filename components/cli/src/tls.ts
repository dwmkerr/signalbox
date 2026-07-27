// Self-signed TLS for the hub's LAN listener. The phone pins the cert by the
// SHA-256 of its DER encoding, carried in the pairing QR - so a self-signed cert
// with no CA still gives real MITM-proof transport with zero user ceremony: an
// attacker presenting their own cert fails the pin. Local clients keep plain
// http on loopback (no MITM risk there), so only the phone's LAN path is TLS.

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export interface HubTLS {
  cert: string; // PEM, for Bun.serve
  key: string; // PEM, for Bun.serve
  // Lowercase hex SHA-256 of the DER cert - the value the phone pins. Matches
  // X509Certificate.fingerprint256 (minus the colons) and, on iOS, the SHA-256
  // of SecCertificateCopyData, so both sides compute the same 64 hex chars.
  fingerprint: string;
}

// ensureCert loads the persisted cert/key from stateDir, generating them once
// with openssl if absent. Pinning makes the cert's SANs and CN cosmetic (the
// phone skips hostname checks and trusts the pin alone), but loopback and the
// current LAN IP are listed anyway so a non-pinning client (curl, for debugging)
// can still validate by IP. Returns null when openssl is missing or generation
// fails; the caller then falls back to plain http and says why.
export function ensureCert(stateDir: string, lanIPs: string[]): HubTLS | null {
  const certPath = join(stateDir, "tls-cert.pem");
  const keyPath = join(stateDir, "tls-key.pem");
  try {
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      mkdirSync(stateDir, { recursive: true });
      const san = ["IP:127.0.0.1", ...lanIPs.map((ip) => `IP:${ip}`)].join(",");
      const res = spawnSync(
        "openssl",
        [
          "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
          "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "3650",
          "-subj", "/CN=signalbox", "-addext", `subjectAltName=${san}`,
        ],
        { stdio: "ignore" }
      );
      if (res.status !== 0 || !existsSync(certPath) || !existsSync(keyPath)) return null;
    }
    const cert = readFileSync(certPath, "utf8");
    const key = readFileSync(keyPath, "utf8");
    const der = new X509Certificate(cert).raw;
    const fingerprint = createHash("sha256").update(der).digest("hex");
    return { cert, key, fingerprint };
  } catch {
    return null;
  }
}
