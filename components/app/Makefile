APP := Signalbox
BUILD_DIR := build
BUNDLE := $(BUILD_DIR)/$(APP).app
CONTENTS := $(BUNDLE)/Contents

# The CLI the bundle ships (Contents/Resources/signalbox): the app spawns it
# as the hub and the cask symlinks it onto PATH, so one artifact installs the
# whole product. Point CLI_BIN elsewhere (e.g. a lipo'd universal binary in
# CI) to embed a different build.
CLI_BIN ?= ../cli/bin/signalbox

# Stamp the bundle version at packaging time (the source Info.plist stays at a
# dev placeholder). CI passes VERSION from the release tag.
VERSION ?=

# Extra swift build flags - CI passes "--arch arm64 --arch x86_64" for a
# universal binary.
SWIFT_FLAGS ?=

# This CommandLineTools install ships a stale (Feb 2024) PackageDescription
# *.private.swiftinterface next to a newer libPackageDescription.dylib, so
# every SwiftPM manifest compile fails to link. Point SwiftPM at a copy of the
# manifest libs with the stale private interfaces removed; swiftc then falls
# back to the correct public .swiftinterface. Regenerated on every build so it
# tracks toolchain updates.
TOOLCHAIN_PM := $(shell dirname "$$(xcrun --find swift)")/../lib/swift/pm
MANIFEST_LIBS := .build/manifest-libs
export SWIFTPM_CUSTOM_LIBS_DIR := $(CURDIR)/$(MANIFEST_LIBS)

# Developer ID signing + notarization. NOTARY_PROFILE is a notarytool
# keychain profile created once with `xcrun notarytool store-credentials`
# (CI recreates it from secrets before calling notarize).
SIGN_IDENTITY := Developer ID Application: Dave Kerr (5TTNE9J58F)
TEAM_ID := 5TTNE9J58F
NOTARY_PROFILE := signalbox-notary
NOTARIZE_ZIP := $(BUILD_DIR)/$(APP).zip

.PHONY: all app build manifest-libs clean notarize

all: app

manifest-libs:
	rm -rf "$(MANIFEST_LIBS)"
	mkdir -p "$(MANIFEST_LIBS)"
	cp -R "$(TOOLCHAIN_PM)/ManifestAPI" "$(MANIFEST_LIBS)/ManifestAPI"
	cp -R "$(TOOLCHAIN_PM)/PluginAPI" "$(MANIFEST_LIBS)/PluginAPI"
	find "$(MANIFEST_LIBS)" -name '*.private.swiftinterface' -delete

build: manifest-libs
	swift build -c release $(SWIFT_FLAGS)

app: build
	rm -rf "$(BUNDLE)"
	mkdir -p "$(CONTENTS)/MacOS" "$(CONTENTS)/Resources"
	cp "$$(swift build -c release $(SWIFT_FLAGS) --show-bin-path)/$(APP)" "$(CONTENTS)/MacOS/$(APP)"
	cp Info.plist "$(CONTENTS)/Info.plist"
	printf 'APPL????' > "$(CONTENTS)/PkgInfo"
	@if [ -n "$(VERSION)" ]; then \
		/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $(VERSION)" "$(CONTENTS)/Info.plist"; \
	fi
	@if [ -x "$(CLI_BIN)" ]; then \
		cp "$(CLI_BIN)" "$(CONTENTS)/Resources/signalbox"; \
		echo "embedded CLI: $(CLI_BIN)"; \
	else \
		echo "warning: $(CLI_BIN) not built - bundle has no CLI (run 'make build' at the repo root first)"; \
	fi
	codesign --force --sign - "$(BUNDLE)"
	@echo "Built $(BUNDLE)"

# Developer ID signing (hardened runtime + secure timestamp, both required
# for notarization), then submit to Apple and staple the ticket so Gatekeeper
# accepts the app offline. The embedded CLI is signed FIRST and with the JIT
# entitlements a bun-compiled binary needs under the hardened runtime
# (JavaScriptCore); signing the bundle afterwards seals it. No --deep: it
# would re-sign the CLI without its entitlements.
notarize: app
	@test -x "$(CONTENTS)/Resources/signalbox" || { echo "refusing to notarize a bundle without the CLI"; exit 1; }
	codesign --force --options runtime --timestamp \
		--entitlements bun-entitlements.plist \
		--sign "$(SIGN_IDENTITY)" "$(CONTENTS)/Resources/signalbox"
	codesign --force --options runtime --timestamp \
		--sign "$(SIGN_IDENTITY)" "$(BUNDLE)"
	codesign --verify --strict --deep "$(BUNDLE)"
	ditto -c -k --keepParent "$(BUNDLE)" "$(NOTARIZE_ZIP)"
	xcrun notarytool submit "$(NOTARIZE_ZIP)" \
		--keychain-profile "$(NOTARY_PROFILE)" --wait
	xcrun stapler staple "$(BUNDLE)"
	xcrun stapler validate "$(BUNDLE)"
	@# Re-zip so the shipped archive contains the stapled bundle.
	ditto -c -k --keepParent "$(BUNDLE)" "$(NOTARIZE_ZIP)"
	@echo "Notarized and stapled $(BUNDLE) -> $(NOTARIZE_ZIP)"

clean:
	rm -rf .build "$(BUILD_DIR)"
