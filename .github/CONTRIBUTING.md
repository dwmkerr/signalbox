# Contributing

Thanks for helping build signalbox.

## Contract First

[components/specs/](../components/specs/) is the coordination spec - the CLI,
hub, macOS app, and adapters all build against it. If your change touches the
event schema, state model, or hub endpoints, update the contract in the same
PR. Change it deliberately.

## Local Development

```bash
git clone https://github.com/dwmkerr/signalbox
cd signalbox
make build   # compile ./components/cli/bin/signalbox with bun (the hub is the same binary: 'signalbox hub')
make test    # run the test suite
make hub     # run the hub in the foreground on http://127.0.0.1:8377
make app     # build the menu bar app (it runs the hub for you and embeds the CLI)
```

Requires [Bun](https://bun.sh) 1.3+. The macOS menu bar app builds with
SwiftPM (no Xcode project needed). Agent adapters live in
`components/cli/adapters/`.

## Commits and Pull Requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, ...) - [release-please](https://github.com/googleapis/release-please) derives versions and the changelog from commit messages.
- Open pull requests against `main`. Keep them small and focused.
- CI must pass: typecheck, tests, CLI compile, app build, and adapter syntax checks.
