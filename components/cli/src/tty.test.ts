import { expect, test } from "bun:test";
import { ttyOrigin } from "./tty";

const iterm = { __CFBundleIdentifier: "com.googlecode.iterm2" };
const capture = (env: Record<string, string>, platform = "darwin", tty = "ttys002", agent = "claude") =>
  ttyOrigin(env, 42, agent, platform, (pid) => (pid === 42 ? tty : "??"));

test("captures the agent's tty in iTerm2 and Terminal.app", () => {
  expect(capture(iterm)).toEqual({ kind: "tty", tty: { path: "/dev/ttys002", terminal: "com.googlecode.iterm2" } });
  expect(capture({ __CFBundleIdentifier: "com.apple.Terminal" })?.tty?.terminal).toBe("com.apple.Terminal");
});

test.each([
  ["off macOS", iterm, "linux", "ttys002", "claude"],
  ["in other terminals", { __CFBundleIdentifier: "com.mitchellh.ghostty" }, "darwin", "ttys002", "claude"],
  ["inside tmux", { ...iterm, TMUX: "/tmp/tmux-501/default,1,0" }, "darwin", "ttys002", "claude"],
  ["without a tty", iterm, "darwin", "??", "claude"],
  ["for Codex", iterm, "darwin", "ttys002", "codex"],
])("captures nothing %s", (_name, env, platform, tty, agent) => {
  expect(capture(env, platform, tty, agent)).toBeNull();
});
