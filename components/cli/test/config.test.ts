import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// loadSettings resolves the file under $HOME (via os.homedir()), which Bun
// fixes at process start - so each case runs in a child process with its own
// HOME and env, exercising the real file-read and env-override paths.
const configSrc = join(import.meta.dir, "..", "src", "config.ts");

function loadIn(env: Record<string, string>, settings?: unknown): boolean {
  const home = mkdtempSync(join(tmpdir(), "sb-config-"));
  if (settings !== undefined) {
    const dir = join(home, ".config", "signalbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  }
  const proc = Bun.spawnSync(
    ["bun", "-e", `import { loadSettings } from ${JSON.stringify(configSrc)}; process.stdout.write(String(loadSettings().claudeRenameTitle));`],
    { env: { ...process.env, HOME: home, SIGNALBOX_CLAUDE_RENAME: "", ...env } }
  );
  return proc.stdout.toString().trim() === "true";
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
