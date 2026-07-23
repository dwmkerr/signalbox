// Renders demo.html (the 28s launch animation) to deterministic frames, then
// ffmpeg encodes them to mp4/gif. Same technique as the hero gif (repo
// CLAUDE.md): step the CSS timeline with Animation.currentTime rather than
// waiting in real time, so every frame is exact regardless of machine speed.
//
//   # one-off, in a gitignored scratch dir:
//   mkdir -p scratch/demo-gif && cd scratch/demo-gif
//   npm init -y && npm install playwright && npx playwright install chromium
//
//   node <repo>/components/assets/capture.js        # frames -> ./frames
//
//   # 1080p mp4 (best for X / landing / Show HN):
//   ffmpeg -y -framerate 25 -i frames/f-%04d.png \
//     -vf "scale=1920:1080:flags=lanczos" -c:v libx264 -pix_fmt yuv420p \
//     -movflags +faststart demo.mp4
//
//   # looping gif (heavier - prefer mp4 where possible):
//   ffmpeg -y -framerate 20 -i frames/f-%04d.png \
//     -vf "scale=1280:720:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none" \
//     -loop 0 demo.gif && gifsicle -O3 --lossy=100 demo.gif -o demo-opt.gif

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const FILE = 'file://' + path.resolve(__dirname, 'demo.html');
const OUT = path.resolve(process.cwd(), 'frames');
const DURATION_MS = 28000;   // must match the CSS master timeline
const FPS = 25;
const FRAMES = (DURATION_MS / 1000) * FPS;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await page.goto(FILE);
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getAnimations().forEach(a => a.pause()));
  const stage = await page.$('.stage');
  for (let i = 0; i < FRAMES; i++) {
    const t = (i / FRAMES) * DURATION_MS;
    await page.evaluate((t) => { document.getAnimations().forEach(a => { a.currentTime = t; }); }, t);
    await stage.screenshot({ path: path.join(OUT, `f-${String(i).padStart(4, '0')}.png`) });
  }
  await browser.close();
  console.log(`wrote ${FRAMES} frames to ${OUT}`);
})();
