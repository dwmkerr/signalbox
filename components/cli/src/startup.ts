import type { Event } from "./event";
import * as ev from "./event";
import { PermanentError, Spool } from "./spool";

function parseSpooledEvent(line: string): Event {
  let event: Event;
  try {
    event = JSON.parse(line) as Event;
    ev.normalizeInbound(event);
    const invalid = ev.validate(event);
    if (invalid) throw new Error(invalid);
  } catch (err) {
    throw new PermanentError(`invalid offline event: ${String(err)}`);
  }

  delete event.acked;
  delete event.hidden;
  delete event.pinned;
  delete event.engaged_ts;
  delete event.seq;
  return event;
}

// drainStartupSpool turns the hook outbox into initial hub state before a
// listener is exposed. onReady is deliberately synchronous because Spool holds
// the append lock across that one state transition.
export function drainStartupSpool(
  stateDir: string,
  consume: (event: Event) => void | Promise<void>,
  onReady: () => void,
  log: (message: string) => void = () => {},
  beforeReady: () => Promise<void> = async () => {}
): Promise<number> {
  const spool = new Spool(stateDir, "spool.jsonl", {}, log);
  return spool.drainBeforeReady(async (line) => {
    await consume(parseSpooledEvent(line));
  }, onReady, beforeReady);
}
