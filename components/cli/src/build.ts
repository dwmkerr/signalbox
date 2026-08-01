// Build provenance, stamped at compile time by scripts/build.sh (and by CI)
// through `bun build --define process.env.SIGNALBOX_BUILD=...`, which
// replaces this expression with a string literal in the compiled binary.
// Empty when unstamped (a plain `bun run src/main.ts`), so a dev run prints
// a bare version rather than a lie about which commit it is.
export const buildStamp: string = process.env.SIGNALBOX_BUILD ?? "";

// `0.1.5 (d6907e1-dirty)` when stamped, `0.1.5` when not.
export function versionString(version: string): string {
  return buildStamp ? `${version} (${buildStamp})` : version;
}
