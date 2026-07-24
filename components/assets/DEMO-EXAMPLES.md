# Demo/launch examples worth stealing from

10 projects that do the hero/demo-video well, from the demo-examples workflow. Inspiration for signalbox's hero + walkthrough.

## 1. Raycast — panel-as-hero (raycast.com)
https://www.raycast.com
**Medium:** Full-bleed static product screenshot as hero on a near-black canvas, with in-page bento tiles showing real palette states.
**Shows:** The actual command palette at 1:1 OS fidelity — macOS traffic-light dots, single search row, selectable command rows — floating on pure near-black so the panel IS the hero. Bento tiles each hold a real screenshot of a feature.
**Why it works:** Developers distrust marketing abstraction; the real UI at 1:1 reads as 'this is exactly what you get.' The dark canvas makes the panel feel summoned over your desktop, not embedded in a webpage.
**Tone:** Confident, minimal, product-forward. Keycap glyphs inline teach shortcuts; the UI does the talking.
**Steal:** Make the menu-bar panel itself the hero on a near-black canvas at true OS fidelity (traffic-light dots, live agent-status rows) so it reads as summoned over the desktop, not a website widget.

## 2. Linear — Cmd-K command menu / animated hero
https://linear.app
**Medium:** Scroll-and-interaction-driven animated hero with fast eased transitions; the command menu is a distinct animated surface.
**Shows:** A searchable Cmd-K menu slides/fades in over the app: type-to-filter action list, each row showing icon + label + its inline keyboard shortcut on the right. It also cold-opens mid-action — the interface is already moving in frame 1, no logo card.
**Why it works:** Showing the shortcut next to each action teaches while it demos. The fast motion signals the app's own performance ethos. Opening on the outcome (not an intro) stops the scroll before viewers bail.
**Tone:** Precise, fast, understated craft. Copy centers on keyboard control; the animation quality is the flex.
**Steal:** Put Ctrl-Opt-J and each action's shortcut inline on every row so the demo doubles as onboarding — and kill the intro card: frame 1 is the panel already dropping in, not branding.

## 3. charmbracelet/vhs
https://github.com/charmbracelet/vhs/blob/main/README.md
**Medium:** GIF rendered from a committed .tape script; the tool demos itself recording a .tape file.
**Shows:** The hero GIF shows a .tape file typed line by line (Type, Enter, Sleep, Set FontSize) then the resulting terminal render. Demos are terminal GIFs-as-code: commit a text file, CI re-renders, so the GIF never drifts from the CLI.
**Why it works:** Devs distrust hand-recorded GIFs (typos, jerky timing, huge files). VHS demos are pixel-perfect, reproducible, diffable in git, and regenerable in CI. The tool demoing itself is the strongest proof it works.
**Tone:** Playful-but-precise Charm house voice; exhaustive reference docs underneath.
**Steal:** Make the signalbox demo a committed, scripted .tape artifact rendered in CI, not a screen recording — deterministic typing/pauses on the key line, and it stays in sync with the real app forever.

## 4. starship/starship
https://github.com/starship/starship
**Medium:** Short looping demo GIF of the prompt reacting live as you cd between project directories.
**Shows:** The prompt live-updating as the user changes directories — git branch/status, language versions, context modules appearing and disappearing per repo — in one continuous take.
**Why it works:** The value is contextual reactivity, which only motion can show; you must see the prompt change to get it. A single continuous take also proves it isn't faked.
**Tone:** Sleek, minimal, design-led.
**Steal:** Signalbox's core value is reactive/stateful — script one continuous take where an agent's status visibly flips to 'needs you' and you jump to it. Motion is mandatory here; a screenshot can't carry it.

## 5. Fig / Amazon Q autocomplete GIF
https://github.com/withfig/autocomplete
**Medium:** Single silent looping GIF under ~4 seconds, no narration, cropped tight to the UI element that changes.
**Shows:** A real terminal where typing git/cd/kubectl pops an IDE-style dropdown of context-aware suggestions that tab-complete inline. It shows only the 'wait, my terminal can do THAT?' reveal and nothing else.
**Why it works:** The whole product is one novel interaction, so the hero is that one interaction on loop in under 4s — no setup, no chrome, no voiceover. A dev recognizes the value before the loop repeats.
**Tone:** Minimal, wordless, confidence through restraint.
**Steal:** Isolate signalbox's single 'oh, nice' moment — one agent goes red, one keystroke, you're there — and loop it silently, cropped tight to just the panel that changes. That clip is the hero.

## 6. Bun 1.0 announcement video
https://bun.sh/blog/bun-v1.0
**Medium:** Hand-composed cinematic mp4 (movie-trailer parody, zero UI) as the hero, with static benchmark bars and a hot-reload GIF carrying the real proof below.
**Shows:** A ~90s trailer parody sells the feeling/identity with kinetic callouts and zero actual UI; the blog page below does the sober technical convincing with benchmarks and a focused GIF.
**Why it works:** Splitting 'make me care' (video) from 'prove it' (GIFs/benchmarks) means neither job is compromised. Devs numb to feature lists remember the spectacle, then get convinced by the proof.
**Tone:** Over-the-top and self-aware — probably too loud for signalbox's voice, but the STRUCTURE is the lesson, not the tone.
**Steal:** Split the launch: one short stylized hero that sells the feeling, then a row of tight silent feature loops below that carry the literal proof. A menu-bar app can have a 15s hero + a strip of silent loops.

## 7. Ghostty — product-as-hero
https://ghostty.org
**Medium:** Clean, high-DPI native screenshots of the terminal itself, presented almost like a gallery; minimal marketing chrome.
**Shows:** Ghostty rendering its own polished UI — themes, native platform feel, later the command palette and progress bars — as crisp screenshots. The artifact is the argument.
**Why it works:** For a tool whose value is native fidelity and craft, a pixel-perfect screenshot of the real thing beats any manufactured demo. The restraint signals confidence and matches the audience's taste for un-hyped tools.
**Tone:** Understated, craft-led, documentation-like, developer-to-developer.
**Steal:** For a menu-bar app whose appeal is looking right on the system, let a real, beautifully-composed screenshot be a hero — over-produced video can undersell craft. Match medium to the claim: still if it's static, motion only where it's reactive.

## 8. Warp — auto-zoom captioned product demo
https://www.warp.dev
**Medium:** Produced real-capture with smart auto-zoom + terse on-screen caption cards, little or no voiceover.
**Shows:** Real commands running, each output collapsing into a block; smooth auto-zoom pushes into the exact cursor/keystroke that matters each beat, with short noun-phrase caption cards ('Rerun any command', 'Share a block').
**Why it works:** Filming the real tool earns trust. Auto-zoom solves the #1 terminal-demo failure — text too small on mobile — by enlarging the one region that matters. Captions carry meaning with sound off, which is how most feed views happen.
**Tone:** Slick but technical; captions are terse noun-phrases, not marketing sentences.
**Steal:** Signalbox ships iOS — auto-zoom onto the active region every beat and caption in terse noun-phrases so the panel reads on a phone with sound off. Never show a full-size UI with 11px status text.

## 9. zellij — discoverability demo
https://github.com/zellij-org/zellij
**Medium:** Terminal-session GIF/screenshots showing panes plus the always-visible keybinding hint bar guiding actions live.
**Shows:** A session splitting into panes with the status bar teaching keybindings as you go — the demo shows discoverability and a newcomer being guided, not just an expert flying.
**Why it works:** Its differentiator vs tmux is 'you don't have to memorize anything,' and the GIF proves it by showing hints guiding actions live. The demo doubles as the pitch: onboarding is built into the UI.
**Tone:** Approachable, beginner-welcoming.
**Steal:** If signalbox surfaces the next action ('this one needs you') in the panel, a demo that shows a newcomer being guided to the right session is more persuasive than one showing an expert who already knows the shortcut.

## 10. Supabase — borrowed-mental-model positioning
https://news.ycombinator.com/item?id=27057694
**Medium:** Product screen-recordings of the real workflow, led by a five-word positioning line.
**Shows:** 'The open source Firebase alternative' does the positioning in five words by borrowing a model everyone has; the recording then shows the one payoff — data typed in one pane appearing live via the API in another.
**Why it works:** The borrowed mental model gives instant comprehension with zero new vocabulary, then the demo proves only the single differentiating moment rather than re-explaining the category.
**Tone:** Confident, comparative, plain-spoken — leans on a known reference rather than inventing terms.
**Steal:** 'Jump box' is already a borrowed model — lead with a five-word line ('a jump box for your AI agents') and then let the clip prove only the one differentiating moment: see every session, jump to the one that needs you.

## Lessons for signalbox
- Kill the intro/logo card. Frame 1 should be the Ctrl-Opt-J panel already dropping over the desktop with live agent statuses visible — open on the outcome in motion, not branding (Linear cold open, Alfred power bar).
- Motion is mandatory because signalbox's value is reactive/stateful. Script one continuous, uncut take where an agent's status visibly flips to 'needs you' and you jump straight to it — no cuts means no doubt it's real (starship, tldraw).
- Isolate the single 'oh, nice' moment and loop it silently under ~15s, cropped tight to just the panel that changes. Save feature breadth for a row of small captioned loops below the hero, not one long reel (Fig, Bun, Vercel, gum/htmx cheat-sheet grids).
- Script the capture (VHS .tape / asciinema) instead of hand-recording — deterministic typing and deliberate pauses on the key line, diffable in git, regenerated on every release so it never drifts from the real app (VHS, charm .cast).
- Auto-zoom onto the active region each beat and caption in terse noun-phrases, because signalbox ships iOS and most views are on a phone with sound off. Never show a full-size UI with unreadable 11px status text (Warp).
- Teach the shortcut while demoing: show Ctrl-Opt-J and each action's key inline on the row so the demo doubles as onboarding and graduates users to muscle memory (Linear, Superhuman).
- Lead with the borrowed 'jump box' mental model in ~five words, then let the clip prove only the one differentiating moment — see every session, jump to the one that needs you — instead of touring features (Supabase, Cal.com).
- Match medium to the claim: ship a crisp native screenshot where a still frame captures the payoff (menu-bar craft), reserve motion for the reactive bits, and consider a plain reproducible table if any claim is measurable — don't over-produce (Ghostty, bat, ripgrep).

**Tone models to emulate:** Ghostty — understated, craft-led, developer-to-developer, almost documentation-like; the artifact speaks for itself., ripgrep — rigorous, no-hype, engineer-to-engineer; makes claims it can back up and links methodology., gh (GitHub CLI) — official, clean, restrained; lets copy-pasteable commands speak instead of adjectives.
