# Releasing Signalbox to TestFlight

The iOS app ships through App Store Connect / TestFlight. The build chain below
is verified end to end: a Release archive, a distribution-signed `.ipa`, the
privacy manifest, and the export-compliance flag all produced without any human
in the loop except the two Apple-portal steps called out at the end.

Bundle id `com.dwmkerr.signalbox.ios`, team `5TTNE9J58F`. Run everything from
`components/ios`.

## What is already in place

- **Release configuration** in `Signalbox.xcodeproj/project.pbxproj`: optimized
  (`-O`, whole-module), no `DEBUG` condition, `dwarf-with-dsym`, `VALIDATE_PRODUCT`.
  The `#if DEBUG` pairing side doors compile out (verified: none of their string
  literals survive in the Release binary).
- **Shared scheme** `Signalbox.xcscheme`: Archive and Profile use Release, Run and
  Test stay on Debug. Without it `xcodebuild archive -scheme Signalbox` is not deterministic.
- **`SignalboxApp/PrivacyInfo.xcprivacy`**: no tracking, no collected data, one
  required-reason API (UserDefaults, `CA92.1`). Lands in the bundle root via the
  synchronized group.
- **Export compliance**: `ITSAppUsesNonExemptEncryption=false` in
  `Partial-Info.plist`, merged into the built `Info.plist`. Only exempt crypto
  (HTTPS, Keychain) is used, so App Store Connect skips the per-build questionnaire.
- **`ExportOptions.plist`**: `method app-store-connect`, `destination export`
  (safe default, see below).

## Build and package

Archive for device. `-allowProvisioningUpdates` lets Xcode's signed-in account
mint the App Store provisioning profile and the Cloud Managed Apple Distribution
certificate the first time.

The version is stamped from the release-please-managed line at archive time:
`components/cli/package.json` is the single source of truth for the product
version (one 0.1.x release line for CLI, macOS app, and iOS), so a TestFlight
build never needs a release PR to carry the current version, and a real
release bumps every surface at once. Bump `CURRENT_PROJECT_VERSION` (Apple's
build counter) manually per upload - App Store Connect rejects duplicates.

```sh
VERSION=$(node -p "require('../cli/package.json').version")
xcodebuild archive \
  -project Signalbox.xcodeproj -scheme Signalbox -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath ./build/Signalbox.xcarchive \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=5TTNE9J58F \
  MARKETING_VERSION="$VERSION"
```

Export a distribution-signed `.ipa` to `./build/export/Signalbox.ipa`. With
`destination export` this writes the file and does NOT contact Apple:

```sh
xcodebuild -exportArchive \
  -archivePath ./build/Signalbox.xcarchive \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath ./build/export \
  -allowProvisioningUpdates
```

The resulting `.ipa` is signed `Apple Distribution: Dave Kerr (5TTNE9J58F)` with
`beta-reports-active=true` and `get-task-allow=false`: a real TestFlight build.

Sanity-check a Release build against the simulator without signing:

```sh
xcodebuild build -project Signalbox.xcodeproj -scheme Signalbox \
  -configuration Release -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO -derivedDataPath ./build
```

## Upload (the release step)

Pick one. Both need the App Store Connect app record to exist first (see below).

- **Flip the export to upload.** Change `destination` in `ExportOptions.plist`
  from `export` to `upload` and re-run the `-exportArchive` command above. It
  uploads the build directly. The committed default stays `export` so running the
  documented command can never upload by accident.
- **Transporter.** Keep `destination export` and drop `./build/export/Signalbox.ipa`
  into the Transporter app (or `xcrun notarytool`/Transporter CLI). Useful when the
  machine doing the upload is not the one that built.

## Two steps only Dave can do

1. **Create the App Store Connect app record** for `com.dwmkerr.signalbox.ios`
   at https://appstoreconnect.apple.com (My Apps -> +). Upload fails until the
   record exists. One-time.
2. **Choose upload auth:**
   - the signed-in Xcode account, used automatically by `-allowProvisioningUpdates`
     when `destination` is `upload`, or
   - an **App Store Connect API key** (Users and Access -> Integrations -> Keys)
     for CI. Add `-authenticationKeyPath`, `-authenticationKeyID`, and
     `-authenticationKeyIssuerID` to the export command, or reference the key from
     `ExportOptions.plist`.

After the first archive, confirm the Cloud Managed Apple Distribution certificate
exists under Certificates in the developer portal. `security find-identity` will
NOT list it: cloud-managed certs live in Apple's account, not the local keychain.
