---
name: resolve-issue
description: Make a zero-shot first attempt at a signalbox GitHub issue or a bug found in conversation, ending in a PR with before/after screenshots built from sample data, monitored until its checks pass - or an issue comment explaining why not. Use when the user says "resolve issue #N", "zero-shot this", "fix and PR it with screenshots", or "add before/after screenshots to the PR".
---

# Resolve an issue

A first effort, without a human in the loop. Get from an issue to a reviewable PR in one pass. The operator reviews it and merges, asks for changes or takes over. A clear PR that fails honestly is worth more than a polished one that hides a guess.

Running this skill is the operator's go-ahead to create an issue, push a fix branch, upload screenshots and open a PR. Never push to `main` and never merge. Branches start from `main` and their PRs target it.

## The one rule: sample data only

`dwmkerr/signalbox` is **public**. Screenshots, logs and PR text are published. The operator's real board holds session titles, prompts and replies from their work, so:

- Screenshots come only from an isolated hub seeded with sample data (`scripts/isolated-env.sh`). Never from the operator's running app or hub (port 8377, or its upstream).
- Capture one window by id (`screencapture -l`), never the screen or a region: those include whatever else is open.
- Look at every image before uploading it. If anything real shows, delete it and fix the isolation.
- Issue and PR text describe the bug generically. Never quote the operator's session names, prompts or paths, even when the bug was found on their board.

## 1. Find the work

The input is one of:

- **An issue**, `#146`: `gh issue view 146 --comments`.
- **A bug found in this conversation**: search for an existing issue (`gh issue list --state all --search "<keywords>"`). If none exists, create one with the `bug` label (or `enhancement`): a conventional-commit title, what happens, the cause if known, and what should happen. Every PR closes an issue.

## 2. Decide whether to attempt it

Stop and comment on the issue instead of coding when any of these hold:

- It needs a product or design decision the issue doesn't make.
- It breaks backwards compatibility (the repo's `CLAUDE.md` makes that a planning question).
- It changes signing, release, TestFlight or the hub's auth/pairing.
- The fix is clearly bigger than about 10 files or 300 lines.
- You can't reproduce it.

The comment says what you found: where the code is, the likely cause, the options and which you'd pick.

## 3. Branch

The repo is a set of worktrees (`signalbox/main`, `signalbox/fix/<name>`, ...). Make a new one from `main`; never work in a worktree another session owns:

```bash
git -C <any-worktree> fetch origin
git -C <any-worktree> worktree add -b fix/<short-slug> <repo-root>/fix/<short-slug> origin/main
```

## 4. Make the change

- Follow the repo's `CLAUDE.md`: update `components/specs/` in the same change, adjacent tests, comments explain why.
- `cd components/cli && bun test && bunx tsc --noEmit`. App changes: `make -C components/app app`. iOS: a clean simulator build.

## 5. Capture before and after

Work out which surfaces show the problem: macOS jumplist, iOS app, CLI output (`signalbox state`). A hub fix usually shows on both apps, because both render the hub's `/state`. Capture every surface that can show it; any surface without shots needs a reason in the PR's Checks.

**Seed.** Write a seed script that recreates the bug with neutral names (see `scripts/example-seed.sh`). `components/scripts/demo.sh` gives a realistic background board through `signalbox fire`; POST to `/events` for fields `fire` has no flag for, such as `parent_session_key`. The seed takes the hub URL as its only argument, so before and after use exactly the same data.

**Builds.** "Before" is `main`, "after" is your branch. When the fix is in the hub, keep the app and iOS builds the same and swap only the CLI:

```bash
make -C <repo-root>/main build                       # before: main/components/cli/bin/signalbox
make -C <worktree> build && make -C <worktree>/components/app app   # after, plus the app bundle
cd <worktree>/components/ios && xcodebuild -project Signalbox.xcodeproj -scheme Signalbox \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath ../../scratch/ios-dd build
```

Check for `BUILD SUCCEEDED`; a swallowed failure installs a stale app.

**Capture.** Out dir `scratch/resolve-<issue>/` (gitignored):

```bash
S=.claude/skills/resolve-issue/scripts
$S/capture-mac.sh before <main-cli> <app-bundle> <seed> scratch/resolve-<n>
$S/capture-mac.sh after  <branch-cli> <app-bundle> <seed> scratch/resolve-<n>
$S/capture-ios.sh before <main-cli> <ios-app> <seed> scratch/resolve-<n>   # needs a booted Simulator
$S/capture-ios.sh after  <branch-cli> <ios-app> <seed> scratch/resolve-<n>
```

The mac capture opens a second, background app instance (`open -g -n`, `ui.foreground=false`) against the isolated hub and leaves the operator's app alone. `screencapture` needs Screen Recording permission; a grey frame means the window was captured before it drew. Each run leaves `state.json` and `healthz.json` in its run dir; check `healthz.json` says `"mode":"local"` and the build you meant.

Look at every pair. The before shot must show the bug; if it doesn't, you haven't reproduced it.

## 6. Upload the screenshots

```bash
$S/upload-assets.sh <pr-or-issue-number> scratch/resolve-<n>/{mac,ios}-{before,after}.png
```

Images go on the orphan `pr-assets` branch, one folder per PR or issue, through the contents API: no checkout, no push. Re-uploading a path needs its blob `sha`, so prefer new names.

## 7. Open the PR

Two guards sit in front of `git push`: the agent push guard (`SIGNALBOX_ALLOW_PUSH=1`) and the machine's git-guard, which blocks public repos without an audited reason:

```bash
SIGNALBOX_ALLOW_PUSH=1 GIT_GUARD_REASON="<operator> asked to resolve #<n> in the personal open-source repo dwmkerr/signalbox on <date>." \
  git push -u origin HEAD
SIGNALBOX_ALLOW_PUSH=1 gh pr create --base main --title "<conventional commit title>" --body-file scratch/resolve-<n>/pr.md
```

`gh pr edit` fails on this repo (a classic Projects GraphQL deprecation error). Edit bodies with REST: `gh api -X PATCH repos/dwmkerr/signalbox/pulls/<pr> -F body=@scratch/resolve-<n>/pr.md`.

Open as a draft when the fix is partial or a surface couldn't be checked. The body:

```markdown
## Summary
- <what changed and why, 1-3 bullets>

Closes #<issue>

## Before and after
Sample data only: <one line on what the seed shows>.

| | Before | After |
| --- | --- | --- |
| macOS jumplist | <img src="...mac-before.png?raw=true" width="480"> | <img src="...mac-after.png?raw=true" width="480"> |
| iOS | <img src="...ios-before.png?raw=true" width="280"> | <img src="...ios-after.png?raw=true" width="280"> |

## Checks
- <tests run and results; anything not checked and why>
```

## 8. Monitor the PR

A PR isn't done when it's opened. Watch its checks in the background and act on the result:

```bash
gh pr checks <pr> --watch --interval 30      # run_in_background; you are notified on exit
```

- **Green:** report it.
- **A failure caused by the change:** fix it, push, watch again.
- **A failure not caused by the change:** prove it (`gh run view <run> --log-failed`; compare with the last green `main` run and its runner image). Rerun failed jobs once (`gh run rerun <run> --failed`) to rule out a flake. If it fails again, fix the cause in a separate small PR and link it from this one's Checks; don't bundle it into the fix.

## 9. Report

Give the operator:

- The PR URL (and any follow-up PR), or the issue comment URL if you stopped at step 2.
- The issue number, and whether you created it.
- Final check status.
- Anything you didn't check or weren't sure of.
