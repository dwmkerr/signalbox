# signalbox

A local-first events board for AI coding agents. One board for every agent,
terminal, and job you run.

## Specs are the source of truth - keep them current

**Whenever you change behaviour, update the spec in the same change.** The specs
in `components/specs/` describe the contract; they must never lag the code.

- `components/specs/cli.md` - every CLI command, flag, and its output. Update it
  when you add/rename/remove a command or flag, or change what a command prints.
- `components/specs/events.md` - the wire schema (event types, fields, reducer
  rules). Update it when the event shape or reducer behaviour changes.
- `components/specs/adapters.md` - how each agent adapter fires events.
- **`components/specs/*.html` are the living spec for the app's UI surfaces** -
  the HTML mock IS the source of truth for that surface, not just an
  illustration:
  - `components/specs/settings.html` - the Settings window (every control, its
    label, caption, and the settings-storage table). Change a setting -> update
    this.
  - `components/specs/hub-jumplist.html` - the jumplist (rows, keys, footer,
    marks).
  - `components/specs/menubar.html` - the menu bar icon + dropdown.
  When you add/change/remove a control or behaviour on one of these surfaces,
  update its HTML mock in the same change.

If a change touches behaviour and you did not touch a spec, that is a bug in the
change. Treat "code and spec disagree" as a failing state.

## Layout

- `components/cli/` - the TypeScript CLI + hub, compiled to a single binary with
  Bun (`bun build --compile`). The hub is `signalbox hub` (same binary).
- `components/app/` - the Swift macOS menu bar app (jumplist, status icon,
  settings). The app OWNS the hub: it spawns `signalbox hub` as a child,
  keeps it alive, and stops it on quit (Hub.swift) - there is no LaunchAgent.
  The bundle embeds the CLI at Contents/Resources/signalbox. Built via
  `components/app/Makefile` (it works around a CommandLineTools SPM manifest
  bug - use `make -C components/app build`, not bare `swift build`).
- `components/cli/adapters/` - per-agent hooks/plugins (claude, opencode, pi) and
  tmux.
- `components/scripts/` - dev helpers (e.g. `demo.sh` seeds a board via `fire`).
- `packaging/` - the Homebrew formula template.
- `docs/`, `components/specs/` - docs site and specs.

## Build & test

```bash
make build                     # compile the CLI to components/cli/bin/signalbox
make -C components/app build   # build the menu bar app
cd components/cli && bun test  # CLI + reducer tests
cd components/cli && bunx tsc --noEmit   # typecheck
```

`~/.local/bin/signalbox` is symlinked to `components/cli/bin/signalbox`, so
`make build` deploys the CLI. The app supervises the hub: `make install` kills
a running hub and the app respawns it with the new build within seconds;
relaunch the app itself to pick up an app rebuild.

### Regenerating the hero gif

`docs/images/hero-anim.gif` (README + `docs/assets/hero-images/hero.html` on
the landing page) is a rendered capture of `hero.html`'s `.split` element, not
hand-edited. The README embeds it with `<img width="900">`, but the gif's own
pixel dimensions must NOT be 900-wide - see the resolution note below. After
changing `hero.html`, regenerate it:

```bash
# serve the file (file:// is blocked by headless browsers)
cd docs/assets/hero-images && python3 -m http.server 8791 &

# one-off Playwright + gifsicle install, in a scratch dir (gitignored)
mkdir -p scratch/hero-gif && cd scratch/hero-gif
npm init -y && npm install playwright && npx playwright install chromium
brew install gifsicle   # if not already on the machine
```

Capture script (`scratch/hero-gif/capture.js`) - steps through the CSS
animation with `Animation.currentTime` rather than waiting in real time, so
every frame is exact regardless of machine speed. `deviceScaleFactor: 2`
renders at 2x pixel density (retina-equivalent):

```js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT_DIR = path.join(__dirname, 'frames');
const URL = 'http://localhost:8791/hero.html';
const DURATION_MS = 9000; // must match the CSS animation's total loop length
const FPS = 12;
const FRAME_COUNT = DURATION_MS / 1000 * FPS;

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(URL);
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getAnimations().forEach(a => a.pause()));
  const split = await page.$('.split');
  for (let i = 0; i < FRAME_COUNT; i++) {
    const t = (i * DURATION_MS) / FRAME_COUNT;
    await page.evaluate((t) => {
      document.getAnimations().forEach(a => { a.currentTime = t; });
    }, t);
    await split.screenshot({ path: path.join(OUT_DIR, `frame-${String(i).padStart(3, '0')}.png`) });
  }
  await browser.close();
})();
```

```bash
node capture.js   # frames land at ~2120x888 (native .split size x2)

# Resolution note: do NOT scale down to the README's display width (900).
# The capture is already 2x-supersampled for antialiasing quality, but if you
# then shrink the output back to 900-wide you throw away exactly the pixels
# that bought you - text goes soft again. Ship at 2x the display width
# (1800x754) instead; the <img width="900"> tag downscales it in-browser,
# same as a retina screenshot.
ffmpeg -y -framerate 12 -i frames/frame-%03d.png \
  -vf "scale=1800:754:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=255[p];[b][p]paletteuse=dither=none" \
  -loop 0 hero-anim-full.gif

# dither=none avoids visible bayer/floyd-steinberg speckle noise on the flat
# dark background at 8-bit palette depth. But 2x resolution roughly triples
# raw file size (~14MB) - claw it back with gifsicle's lossy compression,
# which targeted-blurs only where the palette would otherwise dither:
gifsicle -O3 --lossy=120 hero-anim-full.gif -o hero-anim.gif   # ~9-10MB

cp hero-anim.gif ../../docs/images/hero-anim.gif
kill %1   # stop the http.server
```

Sanity-check before committing: extract a frame (`ffmpeg -i hero-anim.gif
-update 1 -vframes 1 frame0.png`) and crop a patch of small text at native
resolution (no resizing the crop) - it should read like a real screenshot,
not a soft downscale, and a patch of flat background should show no dither
speckle.

### Testing coding-agent integrations

Use `shellwright` to test a coding agent end to end: it runs the agent (codex,
claude, ...) as a driven shell session so you can send input, read the streamed
output, and take screenshots along the way. This is the way to verify an adapter
against a real agent (e.g. confirm a Codex turn fires the hooks and the board
updates), rather than only feeding canned hook payloads to `signalbox hook`.

## Conventions

- Push to GitHub at the end of the day only - commit locally as you go, one
  push when the day's work is done.
- Conventional Commits (`feat:`, `fix:`, `docs:`, ...).
- Comments explain *why*, not *what* - no breadcrumb comments.
- Use a regular hyphen (-), never an em-dash, anywhere in code, comments, or docs.
- User config: JSON agent configs (Claude settings.json, Cursor hooks.json)
  are merged only with consent, with a timestamped backup and an atomic
  parse-validated write; removal reverses exactly that edit (literal
  signalbox commands only). Freeform config (tmux.conf) is never edited -
  print the snippet instead.
