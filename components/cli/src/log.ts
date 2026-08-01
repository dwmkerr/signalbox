// Local time, not UTC: this file is read next to the clock on the user's own
// screen, and a UTC line makes them do arithmetic before they can correlate
// it with what they were doing.
export function stamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

// The hub's own log line. The app redirects this process's stderr into
// hub.log and tails it in Settings, so a bare line there cannot be placed in
// time against anything the user remembers doing.
export function hubLog(message: string): void {
  process.stderr.write(`${stamp()} ${message}\n`);
}
