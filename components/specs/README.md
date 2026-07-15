# Specs

The universal specs every component builds against - lean and clean. Change deliberately; code follows spec: pull-request a spec change and the app changes to match.

Conventions:

- Visual surfaces (jumplist, settings, menu bar) are HTML pages - the mockup on the page is the normative spec, open them in a browser.
- Behaviour and data specs (cli, data model, agent integrations) are markdown - tables and prose, easy to diff and review in a PR.
- The HTML pages' nav links open the markdown specs in their GitHub-rendered view, and the markdown specs' nav links open the HTML specs on the published spec site (https://dwmkerr.github.io/signalbox/specs/), so flicking through the specs stays rendered in the browser in both directions.
- The spec site is published by `.github/workflows/pages.yml`; it goes live when Pages is enabled at launch (Settings, Pages, Source: GitHub Actions - after the repo is public).

| Spec | What |
|---|---|
| [events.md](events.md) | Data model: the event, how events become sessions, ordering, the hub API, privacy |
| [cli.md](cli.md) | Every CLI command, with the terminal output you should expect |
| [adapters.md](adapters.md) | Agent integrations: hook → event mappings for Claude Code, OpenCode, pi, GitHub Actions |
| [hub-jumplist.html](hub-jumplist.html) | The jumplist (⌃⌥J) - interactive UI spec (open in a browser) |
| [menubar.html](menubar.html) | Menu bar: icon (beacon default), status dot, dropdown, notifications |
| [settings.html](settings.html) | Settings window - icon style, /clear and /rename behaviour, additional filters, the jumplist shortcut, where settings live |
