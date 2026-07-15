# Security Policy

## Reporting a Vulnerability

Report vulnerabilities privately via [GitHub security advisories](https://github.com/dwmkerr/signalbox/security/advisories/new). Please do not open public issues for security problems. You will get an initial response within a few days.

## Supported Versions

| Version              | Supported |
| -------------------- | --------- |
| 0.x (latest release) | Yes       |
| Older releases       | No        |

## Design Posture

- **Loopback only.** The hub binds to `127.0.0.1` by design and has no authentication layer. Do not port-forward or reverse-proxy it onto a network.
- **Signals, never transcripts.** Events carry session state (busy / attention / done / error) plus small cropped fields - never full agent transcripts. Anything that leaks more than [specs/events.md](../components/specs/events.md) allows is a vulnerability; please report it.
