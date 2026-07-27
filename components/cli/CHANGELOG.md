# Changelog

## [0.1.3](https://github.com/dwmkerr/signalbox/compare/v0.1.2...v0.1.3) (2026-07-27)


### Features

* iOS app ([#15](https://github.com/dwmkerr/signalbox/issues/15)) ([fc15494](https://github.com/dwmkerr/signalbox/commit/fc15494386dcc91add9cfa132bdf47644229fe97))
* pinned TLS for the phone connection: the hub serves the phone over https with a persisted self-signed cert whose SHA-256 fingerprint rides the pairing QR, and the app pins it - MITM-proof transport over the LAN with no CA and no user ceremony. Local clients keep plain http on loopback ([#25](https://github.com/dwmkerr/signalbox/issues/25)) ([#28](https://github.com/dwmkerr/signalbox/pull/28))
* `signalbox session clear`: take every session off the board at once, for a clean start ([#28](https://github.com/dwmkerr/signalbox/pull/28))
* the board shows **Hub offline** with Reconnect / Scan / Disconnect when a configured hub is unreachable, instead of the cold first-run pitch ([#28](https://github.com/dwmkerr/signalbox/pull/28))
* real permission and question content on attention rows ([#29](https://github.com/dwmkerr/signalbox/issues/29)) ([#28](https://github.com/dwmkerr/signalbox/pull/28))
* the app version is shown in the macOS menu bar and at the bottom of iOS Settings ([#28](https://github.com/dwmkerr/signalbox/pull/28))

## [0.1.2](https://github.com/dwmkerr/signalbox/compare/v0.1.1...v0.1.2) (2026-07-15)


### Features

* merge agent hooks on consent, app icon, tiered help ([#9](https://github.com/dwmkerr/signalbox/issues/9)) ([3f9c97b](https://github.com/dwmkerr/signalbox/commit/3f9c97b2704b982421dc1f33ca174fb858a9738c))

## [0.1.1](https://github.com/dwmkerr/signalbox/compare/v0.1.0...v0.1.1) (2026-07-15)


### Features

* signalbox - a local-first events board for AI coding agents ([d23dff9](https://github.com/dwmkerr/signalbox/commit/d23dff9ec4d6fdd5360dd4fe325e732316656bd0))
