# Building the mobile app

The signalbox iOS app is not publicly distributed yet. Build and run it locally
with Xcode. It lives in `components/ios/`: an Xcode project
(`Signalbox.xcodeproj`, scheme `Signalbox`), SwiftUI, deployment target iOS 18.0.

## Prerequisites

- Xcode with the iOS 18 SDK.
- The command-line tools (`xcodebuild`, `xcrun` and `simctl` ship with Xcode).

## Run on the simulator

The simulator needs no signing. Build for a booted simulator:

```sh
xcodebuild \
  -project components/ios/Signalbox.xcodeproj \
  -scheme Signalbox \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath components/ios/build \
  build
```

Install and launch the built app on the booted simulator:

```sh
xcrun simctl install booted \
  components/ios/build/Build/Products/Debug-iphonesimulator/Signalbox.app
xcrun simctl launch booted com.dwmkerr.signalbox.ios
```

Or open `components/ios/Signalbox.xcodeproj` in Xcode, pick a simulator and press
Run.

## Run on a device

A device build needs a signing team. The distribution certificate is
cloud-managed in Apple's account. Set the team to `5TTNE9J58F`:

```sh
xcodebuild \
  -project components/ios/Signalbox.xcodeproj \
  -scheme Signalbox \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=5TTNE9J58F \
  build
```

In Xcode, select your device, set the team under Signing and Capabilities, then
Run. The bundle id is `com.dwmkerr.signalbox.ios`.

## Connect to a hub (pairing)

The app talks to a signalbox hub. Start one on your Mac:

```sh
signalbox hub
```

It listens on `http://127.0.0.1:8377` by default.

On the simulator, loopback reaches the Mac's hub directly, so the app
auto-connects with no setup.

On a real device you pair over the LAN. The hub must be bound wide enough for the
phone to reach it (not loopback only). Either path handles this:

- Run `signalbox pair` on the Mac. It prints a QR code that encodes the hub's LAN
  URL and a one-time code.
- Or use "Connect Phone" from the macOS menu bar app, which shows the same QR.

Scan it from the app: Settings > Scan to Connect, or the QR button at the top
right of Sessions. The token never appears on screen or in the QR; the phone
redeems the code for it. Pairing details are in
[specs/cli.md](../components/specs/cli.md).

### Dev and test hooks

Debug builds read a few environment variables (inert in shipped builds):

- `SIGNALBOX_URL` points the app at a hub.
- `SIGNALBOX_TAB` opens a tab on launch.
- `SIGNALBOX_SEED_TOKEN` seeds a Keychain token.

Pass them through `simctl` with the `SIMCTL_CHILD_` prefix:

```sh
SIMCTL_CHILD_SIGNALBOX_TAB=1 xcrun simctl launch booted com.dwmkerr.signalbox.ios
```

## TestFlight (internal testing)

Internal testers get the app through TestFlight, not the public App Store. A push
to `main` runs `.github/workflows/testflight.yml`, which archives a Release build
and uploads it. Distribution signing is cloud-managed with an App Store Connect
API key, so no certificates live in CI. You can also archive and upload locally.
Building on the simulator is the fastest loop for day-to-day work.

## Where the spec lives

The iOS UI spec is [components/specs/ios.html](../components/specs/ios.html).
