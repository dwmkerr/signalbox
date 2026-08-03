# Cable deploy: build a development-signed app and install it on the
# USB-connected iPhone. TestFlight releases go through RELEASE.md instead.
#
# The build is stamped: MARKETING_VERSION from the CLI's package.json and
# CURRENT_PROJECT_VERSION from the clock, so Settings' bottom line (e.g.
# "0.1.6 (202608031154)") proves which build the phone is running - an
# unstamped dev build shows the pbxproj placeholder and is indistinguishable
# from the previous deploy.
#
# -allowProvisioningUpdates is safe HERE (a local machine with a persistent
# keychain); the CLAUDE.md ban on it is about ephemeral CI runners, where it
# mints a fresh cert every run and hits Apple's per-account cap.

VERSION ?= $(shell sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../cli/package.json | head -1)
STAMP := $(shell date +%Y%m%d%H%M%S)
DD := build-device
APP := $(DD)/Build/Products/Debug-iphoneos/Signalbox.app

# First reachable device (unavailable ones filtered out - a stale pairing
# must not shadow the plugged-in phone); override with DEVICE=<identifier>
# when more than one phone is attached.
DEVICE ?= $(shell xcrun devicectl list devices 2>/dev/null | grep -v unavailable | grep -Eo '[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}' | head -1)

.PHONY: device build-device install-device

device: build-device install-device

# The pbxproj deliberately carries no team (CI signs manually with stored
# certs); a local dev-signed build supplies it here.
TEAM := 5TTNE9J58F

build-device:
	xcodebuild build -project Signalbox.xcodeproj -scheme Signalbox \
	  -destination 'generic/platform=iOS' -derivedDataPath $(DD) \
	  -allowProvisioningUpdates \
	  DEVELOPMENT_TEAM=$(TEAM) CODE_SIGN_STYLE=Automatic \
	  MARKETING_VERSION=$(VERSION) CURRENT_PROJECT_VERSION=$(STAMP)

install-device:
	@test -n "$(DEVICE)" || { echo "no device found - plug the phone in (xcrun devicectl list devices)"; exit 1; }
	xcrun devicectl device install app --device $(DEVICE) $(APP)
	@echo "installed $(VERSION) ($(STAMP)) on $(DEVICE) - Settings bottom line should match"
