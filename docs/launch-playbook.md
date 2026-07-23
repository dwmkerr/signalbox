# signalbox — launch playbook

A checklist for one maintainer to take signalbox from "works on my machine" to "shared, honestly, in the right places." Dry on purpose. Record the assets, reconcile the docs, then post — in that order.

## 1. Goal & the collateral set

**Goal:** one clear, honest launch. Someone lands on the repo, understands what signalbox does in ten seconds, can run it in under a minute, and shares it without us having oversold anything.

We are **not** shipping ten heroes. We ship **one canonical hero** plus a small set of supporting assets. Variety comes from *copy*, not from ten different images.

| Asset | Its job | Source / state |
|---|---|---|
| **One hero** (animated GIF) | Top-of-README autoplay + landing page. Shows one signature action end to end. | Refine existing `docs/images/hero-anim.gif` (rendered from `docs/assets/hero-images/hero.html`), or pick a direction from the concept bank at `components/assets/options/CONCEPTS.md` and render one. Do not ship the bank — it is inspiration only. |
| **One accurate video** | README "Video Demo" slot + social MP4. Real screen capture of the running app, ~30s, burned-in captions, no voiceover. Replaces the current "(janky)" clip. | Record fresh (section 2). |
| **Supporting shots** | README body, per-channel posts, reply-tweets. | Six shots (section 3); some exist, some need capturing. |
| **Per-audience cuts** | Re-cut of the video/hero row per vendor community, each honest to that agent's real hooks. | Derived from the accurate video (section 4). |
| **Refreshed README** | The landing surface everything points at. | Rewrite to the outline in section 5. |

Candidate hero directions in `CONCEPTS.md` if we re-pick rather than refine: **Focus Pull** (Spotlight-style reveal over a frosted desktop), **The Lit Row** (one amber ask lit in a dark board), **Full Board** (fleet-scale density). The existing split chaos→calm hero is a fine default; only re-pick if it isn't landing.

**One-time prerequisite before any asset ships:** reconcile the iOS-availability story. README says "App Store review ongoing / build locally"; `hero.html` says "now Available"; `docs/mobile.md` says "TestFlight (internal), not publicly distributed yet." Pick one true state, make all three agree, and match every caption to it. Until then, captions say **"in testing."**

## 2. The accurate demo video

~30–34s screen recording of the real app. First-person, understated. Captions state what happens, nothing more — no "powerful/seamless." This is distinct from the hand-composed `demo.html` hero loop; do not present one as the other.

### Shot list

| # | Time | Action | Caption (burned-in) |
|---|---|---|---|
| 1 | 0:00–0:06 | Messy desktop, agents already running unattended: Claude (iTerm), OpenCode (iTerm), Codex (Ghostty, optional), Cursor window. Output moving in more than one. | `Four agents, four windows. You can't watch them all.` |
| 2 | 0:06–0:09 | Press ⌃⌥J. Board slides in, search field focused. | `⌃⌥J — the board.` |
| 3 | 0:09–0:17 | Board holds. One row per session: glyph, title, last message, live status. Amber row shows the real question text. | `Every session, live.  spinner = working · blue = done · amber = needs you` |
| 4 | 0:17–0:22 | Type to filter, clear, then ⌃J/⌃K to land on the amber row. | `Type to filter, or ⌃J/⌃K to the one asking.` |
| 5 | 0:22–0:28 | Press ↩. Focus lands in the exact tmux pane where Claude is blocked. Type the answer there. | `↩ jumps to the pane. You answer there — the board never answers for you.` |
| 6 | 0:28–0:34 | Menu-bar dot + dropdown, then a phone showing the same board. | `Menu bar shows the state at a glance. The iOS app (in testing) shows the same board — jumping happens on the Mac.` |

Trim shot 3 to 6s or drop shot 4 to land near 30s. **Never cut shot 5** — "you answer, not the board" is the honest core.

### Setup (record it yourself)

Prep once:
1. `signalbox init` — wire Claude Code + OpenCode (+ Codex/Cursor if in frame). Confirm the menu-bar app is running (it runs the hub).
2. Put agents you want jump-back for into **tmux** panes — jump-back needs an addressable pane. Cursor is window-level, no tmux. Record *from* a tmux pane so `signalbox fire` captures the pane origin.
3. Capture tool: **Kap or CleanShot** (the board and menu bar are GUI — not asciinema/VHS). Tight crop, 10–15 FPS for the GIF export.

Get a live amber ask on cue, two ways:
- **Fully real (preferred):** give each agent a real task; drive the Claude session to a genuine permission or `AskUserQuestion` prompt so it sits amber with real text when you press ⌃⌥J.
- **Reproducible seed (still the real path):** `components/scripts/demo.sh` fires a synthetic board through the real `signalbox fire` integration. Run it **from your recording tmux pane** so ↩ routes to a real pane. It is Claude/OpenCode/pi/github only (Codex correctly absent). Clear after: `components/scripts/demo.sh --clear`.

Record: start on the messy desktop → ⌃⌥J → let the board hold ~6s → filter, clear, ⌃J/⌃K to amber → ↩, type the answer → stop, then capture the menu-bar dropdown and a phone separately if the crop won't hold both.

Export: README GIF ≤10MB (downscale ~800–1000px wide, trim dead frames, gifsicle/ffmpeg palette). Separate muted **MP4 with captions** for social from the same source. Make the first 1–2 seconds make sense with no sound. No voiceover.

## 3. Supporting shots

| # | Shot | Status | Where it goes |
|---|---|---|---|
| 1 | Jump box mid-ASK — real question with options (`Overwrite writing-style.yml? (Overwrite / Keep mine)`) plus a permission row (`Bash: git push -u origin ...`), statuses across the list. | Update `jumplist.png` to guarantee a visible options-ASK. | README Quickstart; lead image for the announce tweet. Credit Claude Code if an agent is named — only it surfaces question-with-options. |
| 2 | ⌃⌥J jump landing in a pane — the payoff loop, 3–5s. | Needs capturing. | README Features (near the ⌃⌥J bullet); reply-tweet ("here's the jump itself"); r/commandline. |
| 3 | Menu-bar dropdown with status dot — one row per session, spinner, done tick. | Exists (`menubar.png`). | README Quickstart; macOS-focused post. |
| 4 | iOS companion board — pairing QR beside the phone showing the board. Label **in testing / TestFlight**. | Exists (`ios-pairing.svg`); add a phone-only frame for a cleaner social image. | README "On your phone"; standalone tweet with TestFlight link. |
| 5 | Multi-machine host chips — sessions tagged `mac-studio`, `laptop`, `devbox`. | Needs capturing. | README "works across your machines"; worktree/multi-box tweet. |
| 6 | Integrations / capability table — per-agent status, `signalbox fire` GitHub Actions example. | Exists in `docs/integrations.md`. | README Features; "which agents?" reply in a launch thread. |

Every caption dry, active-voice, no exclamation marks. Never credit a capability to an agent whose hooks don't emit it.

## 4. Per-audience framing

Signalbox is **tool-neutral** — it complements every agent, competes with none. Lead each community with the multi-agent pain, mention *that* community's tool first, and keep every depicted row within that agent's real capability column.

| Audience | Hook | Safe to show | Must NOT imply | Channels |
|---|---|---|---|---|
| **Claude Code** | Every Claude session across every terminal and machine, one keystroke, jump to the one asking. | Everything: working/done, prompt+reply, permission command, question-with-options, errors, jump-back. Reference implementation. | — | Anthropic Discord #showcase / #claude-code; r/ClaudeAI, r/ClaudeCode |
| **Cursor** | Cursor doesn't tell you which window is waiting on you. This does. | working/done, permission (shell/MCP), errors. | Jump is **window-level only** — don't show it landing on a specific tab/pane. | Cursor Discord #showcase, Cursor Community Forum; r/cursor |
| **Codex** | Codex working in the background — the board says when it's done or wants a command approved. | working/done, permission **command**, jump-back (tmux/Cursor). | **No error surfacing.** Codex has no error hook — never show a Codex error row or caption "see failures." A failed turn just ages out. | r/codex; OpenAI dev Discord / Developer Forum |
| **OpenCode** | Run OpenCode in six terminals, know which one is blocked without checking six terminals. | working/done, permission, errors, jump-back (tmux). Lead with the error row. | question-with-options (Claude-only). | OpenCode Discord; OpenCode GitHub Discussions |
| **pi** | A running pi agent and a done pi agent look different from across the room now. | working/done. That's the whole contract. | permission asks, errors, replies-as-asks. | pi community channel; direct share |
| **General / HN** | Press ⌃⌥J, see every agent session's live status across all your terminals and machines — working, done, or asking — so you jump to the one that needs you instead of tab-hunting. | The jump box: a local-first board with real ASKING rows. Be precise that per-agent detail depends on each agent's hooks. | Overstating uniform capability across agents. | Show HN; dwmkerr's blog; then r/programming-adjacent (see below) |

If a cut mixes agents on one board (as the full walkthrough does), every row is still fine — just keep each row's *state* within that agent's real column. The `demo.sh` seed already respects this.

## 5. README refresh outline

Arc: pain → board → install → integrations → mobile. Keep the wry, first-person voice; tighten accuracy, add a positioning hook.

0. **Title + one-liner.** Add one plain sentence of what signalbox *is* — the current hero is all problem, no product definition. Use the ready-made line: *"A local-first events board for AI coding agents — one board for every agent, terminal, and job you run."* Keep `brew install dwmkerr/tools/signalbox` above the fold.
1. **The pain (tab-hunting).** Two flat sentences. Keep the "Are you tab-hunting your agents?" hook.
2. **The board (⌃⌥J).** The payoff. The real ask shown inline. Leads with the hero GIF.
3. **Install.** Two steps, zero ceremony: brew, open the app (spawns the local hub), `signalbox init`. State local-only / open-source flatly — no signup, nothing leaves the machine.
4. **Integrations.** Per-agent capability table (Claude Code, Codex, Cursor, OpenCode, pi, tmux, GitHub Actions) with a column for what each surfaces.
5. **Mobile (in testing).** iOS companion mirrors the board. Flag TestFlight, understated. One phone screenshot + link.
6. **Footer.** Repo link, MIT license, maintainer credit. Badges (build, release, license) if wanted.

Also fix before sharing:
- Remove the two in-file TODO comments (README lines ~61–65, `hero.html` ~553–555).
- Promote Codex consistently across `integrations.md`, `hero.html`, README — Stable everywhere, or "in testing" everywhere.
- One clear, sincere try/star line near the top — not only the buried `gh api` joke.
- Confirm the GitHub social-preview and landing-page OG tags render a proper card (`docs/images/social-preview.png` exists — check it's wired).
- Retire the "(janky)" self-deprecation once the section-2 capture replaces the current clip.

## 6. Distribution plan

### Channels & framing

- **Hacker News (Show HN)** — the single highest-leverage venue and the one place a first-day link is fully sanctioned. Plain, literal title, no adjectives/superlatives/exclamation marks: `Show HN: signalbox — see every AI agent's status with one keypress`. Link the GitHub repo (established domain), embed the hero GIF. Runnable in under 60s, no signup.
- **lobste.rs** — Show-HN-style, tagged `ai`/`devtools`/`release`. Only if you have standing; self-promo capped at roughly <25% of your activity.
- **r/commandline** — CLI/tooling-friendly, less promo-hostile. **Skip r/programming** — it will be removed or downvoted.
- **Vendor communities** — one post each, in the *sanctioned showcase surface*, framed as a complement, that community's tool first (per section 4).
- **X / "building in public"** — the compounding channel. Hero GIF native, tag supported tools, ship periodic update clips. HN/Reddit are one-shot spikes; X is the ongoing funnel.
- **dev.to / personal blog** — one narrative article: "I was tab-hunting six agents, so I built a jumplist." Gives every other channel a value-link to point at instead of a bare repo.
- **Directories** — cross-agent tool catalogs and awesome-lists. Zero stigma, evergreen discovery, reinforces "works with all of them."

### Suggested sequence

1. **Reconcile + refresh first.** iOS state consistent, TODOs gone, positioning line in, hero + accurate video recorded. Nothing ships until the repo tells one true story.
2. **Blog post / dev.to article** live — the durable value-link.
3. **Show HN**, Tue–Thu ~8–10am ET (or Sunday evening as a low-competition alternative). Paste a prepared first comment within seconds: one line on the itch, 2–3 sentences on the technical approach and a tradeoff, one genuine limitation, one open question. Then sit on the thread and reply to essentially every comment for the first 1–2 hours. Treat the first hour as the whole game.
4. **X thread** same day: hero GIF, the jump payoff as reply, phone app as a third beat.
5. **Vendor communities**, staggered over the following days — not all the same day with identical copy. Tailor each to its agent's real hooks.
6. **Directories / awesome-lists** — evergreen, add any time.

**Do not ask for upvotes** — anywhere, including X or DMs. It triggers HN ring detection and can permanently ban the domain. "Launched this" is fine; "please upvote" is not. Prep the HN account with a few weeks of genuine prior comments so it isn't cold.

### What to measure

- **GitHub stars** — before/after each channel; which channel moved them.
- **TestFlight signups** — the iOS funnel; watch after any mobile-specific post.
- **Installs** — Homebrew analytics (`brew install` counts) as the closest proxy for real adoption.
- **HN placement + comment count** — front page or not by ~60 min; depth of discussion.
- **Referral traffic** to the repo / landing page (GA4 is already on the landing page, DNT-respecting).

## 7. Open questions / decisions

- **iOS state:** "TestFlight (internal)" vs "open beta" vs "App Store soon" — pick one, reconcile README / `hero.html` / `mobile.md`, match all captions. Blocks everything.
- **Codex status:** Stable or in-testing? Decide once, apply to all three surfaces.
- **Hero:** refine the existing split hero, or re-pick from `CONCEPTS.md` (Focus Pull / Lit Row / Full Board)? Decide before rendering — we ship one.
- **Video amber agent:** the full cut uses Claude Code (correct — question-with-options is Claude-only). Confirm that's the canonical cut and per-vendor re-cuts derive from it.
- **HN account:** is there a warmed account with recent genuine comment history, or does one need a few weeks' runway first?
- **Launch window:** which Tue–Thu morning ET, and is a 2-hour block reserved to sit on the thread?

## Do next

- [ ] Reconcile iOS-availability messaging across README, `hero.html`, `docs/mobile.md`; pick one true state.
- [ ] Decide Codex status; apply consistently.
- [ ] Remove the two in-file TODO comments.
- [ ] Add the positioning one-liner + a sincere try/star line to the README top.
- [ ] Pick/refine the one hero; render the GIF ≤10MB.
- [ ] Record the accurate ~30s video (section 2); export README GIF + social MP4.
- [ ] Capture supporting shots 2 and 5; refresh shot 1 (`jumplist.png`) with a visible options-ASK.
- [ ] Rewrite the README to the section-5 outline; check social-preview/OG card.
- [ ] Draft the Show HN title + first comment; warm the HN account if needed.
- [ ] Write the blog / dev.to article.
- [ ] Pick the launch window (Tue–Thu, 8–10am ET); block the 2 hours after.
