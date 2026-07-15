<p align="center">
  <a href="https://github.com/dwmkerr/signalbox">
    <img width="900" src="https://raw.githubusercontent.com/dwmkerr/signalbox/main/docs/images/jumplist.png" alt="The signalbox jumplist: every agent session in one list, the last exchange on the right, and one keystroke to jump to the terminal that needs you">
  </a>
</p>

<p align="center">
  <strong>Quickly jump between agent sessions across terminals and environments. Monitor long-running jobs and keep sight of many parallel tasks at once.</strong>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> |
  <a href="#what-is-signalbox">What is signalbox?</a> |
  <a href="#features-at-a-glance">Features</a> |
  <a href="#privacy--security">Privacy &amp; Security</a>
</p>

<h1></h1>

<p align="center">
  <a href="https://github.com/dwmkerr/signalbox/actions/workflows/ci.yml"><img src="https://github.com/dwmkerr/signalbox/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/dwmkerr/signalbox/releases"><img src="https://img.shields.io/github/v/release/dwmkerr/signalbox?include_prereleases" alt="release"></a>
  <a href="https://www.npmjs.com/package/@dwmkerr/signalbox"><img src="https://img.shields.io/npm/v/@dwmkerr/signalbox" alt="npm"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-bun-000000?logo=bun" alt="built with bun"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

## Quickstart

```bash
brew install dwmkerr/tools/signalbox
signalbox init
```

`signalbox init` walks you through setup: it starts the hub, wires up your coding agents, and checks the menu bar app. It is idempotent - re-run it any time for a status checklist.

## What is signalbox?

signalbox is a tool that configures your coding agents to send a signal as they work - when a task is running, when a message comes back, when input is needed. The signals go to an app on your machine, so you can see the status of every session and jump between them through a macOS jumplist.

<p align="center">
  <img width="820" src="https://raw.githubusercontent.com/dwmkerr/signalbox/main/docs/images/jumplist.png" alt="The signalbox jumplist over several agent sessions">
</p>

This means you can:

- **See every session in one place** - which are working, which need your input, which failed.
- **Jump to any session with a single keystroke** - hit `⌃⌥J`, and jump to any session in any terminal, or straight to a CI run in the browser.
- **Monitor many parallel tasks at once** - long-running jobs and agent sessions, ordered the way you work.

Open a few agent sessions across your terminals and tmux tabs:

<!-- screenshot: 3-4 agent sessions across terminals and tmux tabs -->

Then hit `⌃⌥J` and jump to the one you want:

<!-- video/gif: hit the shortcut, filter, jump to a session -->

## Features at a glance

- **Clear signals** - amber means a session needs your input, blue means output updated, red means failed. The same colours everywhere: jumplist, menu bar, and tmux.
- **Rename sessions** - press `⌃R` in the jumplist to give any session your own name.
- **[Native tmux switcher](#native-tmux-switcher)** - a status-line count and an in-tmux picker, no app needed.

### Native tmux switcher

Live entirely in the terminal if you prefer. A status-line segment shows the waiting count, and `prefix + j` opens a picker over the sessions that need you - Enter jumps to the pane. Navigating to a pane clears its signal, because looking at it is seeing it.

<!-- screenshot: tmux picker -->

Setup is two lines of tmux config - `signalbox init` prints them, or see [docs/tmux.md](https://github.com/dwmkerr/signalbox/blob/main/docs/tmux.md).

## Privacy & Security

signalbox sends signals and messages from coding agent sessions - these can include sensitive data. When running locally, no data leaves your machine. This is an early-stage, experimental project and should still be used with caution.

## Building from source

Needs [bun](https://bun.sh):

```bash
make install       # compiles the CLI and links it into ~/.local/bin
make app           # builds the menu bar app to components/app/build/Signalbox.app
signalbox init
```

## License

[MIT](https://github.com/dwmkerr/signalbox/blob/main/LICENSE).
