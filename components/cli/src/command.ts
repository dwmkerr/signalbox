// Commands: the wire's second kind, and deliberately not an Event.
//
// An event is a fact - it happened, so it is logged, folded into a session,
// and replayed to whoever reconnects. A command is a request addressed to a
// machine right now. The distinction is not philosophy, it is the design:
// the hub replays its log to reconnecting clients, so a logged jump would fire
// again on the next app restart and move a window hours after the tap.
//
// This lives apart from event.ts so the two can never be confused by code.
// A Command has no `event` field and no `seq`, so it cannot be validated as an
// Event, cannot reach the reducer, and cannot enter the log - not by
// convention, but because it is the wrong shape. That also makes an
// out-of-date client safe: the Swift app decodes `event` as a required field
// and drops anything that fails, so a command is inert to a client that does
// not know about commands, rather than corrupting a row.

// The one command today. Jumping is machine-local - it spawns tmux against a
// local socket, or raises a local window - so a phone cannot jump, but it can
// ask the machine that owns the session to.
export const Jump = "jump";

export interface Command {
  v: number;
  id: string;
  ts: string;
  // The kind. Named `command`, not `event`: see the note above - the field
  // name is what makes an old client inert instead of broken.
  command: string;
  session_key: string;
  // The host the phone read off the row it tapped. The executing machine
  // checks this AND the session's own host, and does nothing unless both name
  // it - a disagreement must be a no-op, never a jump on the wrong machine.
  target_host: string;
  // Where the tap happened. Provenance for the debug surface; never routing.
  host?: string;
}

export function validCommand(c: string): boolean {
  return [Jump].includes(c);
}

export function validateCommand(c: Command): string | null {
  if (c.v !== 1) return "v must be 1";
  if (!c.id) return "id is required";
  if (!c.ts) return "ts is required";
  if (!validCommand(c.command)) return `unknown command ${JSON.stringify(c.command)}`;
  if (!c.session_key) return "session_key is required";
  if (!c.target_host) return "target_host is required";
  return null;
}
