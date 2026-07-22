# Specs

The universal specs every component builds against. Code follows spec: pull-request a spec change and the app changes to match.

Conventions:

- Visual surfaces (jumplist, settings, menu bar, ios) are HTML pages. The mockup on the page is the normative spec; open it in a browser. Architecture is an HTML page too, and its diagrams are the spec.
- Behaviour and data specs (cli, data model, agent integrations) are markdown. Tables and prose diff and review cleanly in a PR.
- A spec may lead the code. Sections describing unbuilt behaviour carry a status chip (`proposed`, `later`) and a banner. Unmarked sections match the code.
- HTML nav links open the markdown specs in their GitHub-rendered view. Markdown nav links open the HTML specs on the published spec site (https://dwmkerr.github.io/signalbox/specs/). Paging through the specs stays rendered in both directions.
- The spec site is published by `.github/workflows/pages.yml`. It goes live when Pages is enabled at launch (Settings, Pages, Source: GitHub Actions, after the repo is public).

| Spec | What |
|---|---|
| [events.md](events.md) | Data model: the event, how events become sessions, ordering, the hub API, privacy |
| [cli.md](cli.md) | Every CLI command, with the terminal output you should expect |
| [adapters.md](adapters.md) | Agent integrations: hook → event mappings for Claude Code, OpenCode, pi, GitHub Actions |
| [hub-jumplist.html](hub-jumplist.html) | The jumplist (⌃⌥J) - interactive UI spec (open in a browser) |
| [menubar.html](menubar.html) | Menu bar: icon (beacon default), status dot, dropdown, notifications |
| [settings.html](settings.html) | Settings window - icon style, /clear and /rename behaviour, additional filters, the jumplist shortcut, where settings live |
| [ios.html](ios.html) | The iOS app - the board on your phone: rows, actions, connection state, hubs (**proposed**, not built) |
| [init.html](init.html) | The guided setup (`signalbox init`) - when it edits your config vs prints a snippet, the honest states, managed markers, and `--reverse` (**proposed**, not built) |
| [architecture.html](architecture.html) | Topology and security: local vs remote hub, why jump is local, the security tiers, what we rejected (**partly proposed**) |
