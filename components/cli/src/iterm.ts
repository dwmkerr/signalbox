import type { Origin } from "./event";

// iTerm gives every native session (a tab, or a split pane within one) a GUID
// through ITERM_SESSION_ID. Capture only that stable GUID: the w/t/p prefix is
// iTerm's current layout coordinate and is not needed to find the session.
export function iTermOrigin(env: Record<string, string | undefined>): Origin | null {
  if (env.TERM_PROGRAM !== "iTerm.app") return null;
  const raw = env.ITERM_SESSION_ID?.trim();
  if (!raw) return null;
  const separator = raw.lastIndexOf(":");
  const session = (separator >= 0 ? raw.slice(separator + 1) : raw).trim();
  if (!session) return null;
  return { kind: "iterm", iterm: { session } };
}
