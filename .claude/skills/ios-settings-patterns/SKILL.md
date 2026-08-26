---
name: ios-settings-patterns
description: Apple-platform settings design for signalbox - which control shape fits which problem, what status text should say, and the anti-patterns this project keeps rediscovering. Use when adding or changing anything in the macOS Settings window, the iOS Settings tab, or any pane that pairs a control with live state.
---

# Settings patterns

Covers macOS and iOS. Most of it is macOS because that is where signalbox's
settings window lives; the iOS notes are marked.

Read this before adding a control. The recurring failure in this project is not
bad copy, it is reaching for a checkbox plus a paragraph when the problem wanted
a different shape entirely.

## The one rule that catches most mistakes

**A settings pane is controls, not prose.** If a control needs a paragraph to
explain it, the paragraph is a symptom: either the label is wrong, the shape is
wrong, or the explanation belongs in the docs. Apple's own guidance is blunt
about it:

> Minimize the number of settings you offer. Although people appreciate having
> control over an app, too many settings can make the experience feel less
> approachable, while also making it hard to find a particular setting.

Corollary that decides a surprising number of arguments:

> When possible, prefer letting people modify task-specific options without
> going to your settings area.

If the option only matters while looking at a particular view, it belongs in
that view. This is why signalbox's jumplist filter does not belong in Settings.

## Pick the shape from the problem

| The problem | The shape | Precedent |
|---|---|---|
| A binary that needs no explanation | Checkbox, label says it all, no caption | Any macOS app |
| A binary with one non-obvious consequence | Checkbox plus ONE caption line | System Settings throughout |
| A choice between 2-4 exclusive modes | Radio buttons, one caption line each | Little Snitch operation mode |
| A choice between many peers | List or table, not radios | Sharing pane |
| A background job with progress and results | Toggle in Settings; progress in the surface that uses it | Spotlight, Photos, iCloud Drive, Alfred |
| Something needing verification before use | Field plus an explicit Test button | WireGuard, Zotero sync |
| Diagnostics | Help menu, or a separated button group. Never an inline hyperlink | ~10 of 10 apps surveyed |

The row this project keeps getting wrong is the background job, and the answer
is less UI than it looks. Apple does not put index progress in Settings at all:

- **Spotlight** shows its indexing bar in the Spotlight search window. System
  Settings has only the category checkboxes.
- **Photos** shows "last updated with iCloud Photos" plus Pause/Resume at the
  bottom of the Library window, not in Settings.
- **iCloud Drive** shows a filling pie wedge in Finder and a transfer line in
  Finder's status bar.
- **Alfred** puts a Rebuild button in Preferences > Advanced and leaves the
  progress to Spotlight's own indicator.

The split is consistent: **Settings holds the switch and the expensive action.
The surface that uses the index holds the progress.** That is also where
progress is load-bearing - a search run against a half-built index silently
misses things, and the person needs to know that at the moment they search, not
in a pane they are not looking at.

So a checkbox with a status caption is wrong twice over: wrong shape, and wrong
place.

## What status text should say

From this project's own research (six independent agents, `integration/remote-hub/scratch/synthesis.md`):

- **Render live reality, never intent.** What is actually true right now, from
  something that probed it, not what the settings file says should be true. A
  stale green light destroys trust faster than a missing one.
- **Say the capability, not the mechanism.** "Your devices can open this board
  from anywhere" beats "upstream connected". The user's question is what they
  can now do.
- **A degraded state keeps its label, says the cause, and names what happens
  next.** Mullvad's three-part form. "Can't reach your cloud board right now.
  Events are being kept and will be sent when it's back." beats "Offline".
- **Counts should be the unit the user thinks in.** Not the unit the
  implementation happens to store. Signalbox indexes transcript FILES but
  people think in SESSIONS, and a session's subagent transcripts are separate
  files sharing its id - reporting files overstated sessions by 3.4x.

## Structure

- Multi-pane with a toolbar is the macOS default past one topic; a single flat
  pane is earned by having few settings, not a default to drift out of.
- Six toolbar tabs maximum. General first.
- Window title becomes the pane name once there is more than one pane.
- Restore the last viewed pane on open.
- Open-ended lists of things (agents, devices) get sections inside one pane,
  not a tab each: tabs have a hard cap and the list does not.
- A feature earns its own pane when it has more than one control. One checkbox
  alone does not; a checkbox plus an expensive action such as Rebuild does, and
  Alfred's Advanced tab is exactly that.

## iOS notes

- Grouped `Form` sections with a footer per section; the footer is the one
  place a sentence of explanation is idiomatic, and it is still one sentence.
- Destructive or expensive actions get a confirmation, not a caption warning.
- A background job shows progress inline in the row it belongs to, not in a
  separate status area - screens are narrow and a second area reads as unrelated.

## Anti-patterns, all observed in this project

1. **Status bolted onto a checkbox.** A checkbox that flips on and then grows a
   caption reporting what a background job is doing. Wrong anchor and wrong
   place: the progress belongs in the surface that uses the job, and Settings
   keeps the switch.
2. **A paragraph explaining the feature.** Settings panes are not documentation.
   If someone needs to know what session contents search is, that is a docs
   page.
3. **Showing a mode you cannot change there.** If the pane displays a state, the
   pane must let you change it. Show-but-not-configure violates the basic
   contract of a settings screen.
4. **Mechanism in the UI.** Bind addresses, ports, tokens, byte offsets. The
   only legitimate transport field is a URL someone must type, and it gets a
   Test button.
5. **An inline "open log" hyperlink.** Reads as "opens a web page". Diagnostics
   live in the Help menu.
6. **Explaining privacy in the pane.** Where data lives is a docs question
   unless the user is being asked to consent to something surprising at that
   moment.

## Before you ship a settings change

- Could the label alone carry it, with no caption?
- Is every sentence load-bearing, or is it explaining the feature?
- Does the status line say what is true right now, from a live probe?
- Are the counts in the user's units?
- Does the pane let you change everything it shows?
- Have you updated `components/specs/settings.html`? The mock IS the spec, and
  its status-string table is exhaustive - an unlisted string is a spec bug.

## Where the evidence lives

`integration/remote-hub/scratch/` holds a six-agent research fleet on this
exact question: `synthesis.md` (start here), `research-r3-claude.md` (HIG rules
and per-app conventions, the most reusable), `research-r1-*.md` (Tailscale,
WireGuard, Mullvad, Docker Desktop mode-and-status patterns), `research-r4-kimi.md`
(where diagnostics belong). `synthesis.md` also carries a copy bank of the best
strings found.
