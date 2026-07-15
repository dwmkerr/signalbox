/**
 * Signalbox opencode plugin.
 *
 * Contract mapping (specs/adapters.md):
 *   session.status busy|retry → busy · session.idle → done ·
 *   permission.asked → attention · session.error → error ·
 *   session.deleted → ended.  session_key = opencode:<sessionID>.
 *   detail = last user prompt (cropped), cached from message.updated +
 *   message.part.updated and sent on busy/done/attention/error.
 *   reply = last assistant text part (cropped), cached the same way and
 *   sent on done/attention - the palette's "last exchange" preview.
 *   Every fire carries --pid/--pid-name (our own process: the plugin runs
 *   in-process) so the hub's liveness sweep can end sessions whose agent
 *   died without an exit event.
 *
 * The CLI is spawned detached with stdio ignored so opencode is never
 * blocked, even if the hub is down. Fires are serialized because done and
 * ended can be emitted back-to-back; concurrent CLI processes would race and
 * could deliver "ended" before "done", resurrecting a removed session.
 */
import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, delimiter, join } from "node:path"

function resolveBinary() {
  const fromEnv = process.env.SIGNALBOX_BIN
  if (fromEnv) return fromEnv
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, "signalbox")
    if (existsSync(candidate)) return candidate
  }
  // No binary means no fire - a notifier must never break the agent.
  return undefined
}

// Failsafe only: the CLI hook path finishes in well under a second, so a
// wait this long means it is wedged - release the chain rather than let it
// back up behind a dead process.
const FIRE_EXIT_WAIT_MS = 5000

// The contract caps content at the emitter - detail is one cropped line of
// 160 chars, reply one of 280: signals and a two-line breadcrumb of the
// exchange, never transcripts.
const DETAIL_MAX = 160
const REPLY_MAX = 280

function cropLine(text, max) {
  if (typeof text !== "string") return undefined
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (!oneLine) return undefined
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine
}

const cropDetail = (text) => cropLine(text, DETAIL_MAX)
const cropReply = (text) => cropLine(text, REPLY_MAX)

// Proc identity for the hub's liveness sweep. The plugin runs in-process,
// so our own pid is the agent's. The name must equal what the sweep reads
// later - basename of `ps -o comm=` - and comm follows argv[0] (bare name
// when launched off PATH, full path otherwise), so ask ps for our own comm
// instead of guessing from execPath. Memoized: comm cannot change under us.
let commPromise

function ownComm() {
  commPromise ??= new Promise((resolve) => {
    try {
      execFile(
        "ps",
        ["-o", "comm=", "-p", String(process.pid)],
        { timeout: 2000 },
        (err, stdout) => {
          if (err) return resolve(undefined)
          const comm = stdout.trim()
          resolve(comm ? basename(comm) : undefined)
        },
      )
    } catch {
      resolve(undefined)
    }
  })
  return commPromise
}

// Chain fires so the next CLI process starts only after the previous one has
// exited (event delivered or spooled) - concurrent processes arrive at the
// hub in arbitrary order.
let fireChain = Promise.resolve()

function spawnAndAwaitExit(bin, args) {
  return new Promise((resolve) => {
    try {
      // Detached + ignored stdio + unref: a notifier must never block or
      // break the agent that calls it.
      const child = spawn(bin, args, { detached: true, stdio: "ignore" })
      child.unref()
      // The timer stays ref'd on purpose: with the child unref'd it is the
      // only thing keeping the event loop alive, so a fire in flight at
      // process exit (e.g. "ended" queued behind "done") is not dropped.
      const timer = setTimeout(resolve, FIRE_EXIT_WAIT_MS)
      const settle = () => {
        clearTimeout(timer)
        resolve()
      }
      child.once("exit", settle)
      child.once("error", settle)
    } catch {
      resolve()
    }
  })
}

function fire({ event, sessionID, title, reason, detail, reply }) {
  try {
    const bin = resolveBinary()
    if (!bin) return Promise.resolve()

    const args = ["fire", "--agent", "opencode", "--event", event]
    if (sessionID) args.push("--session-key", `opencode:${sessionID}`)
    if (title) args.push("--title", title)
    if (reason) args.push("--reason", reason)
    if (detail) args.push("--detail", detail)
    if (reply) args.push("--reply", reply)
    args.push("--pid", String(process.pid))

    // Resolving comm inside the chain keeps fire order intact; when capture
    // fails the flag is omitted and the CLI resolves it from --pid with the
    // same ps read the sweep uses - better no name than a guessed-wrong one,
    // which would make the sweep end a live session.
    fireChain = fireChain.then(async () => {
      const name = await ownComm()
      return spawnAndAwaitExit(bin, name ? [...args, "--pid-name", name] : args)
    })
    return fireChain
  } catch {
    // Swallow everything - same reason as above.
    return Promise.resolve()
  }
}

export const server = async ({ directory }) => {
  // session.status/idle/error events carry only a sessionID, so remember
  // titles seen on session.created/updated to include them in signals.
  const titles = new Map()
  const titleFor = (sessionID) =>
    titles.get(sessionID) ?? (directory ? basename(directory) : undefined)

  // The last user prompt (the palette's detail line) and the last assistant
  // text (the palette's reply line) arrive in two events: message.updated
  // {sessionID, info} marks which message is whose (info.role), and
  // message.part.updated {sessionID, part} carries the text in a TextPart
  // {messageID, type: "text", text}. Track the current message id per role
  // per session so prompt and reply never overwrite each other.
  const userMessages = new Map()
  const prompts = new Map()
  const detailFor = (sessionID) => prompts.get(sessionID)
  const assistantMessages = new Map()
  const replies = new Map()
  const replyFor = (sessionID) => replies.get(sessionID)

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const info = event.properties?.info
          if (info?.id && info.title) titles.set(info.id, info.title)
          return
        }

        case "message.updated": {
          const p = event.properties
          if (!p?.sessionID || !p.info?.id) return
          if (p.info.role === "user") {
            // A new prompt starts a new exchange - a reply cached from the
            // previous one must not be sent as this exchange's answer.
            if (userMessages.get(p.sessionID) !== p.info.id) {
              replies.delete(p.sessionID)
            }
            userMessages.set(p.sessionID, p.info.id)
          } else if (p.info.role === "assistant") {
            assistantMessages.set(p.sessionID, p.info.id)
          }
          return
        }

        case "message.part.updated": {
          const p = event.properties
          const part = p?.part
          // synthetic/ignored text parts are injected by opencode itself
          // (e.g. "Summarize the task tool output above…"), not the
          // conversation.
          if (part?.type !== "text" || part.synthetic || part.ignored) return
          if (!p.sessionID) return
          if (part.messageID === userMessages.get(p.sessionID)) {
            const detail = cropDetail(part.text)
            if (detail) prompts.set(p.sessionID, detail)
          } else if (part.messageID === assistantMessages.get(p.sessionID)) {
            // Streamed updates carry the part's accumulated text, so the
            // cache converges on its final content; a later text part
            // overwrites an earlier one, keeping the *last* assistant text.
            const reply = cropReply(part.text)
            if (reply) replies.set(p.sessionID, reply)
          }
          return
        }

        case "session.status": {
          const status = event.properties?.status?.type
          if (status !== "busy" && status !== "retry") return
          const sessionID = event.properties?.sessionID
          return fire({
            event: "busy",
            sessionID,
            title: titleFor(sessionID),
            reason: status === "retry" ? "retry" : undefined,
            detail: detailFor(sessionID),
          })
        }

        case "session.idle": {
          const sessionID = event.properties?.sessionID
          return fire({
            event: "done",
            sessionID,
            title: titleFor(sessionID),
            detail: detailFor(sessionID),
            reply: replyFor(sessionID),
          })
        }

        // Contract name is permission.asked; opencode 1.17 emits
        // permission.updated for the same signal - handle both.
        case "permission.asked":
        case "permission.updated": {
          const p = event.properties
          return fire({
            event: "attention",
            sessionID: p?.sessionID,
            title: p?.title ?? titleFor(p?.sessionID),
            reason: "permission_prompt",
            detail: detailFor(p?.sessionID),
            reply: replyFor(p?.sessionID),
          })
        }

        case "session.error": {
          const p = event.properties
          return fire({
            event: "error",
            sessionID: p?.sessionID,
            title: titleFor(p?.sessionID),
            reason: p?.error?.name,
            detail: detailFor(p?.sessionID),
          })
        }

        case "session.deleted": {
          const info = event.properties?.info
          // Drop caches for the session so long-lived servers don't leak.
          if (info?.id) {
            titles.delete(info.id)
            userMessages.delete(info.id)
            prompts.delete(info.id)
            assistantMessages.delete(info.id)
            replies.delete(info.id)
          }
          return fire({ event: "ended", sessionID: info?.id, title: info?.title })
        }
      }
    },
  }
}
