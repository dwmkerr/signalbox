import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeBindInput, shouldGenerateToken, generateToken } from "../src/config";

// loadSettings and saveSettings resolve the file under $HOME (via os.homedir()),
// which Bun fixes at process start - so the file-backed cases run in a child
// process with its own HOME, exercising the real read/write paths against a temp
// settings.json and never the developer's real one.
const configSrc = join(import.meta.dir, "..", "src", "config.ts");

function loadIn(env: Record<string, string>, settings?: unknown): boolean {
  const home = freshHome(settings);
  const proc = Bun.spawnSync(
    ["bun", "-e", `import { loadSettings } from ${JSON.stringify(configSrc)}; process.stdout.write(String(loadSettings().claudeRenameTitle));`],
    { env: { ...process.env, HOME: home, SIGNALBOX_CLAUDE_RENAME: "", ...env } }
  );
  return proc.stdout.toString().trim() === "true";
}

// freshHome makes an isolated HOME, optionally seeding settings.json.
function freshHome(settings?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "sb-config-"));
  if (settings !== undefined) {
    const dir = join(home, ".config", "signalbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  }
  return home;
}

// inHome runs a config snippet in a child bun process bound to `home`, so
// loadSettings/saveSettings hit that home's temp settings.json. `expr` may write
// to stdout; the returned string is that output. Hub env is blanked so a stray
// SIGNALBOX_BIND/TOKEN on the runner cannot leak in.
function inHome(home: string, expr: string, env: Record<string, string> = {}): string {
  const proc = Bun.spawnSync(
    ["bun", "-e", `import * as c from ${JSON.stringify(configSrc)}; ${expr}`],
    { env: { ...process.env, HOME: home, SIGNALBOX_CLAUDE_RENAME: "", SIGNALBOX_BIND: "", SIGNALBOX_TOKEN: "", ...env } }
  );
  return proc.stdout.toString();
}

describe("claudeRenameTitle", () => {
  test("defaults to true when the file is missing", () => {
    expect(loadIn({})).toBe(true);
  });

  test("reads false from settings.json", () => {
    expect(loadIn({}, { claudeRenameTitle: false })).toBe(false);
  });

  test("env override wins over the file", () => {
    expect(loadIn({ SIGNALBOX_CLAUDE_RENAME: "0" }, { claudeRenameTitle: true })).toBe(false);
    expect(loadIn({ SIGNALBOX_CLAUDE_RENAME: "1" }, { claudeRenameTitle: false })).toBe(true);
  });
});

describe("hub settings", () => {
  test("defaults to loopback and no token when the file is missing", () => {
    const out = inHome(freshHome(), `process.stdout.write(JSON.stringify(c.loadSettings().hub));`);
    expect(JSON.parse(out)).toEqual({ bind: "127.0.0.1", token: "" });
  });

  test("reads hub.bind and hub.token from settings.json", () => {
    const home = freshHome({ hub: { bind: "0.0.0.0", token: "abc123" } });
    const out = inHome(home, `process.stdout.write(JSON.stringify(c.loadSettings().hub));`);
    expect(JSON.parse(out)).toEqual({ bind: "0.0.0.0", token: "abc123" });
  });

  test("a partial hub section still gets the missing key's default", () => {
    const home = freshHome({ hub: { bind: "0.0.0.0" } });
    const out = inHome(home, `process.stdout.write(JSON.stringify(c.loadSettings().hub));`);
    expect(JSON.parse(out)).toEqual({ bind: "0.0.0.0", token: "" });
  });
});

describe("saveSettings", () => {
  test("merges into hub without clobbering the app's own keys", () => {
    const home = freshHome({ claudeClearEnds: false, hub: { bind: "127.0.0.1", token: "" } });
    const out = inHome(
      home,
      `c.saveSettings({ hub: { token: "deadbeef" } });` +
        `const s = c.loadSettings(); process.stdout.write(JSON.stringify({ clear: s.claudeClearEnds, hub: s.hub }));`
    );
    expect(JSON.parse(out)).toEqual({ clear: false, hub: { bind: "127.0.0.1", token: "deadbeef" } });
  });

  test("creates the config dir and file when absent, pretty-printed", () => {
    const home = freshHome();
    inHome(home, `c.saveSettings({ hub: { bind: "0.0.0.0" } });`);
    const path = join(home, ".config", "signalbox", "settings.json");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(JSON.parse(text).hub.bind).toBe("0.0.0.0");
    // Pretty-printed (two-space indent), not a single minified line.
    expect(text).toContain('\n  "hub"');
  });

  test("persists the normalized literal, never the friendly word", () => {
    // The contract config set relies on: bind means bind, so a value like "any"
    // is normalized to its literal before it ever reaches the file.
    const home = freshHome();
    inHome(home, `c.saveSettings({ hub: { bind: c.normalizeBindInput("any").value } });`);
    const path = join(home, ".config", "signalbox", "settings.json");
    expect(JSON.parse(readFileSync(path, "utf8")).hub.bind).toBe("0.0.0.0");
  });
});

describe("normalizeBindInput", () => {
  test("maps the loopback words to 127.0.0.1 (this machine only)", () => {
    expect(normalizeBindInput("loopback").value).toBe("127.0.0.1");
    expect(normalizeBindInput("local").value).toBe("127.0.0.1");
    // Case-insensitive: the word is convenience input, not a literal.
    expect(normalizeBindInput("LoopBack").value).toBe("127.0.0.1");
  });

  test("maps any/all/0.0.0.0 to the 0.0.0.0 wildcard", () => {
    // The wildcard is the honest way to let other devices connect: it also
    // serves loopback (local hooks, the menu bar app), and does not go stale
    // under DHCP the way a single pinned interface IP would.
    expect(normalizeBindInput("any").value).toBe("0.0.0.0");
    expect(normalizeBindInput("all").value).toBe("0.0.0.0");
    expect(normalizeBindInput("0.0.0.0").value).toBe("0.0.0.0");
  });

  test("passes explicit IP literals straight through", () => {
    expect(normalizeBindInput("192.168.1.5").value).toBe("192.168.1.5");
    expect(normalizeBindInput("10.0.0.1").value).toBe("10.0.0.1");
    expect(normalizeBindInput("::").value).toBe("::");
    expect(normalizeBindInput("fe80::1").value).toBe("fe80::1");
  });

  test("rejects 'lan' as ambiguous, steering toward any or a specific IP", () => {
    // The whole point of the change: "lan" reads as "my LAN IP" but a wildcard
    // also answers VPN interfaces, so the word is refused rather than guessed.
    const r = normalizeBindInput("lan");
    expect(r.value).toBeUndefined();
    expect(r.error).toContain("ambiguous");
    expect(r.error).toContain("any");
  });

  test("rejects empty and obvious typos with an error, no value", () => {
    for (const bad of ["", "lann", "loop back", "hello"]) {
      const r = normalizeBindInput(bad);
      expect(r.value).toBeUndefined();
      expect(r.error).toBeDefined();
    }
  });
});

describe("shouldGenerateToken", () => {
  test("true only for a non-loopback bind with no token", () => {
    expect(shouldGenerateToken("192.168.1.5", "")).toBe(true);
    expect(shouldGenerateToken("0.0.0.0", "")).toBe(true);
    expect(shouldGenerateToken("192.168.1.5", "tok")).toBe(false);
    expect(shouldGenerateToken("127.0.0.1", "")).toBe(false);
    expect(shouldGenerateToken("127.0.0.1", "tok")).toBe(false);
  });
});

describe("generateToken", () => {
  test("mints a url-safe token, distinct each call", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(20);
    expect(generateToken()).not.toBe(t);
  });
});
