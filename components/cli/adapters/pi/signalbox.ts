/**
 * Signalbox pi extension.
 *
 * Fires signalbox events for the pi agent lifecycle:
 *   agent_start → busy · agent_end → done · session_shutdown → ended
 * The "input" event caches the user's prompt text; busy/done fires carry it
 * cropped as --detail (agent_start itself has no payload). agent_end carries
 * the transcript, so the done fire also passes the final assistant text
 * cropped as --reply - the palette's "last exchange" preview.
 * Every fire carries --pid/--pid-name (our own process: the extension runs
 * in-process) so the hub's liveness sweep can end sessions whose agent died
 * without an exit event.
 *
 * The CLI is spawned detached with stdio ignored so a hub outage or a slow
 * binary can never surface as a pi error. Fires are serialized: agent_end and
 * session_shutdown arrive back-to-back in print mode, and if both CLI
 * processes ran concurrently "ended" could reach the hub before "done",
 * resurrecting the session in /state after removal.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function resolveBinary(): string | undefined {
  const fromEnv = process.env.SIGNALBOX_BIN;
  if (fromEnv) return fromEnv;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "signalbox");
    if (existsSync(candidate)) return candidate;
  }
  // No binary means no fire - a notifier must never break the agent.
  return undefined;
}

type SessionCtx = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionName(): string | undefined;
    getCwd(): string;
  };
};

// Failsafe only: the CLI hook path finishes in well under a second (200ms
// POST timeout, 2s drain budget), so a wait this long means it is wedged and
// ordering is already lost - release the chain rather than stall pi.
const FIRE_EXIT_WAIT_MS = 5000;

// The contract caps content at the emitter - detail is one cropped line of
// 160 chars, reply one of 280: signals and a two-line breadcrumb of the
// exchange, never transcripts.
const DETAIL_MAX = 160;
const REPLY_MAX = 280;

function cropLine(text: unknown, max: number): string | undefined {
  if (typeof text !== "string") return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

const cropDetail = (text: unknown) => cropLine(text, DETAIL_MAX);
const cropReply = (text: unknown) => cropLine(text, REPLY_MAX);

// The reply is the agent's last *displayed* message: scan agent_end's
// transcript backwards for the newest assistant text block (thinking and
// tool-call blocks are not displayed output; an aborted turn may leave the
// final assistant message textless, so earlier assistant messages are the
// fallback). Typed structurally so a pi-ai type change degrades to "no
// reply" instead of a crash.
function replyFromMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message?.role !== "assistant" || !Array.isArray(message.content))
      continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j] as { type?: string; text?: unknown };
      if (block?.type !== "text") continue;
      const reply = cropReply(block.text);
      if (reply) return reply;
    }
  }
  return undefined;
}

// Proc identity for the hub's liveness sweep. The extension runs in-process,
// so our own pid is the agent's. The name must equal what the sweep reads
// later - basename of `ps -o comm=` - and pi rewrites it at boot
// (process.title = "pi" changes comm on macOS), so basename(execPath)
// ("node") would be wrong; ask ps for our own comm instead. Memoized: the
// title is set before extensions load, so comm is stable by the time we run.
let commPromise: Promise<string | undefined> | undefined;

function ownComm(): Promise<string | undefined> {
  commPromise ??= new Promise((resolve) => {
    try {
      execFile(
        "ps",
        ["-o", "comm=", "-p", String(process.pid)],
        { timeout: 2000 },
        (err, stdout) => {
          if (err) return resolve(undefined);
          const comm = stdout.trim();
          resolve(comm ? basename(comm) : undefined);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
  return commPromise;
}

// Fires are chained: the next CLI process is spawned only after the previous
// one has exited (i.e. its event reached the hub or the spool). Without this,
// "done" and "ended" race and the hub can apply them in the wrong order.
let fireChain: Promise<void> = Promise.resolve();

function spawnAndAwaitExit(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      // Detached + ignored stdio + unref: a CLI failure must never surface
      // as a pi error, and a lingering CLI must never hold pi's process open.
      const child = spawn(bin, args, { detached: true, stdio: "ignore" });
      child.unref();
      // The timer stays ref'd on purpose: pi exits the moment its event loop
      // drains, and with the child unref'd nothing else keeps the loop alive -
      // an in-flight fire (and anything queued behind it, e.g. "ended" right
      // after "done") would be silently dropped at shutdown.
      const timer = setTimeout(resolve, FIRE_EXIT_WAIT_MS);
      const settle = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", settle);
      child.once("error", settle);
    } catch {
      resolve();
    }
  });
}

function fire(
  event: "busy" | "done" | "ended",
  ctx: SessionCtx,
  detail?: string,
  reply?: string,
): Promise<void> {
  try {
    const bin = resolveBinary();
    if (!bin) return Promise.resolve();

    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd() || ctx.cwd || process.cwd();
    const title = ctx.sessionManager.getSessionName() || basename(cwd);

    const args = [
      "fire",
      "--agent",
      "pi",
      "--event",
      event,
      "--session-key",
      `pi:${sessionId}`,
      "--title",
      title,
      "--pid",
      String(process.pid),
    ];
    if (detail) args.push("--detail", detail);
    if (reply) args.push("--reply", reply);

    // Resolving comm inside the chain keeps fire order intact; when capture
    // fails the flag is omitted and the CLI resolves it from --pid with the
    // same ps read the sweep uses - better no name than a guessed-wrong one,
    // which would make the sweep end a live session.
    fireChain = fireChain.then(async () => {
      const name = await ownComm();
      return spawnAndAwaitExit(bin, name ? [...args, "--pid-name", name] : args);
    });
    return fireChain;
  } catch {
    // A notifier must never break the agent that calls it.
    return Promise.resolve();
  }
}

export default function (pi: ExtensionAPI) {
  // pi runs one session per process, so a single slot holds the last prompt.
  // The "input" event is the only carrier of the user's text (agent_start has
  // no payload); it fires before agent_start on every prompt path, including
  // print mode.
  let lastPrompt: string | undefined;

  pi.on("input", (event) => {
    lastPrompt = cropDetail(event.text) ?? lastPrompt;
  });

  // pi awaits extension handlers, so returning the chain keeps the process
  // alive in print mode until the final "ended" fire has been spawned.
  pi.on("agent_start", (_event, ctx) => fire("busy", ctx, lastPrompt));

  pi.on("agent_end", (event, ctx) =>
    fire("done", ctx, lastPrompt, replyFromMessages(event.messages)),
  );

  pi.on("session_shutdown", (_event, ctx) => fire("ended", ctx));
}
