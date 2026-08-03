# Changelog

## [0.1.7](https://github.com/dwmkerr/signalbox/compare/v0.1.6...v0.1.7) (2026-08-03)


### Features

* integration-test skill with HTML evidence report ([#55](https://github.com/dwmkerr/signalbox/issues/55)) ([22e921f](https://github.com/dwmkerr/signalbox/commit/22e921fe1d4d30d28bb601c4e8bc27a7ec108ab6))


### Bug Fixes

* iOS connection flap on pinned LAN hubs - per-attempt sessions, uncached probes ([#57](https://github.com/dwmkerr/signalbox/issues/57)) ([c9a2070](https://github.com/dwmkerr/signalbox/commit/c9a2070b7ac129cd82618542d5ad1191300de26d)), closes [#54](https://github.com/dwmkerr/signalbox/issues/54)

## [0.1.6](https://github.com/dwmkerr/signalbox/compare/v0.1.5...v0.1.6) (2026-08-01)


### Features

* remote hub - forwarder mode, hub settings redesign, and status surfaces ([#47](https://github.com/dwmkerr/signalbox/issues/47)) ([8634cce](https://github.com/dwmkerr/signalbox/commit/8634cce5b56b87337474e1eb18abf5d7b863bb3f))

## [0.1.5](https://github.com/dwmkerr/signalbox/compare/v0.1.4...v0.1.5) (2026-07-28)


### Features

* Cursor prompt + reply previews (transcript parse) + hero 'Get the app' ([#36](https://github.com/dwmkerr/signalbox/issues/36)) ([ebcb5e3](https://github.com/dwmkerr/signalbox/commit/ebcb5e312cdd55b405516ed5e16ed0304065a84a))

## [0.1.4](https://github.com/dwmkerr/signalbox/compare/v0.1.3...v0.1.4) (2026-07-27)


### Bug Fixes

* clearer offline state, macOS version in Settings, brew install UX ([#33](https://github.com/dwmkerr/signalbox/issues/33)) ([17614e6](https://github.com/dwmkerr/signalbox/commit/17614e65abb52303d81c57521a772878fd08d01b))

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
