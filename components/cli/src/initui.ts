// The `signalbox init` presentation: one board, rendered two ways. Read-only
// (`init --status`, or piped) prints it; interactive (`init` on a TTY) draws the
// same board with a cursor and lets you set up what's missing. Same banner, same
// rows - the only difference is whether you can act on it.

// A component is one thing init can set up. The caller (setup.ts) supplies
// detection and application; this module only presents.
export interface Component {
  id: string;
  category: string; // "signalbox" | "Integrations"
  label: string;
  info: string; // shown in the details view
  // Board phrasing: `done` reads when configured ("CLI on your PATH"), `miss`
  // states the consequence when it is not ("hooks not set up, events won't fire").
  done: string;
  miss: string;
  configured: boolean;
  note?: string;
  path?: string;
  after?: string;
}

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[38;5;214m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const accent = (s: string) => `\x1b[38;5;213m${s}\x1b[0m`;

const TAGLINE = ["Switch between agent sessions across", "terminals and machines."];
// The mark: a broadcasting beacon in a box - literally signal + box. The
// menu bar's default icon is this beacon (radio waves, StatusIcon.swift); the
// box frames it so it reads as a logo, not a row in the list below.
const box = (s: string) => `\x1b[38;5;172m${s}\x1b[0m`;
const beacon = `\x1b[38;5;214m((●))\x1b[0m`;
const LOGO = [box("╭───────╮"), `${box("│")} ${beacon} ${box("│")}`, box("╰───────╯")];

interface BoardOpts {
  cursor?: number; // interactive: highlighted row
  desired?: Set<string>; // interactive: ids the user wants installed; presence = interactive
  verbose?: boolean; // append install paths
}

// The shared board: the list mark + welcome banner over a dotted status list
// grouped by category. Both the read-only status and the interactive picker
// render through here so they can never drift apart. Interactively, the dot is
// a checkbox for the *desired* state, and rows whose desired state differs from
// what's installed are annotated (will set up / will remove).
function board(components: Component[], opts: BoardOpts): string[] {
  const { cursor, desired, verbose } = opts;
  const interactive = desired !== undefined;
  const banner = [bold("Welcome to signalbox"), dim(TAGLINE[0]), dim(TAGLINE[1])];
  const out = LOGO.map((mark, i) => ` ${mark}   ${banner[i]}`);

  let lastCategory = "";
  components.forEach((c, i) => {
    if (c.category !== lastCategory) {
      out.push("", ` ${dim(c.category)}`);
      lastCategory = c.category;
    }
    const pointer = interactive && i === cursor ? accent("❯") : " ";
    const want = interactive ? desired!.has(c.id) : c.configured;
    let dot: string;
    let text: string;
    if (want && c.configured) {
      dot = ok("●");
      text = c.done;
      if (verbose && c.path) text += dim(`  ${c.path}`);
    } else if (want && !c.configured) {
      // Checked but not installed - will be set up on apply.
      dot = ok("◉");
      text = interactive ? `${c.label} ${dim("· set up")}` : c.label;
    } else if (!want && c.configured) {
      // Unchecked but installed - will be removed on apply.
      dot = amber("○");
      text = `${c.done} ${dim("· remove")}`;
    } else {
      dot = dim("○");
      text = `${c.label} ${dim(`- ${c.miss}`)}`;
    }
    out.push(`   ${pointer} ${dot} ${text}`);
  });
  return out;
}

function flagFor(id: string): string {
  if (id === "app") return "--app";
  if (id === "tmux") return "--tmux";
  return `--agent ${id}`;
}

// ---- read-only status ------------------------------------------------------

export function renderStatus(components: Component[], verbose: boolean): string {
  const out = ["", ...board(components, { verbose }), ""];
  const missing = components.filter((c) => !c.configured);
  if (missing.length === 0) {
    out.push(` ${ok("Everything is set up.")} Press ${bold("⌃⌥J")} to jump between sessions.${verbose ? "" : dim("  (-v for paths)")}`);
  } else {
    const flags = [...new Set(missing.map((c) => flagFor(c.id)))].join(" ");
    out.push(` ${dim(`${missing.length} to set up ·`)} signalbox init ${flags}`);
  }
  out.push("");
  return out.join("\n");
}

// ---- interactive picker ----------------------------------------------------

const ESC = "\x1b";
const hideCursor = () => process.stdout.write(`${ESC}[?25l`);
const showCursor = () => process.stdout.write(`${ESC}[?25h`);

export interface PickerChanges {
  install: Component[]; // checked, not yet installed
  remove: Component[]; // unchecked, currently installed
}

export async function runPicker(
  components: Component[],
  apply: (changes: PickerChanges) => Promise<string[]>
): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stdout.write(renderStatus(components, false) + "\n");
    return;
  }

  // The checkbox is the desired state; it starts at what's installed, so
  // opening the picker and pressing ⏎ changes nothing. Toggle any row to add
  // (check a missing one) or remove (uncheck an installed one).
  const desired = new Set(components.filter((c) => c.configured).map((c) => c.id));
  let cursor = 0;
  let detailsFor: Component | null = null;
  let lastFrameLines = 0;

  const changes = (): PickerChanges => ({
    install: components.filter((c) => desired.has(c.id) && !c.configured),
    remove: components.filter((c) => !desired.has(c.id) && c.configured),
  });

  const frame = (): string => {
    if (detailsFor) {
      const c = detailsFor;
      const on = desired.has(c.id);
      const verb = on ? (c.configured ? "remove" : "skip") : c.configured ? "keep" : "set up";
      return [
        "",
        ` ${bold(c.label)}`,
        "",
        ...wrap(c.info, 60).map((l) => `   ${dim(l)}`),
        ...(c.path ? [`   ${dim(c.path)}`] : []),
        "",
        ` ${dim(`space ${verb} · esc back`)}`,
      ].join("\n");
    }
    return [
      "",
      ...board(components, { cursor, desired }),
      "",
      ` ${dim("↑↓ move · space toggle · ⏎ apply · d details · q quit")}`,
    ].join("\n");
  };

  const draw = () => {
    if (lastFrameLines > 0) process.stdout.write(`${ESC}[${lastFrameLines}A`);
    const text = frame();
    process.stdout.write(text.split("\n").map((l) => `${ESC}[2K${l}`).join("\n") + "\n");
    lastFrameLines = text.split("\n").length;
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  hideCursor();
  draw();

  const n = components.length;
  await new Promise<void>((resolve) => {
    const toggle = (c: Component) => {
      if (desired.has(c.id)) desired.delete(c.id);
      else desired.add(c.id);
    };
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      showCursor();
    };
    const onData = async (buf: Buffer) => {
      const k = buf.toString();
      if (detailsFor) {
        if (k === ESC || k === "q") detailsFor = null;
        else if (k === " ") toggle(detailsFor);
        draw();
        return;
      }
      if (k === "\x1b[A" || k === "k") cursor = (cursor - 1 + n) % n;
      else if (k === "\x1b[B" || k === "j") cursor = (cursor + 1) % n;
      else if (k === " ") toggle(components[cursor]);
      else if (k === "d") detailsFor = components[cursor];
      else if (k === "q" || k === "\x03" || k === ESC) {
        finish();
        process.stdout.write(dim(" cancelled.\n"));
        resolve();
        return;
      } else if (k === "\r" || k === "\n") {
        finish();
        const ch = changes();
        if (ch.install.length === 0 && ch.remove.length === 0) {
          process.stdout.write(`\n ${ok("✔")} No changes. ${dim("Press ⌃⌥J to see your board.")}\n`);
        } else {
          process.stdout.write(`\n ${dim("Applying…")}\n`);
          for (const line of await apply(ch)) process.stdout.write(`   ${line}\n`);
          process.stdout.write(`\n ${ok("✔ Done.")} ${dim("Open a session and press ⌃⌥J.")}\n`);
        }
        resolve();
        return;
      }
      draw();
    };
    process.stdin.on("data", onData);
  });
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
