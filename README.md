<h1 align="center">Are you tab-hunting your agents?</h1>

<p align="center">
  <strong>Your fingers are sore and your brain is hurting.</strong>
</p>

<p align="center">
  Why not see everything in one place with a single keystroke instead? Jump where the action is with another? The chaos is still there, you are still doing too much, but at least you are saving half a second each time you context switch.
</p>

<p align="center">
  <a href="https://dwmkerr.github.io/signalbox/">
    <img width="900" src="docs/images/hero-anim.gif" alt="Animated: left, a pile of restless agent terminals; right, the signalbox board - one keystroke jumps the selection to the agent that needs you, surfacing the buried session from the chaos.">
  </a>
</p>

<p align="center">
  <a href="https://github.com/dwmkerr/signalbox/actions/workflows/ci.yml"><img src="https://github.com/dwmkerr/signalbox/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/dwmkerr/signalbox/releases"><img src="https://img.shields.io/github/v/release/dwmkerr/signalbox?include_prereleases" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>


## Quickstart

Install and then run `signalbox init` - your coding agents across Cursor, Claude Code, Codex, OpenCode, pi and more will now report their progress to a local hub while you work.

```sh
# Install Signalbox then configure agent integrations.
brew install dwmkerr/tools/signalbox
signalbox init

# Star the repo if you find this useful.
gh api -X PUT user/starred/dwmkerr/signalbox

# Install the mobile app via TestFlight:
open https://testflight.apple.com/join/umJpETbZ
```


Open the jumplist with Control-Option-J to see every session and jump to the one you need. The right pane renders the latest three exchanges in chronological order. Older exchanges are dimmed, Markdown uses terminal styling, and cropped text ends with the U+2026 marker defined by the [Agent Markdown specification](components/specs/agent-markdown.md).

<p align="center">
  <img width="820" src="docs/images/jumplist.png" alt="The signalbox jumplist with a session list and a right pane showing recent Markdown-rendered prompts and replies.">
</p>

Or see running sessions in the menu bar:

<p align="center">
  <img width="480" src="docs/images/menubar.png" alt="The signalbox menu bar dropdown: a status dot on the icon, one row per session with its agent glyph and age">
</p>

[Install the app](https://testflight.apple.com/join/umJpETbZ) and pair with a QR code to see your sessions on your phone. Touch and hold a session, then choose Show Chat to read its history:

<p align="center">
  <img width="860" src="docs/images/ios-pairing.svg" alt="Pairing signalbox: the Connect Phone window on the Mac shows a QR code, and next to it the iOS app shows the board - one card per agent session with its status, glyph and latest exchange">
</p>

Integrations for popular tools like Cursor, Claude Code, Codex and so on are documented in [Integrations](docs/integrations.md).

## Video Demo

A (janky) video showing how to manage sessions with signalbox:

https://github.com/user-attachments/assets/2f45c187-e90a-4151-bc40-19ddfa48d89a

## Running a remote hub

Connect your phone over the internet, or forward events from multiple machines to one board, by running a [remote hub](docs/remote-hub.md). The guide covers deploying one to fly.io or any Docker host, and pointing your machines at it.

## Privacy & Security

signalbox sends signals and messages from coding agent sessions - these can include sensitive data. In Local mode no data leaves localhost. In LAN mode events are accessible to machines on the same local network. Remote mode forwards events to a remote host and should be used with caution. This is an early-stage, experimental project.

## Developer Guide

Clone and build:

```bash
make install       # compiles the CLI and links it into ~/.local/bin
make app           # builds the menu bar app (embeds the CLI; the app runs the hub)
open components/app/build/Signalbox.app
signalbox init
```

Build and run the iOS app (in testing while App Store review is ongoing):

```bash
open components/ios/Signalbox.xcodeproj
# pick a simulator or your iPhone in Xcode and press Run
# (a device build needs your signing team under Signing & Capabilities)
```

On the simulator the app connects to your Mac's hub automatically. On a real device, pair with a QR code: run `signalbox pair` (or choose "Connect Phone" in the menu bar app) and scan it from Settings > Scan to Connect. The full guide - command-line builds, device signing, dev hooks - is [Building the mobile app](docs/mobile.md); the UI spec is [ios.html](components/specs/ios.html).

In general, it is easier to iterate on the [specs](components/specs/) with your coding agent for fast feedback, then letting it knock out the code.

There is also a native [tmux jump list](docs/tmux.md) (`<Leader>J`).

## Troubleshooting

- The app-spawned hub logs to `~/.local/state/signalbox/hub.log` (view it in 'Settings > Logs') - start there when the board looks wrong.
- Remote hub issues: see [troubleshooting](docs/remote-hub.md#troubleshooting) in the remote hub guide.

## License

[MIT](LICENSE).
