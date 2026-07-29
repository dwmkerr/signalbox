import { describe, expect, test } from "bun:test";
import { pairHost, pairTarget, parsePairArgs } from "../src/pair";

function mint(tls: { fp?: string; port?: number } = {}) {
  return {
    code: "pair-code",
    expires_in: 120,
    bind: "0.0.0.0",
    ...tls,
  };
}

describe("pairTarget", () => {
  test("prefers a pinned LAN target over --url", () => {
    expect(pairTarget(mint({ fp: "aabbcc", port: 8443 }), "192.168.1.94", "https://my-hub.fly.dev", "8377"))
      .toBe("https://192.168.1.94:8443");
  });

  test("uses --url verbatim when the mint has no pin", () => {
    expect(pairTarget(mint(), "192.168.1.94", "https://my-hub.fly.dev", "8377"))
      .toBe("https://my-hub.fly.dev");
  });

  test("uses plain HTTP with the default port when --url is absent", () => {
    expect(pairTarget(mint(), "192.168.1.94", "", "8377"))
      .toBe("http://192.168.1.94:8377");
  });

  test("ignores a pin that has no TLS port", () => {
    expect(pairTarget(mint({ fp: "aabbcc" }), "192.168.1.94", "https://my-hub.fly.dev", "8377"))
      .toBe("https://my-hub.fly.dev");
    expect(pairTarget(mint({ fp: "aabbcc" }), "192.168.1.94", "", "8377"))
      .toBe("http://192.168.1.94:8377");
  });
});

describe("pairHost", () => {
  test("uses the mint bind when pinned LAN wins over --url", () => {
    expect(pairHost({ ...mint({ fp: "aabbcc", port: 8443 }), bind: "192.168.1.94" }, "", "https://my-hub.fly.dev"))
      .toBe("192.168.1.94");
  });

  test("uses the public host for an unpinned remote mint", () => {
    expect(pairHost(mint(), "", "https://my-hub.fly.dev"))
      .toBe("my-hub.fly.dev");
  });
});

describe("parsePairArgs", () => {
  test("preserves --url verbatim", () => {
    expect(parsePairArgs(["--url", "https://Hub.Dev/"]).url)
      .toBe("https://Hub.Dev/");
  });

  test("rejects credentials in --url", () => {
    expect(() => parsePairArgs(["--url", "https://user:pw@example.com"]))
      .toThrow("--url");
  });

  test("rejects a non-root path in --url", () => {
    expect(() => parsePairArgs(["--url", "https://example.com/foo"]))
      .toThrow("--url");
  });

  test("rejects a query in --url", () => {
    expect(() => parsePairArgs(["--url", "https://example.com/?x=1"]))
      .toThrow("--url");
  });

  test("rejects a fragment in --url", () => {
    expect(() => parsePairArgs(["--url", "https://example.com/#frag"]))
      .toThrow("--url");
  });

  test("rejects a missing or invalid --url value", () => {
    for (const args of [
      ["--url"],
      ["--url", "my-hub.fly.dev"],
      ["--url", "http://my-hub.fly.dev"],
      ["--url", "file:///etc/passwd"],
    ]) {
      expect(() => parsePairArgs(args)).toThrow("--url");
    }
  });

  test("parses --host without setting a url", () => {
    expect(parsePairArgs(["--host", "192.168.1.94"]))
      .toEqual({ host: "192.168.1.94", url: "" });
  });
});
