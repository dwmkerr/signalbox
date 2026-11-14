import { spawnSync } from "node:child_process";
import type { Origin } from "./event";

const scriptable = new Set(["com.googlecode.iterm2", "com.apple.Terminal"]);

function ttyOf(pid: number): string {
  const out = spawnSync("ps", ["-o", "tty=", "-p", String(pid)]);
  return out.status === 0 ? (out.stdout?.toString().trim() ?? "") : "";
}

// ttyOrigin captures the tab an agent runs in by its controlling tty, which
// iTerm2 and Terminal.app expose to AppleScript. pid must be the agent: hooks
// run detached from the tty. Null off macOS, inside tmux (pane ptys belong to
// no tab), in other terminals (they cannot be searched by tty), and for Codex,
// whose hooks run under one shared app-server daemon, not the session.
export function ttyOrigin(
  env: Record<string, string | undefined>,
  pid: number,
  agent: string,
  platform: string = process.platform,
  tty: (pid: number) => string = ttyOf
): Origin | null {
  const terminal = env.__CFBundleIdentifier ?? "";
  if (platform !== "darwin" || env.TMUX || agent === "codex" || !scriptable.has(terminal)) return null;
  const name = tty(pid);
  return name.startsWith("tty") ? { kind: "tty", tty: { path: `/dev/${name}`, terminal } } : null;
}
