default: help

BIN := components/cli/bin/signalbox

# Resolved by name, never by UDID: a UDID belongs to one machine and breaks
# silently on any other, or if the simulator is ever deleted.
IOS_SIM ?= iPhone 17 Pro
IOS_BUNDLE := com.dwmkerr.signalbox.ios

.PHONY: help
help: # Show help for each of the Makefile recipes.
	@grep -E '^[a-zA-Z0-9 -]+:.*#'  Makefile | sort | while read -r l; do printf "\033[1;32m$$(echo $$l | cut -f 1 -d':')\033[00m:$$(echo $$l | cut -f 2- -d'#')\n"; done

.PHONY: build
build: # Compile the signalbox CLI to ./components/cli/bin/signalbox (the hub is the same binary: 'signalbox hub').
	cd components/cli && bun install --frozen-lockfile && bun run build

.PHONY: install
install: build # Build and symlink the CLI into ~/.local/bin so 'signalbox' is on your PATH.
	mkdir -p $(HOME)/.local/bin
	ln -sf $(abspath $(BIN)) $(HOME)/.local/bin/signalbox
	@# Kill a running hub so it picks up this build (an old long-lived hub
	@# silently rejects new event shapes) - the app's supervisor respawns it
	@# within seconds. No-op and quiet when no hub is running.
	@pkill -f 'signalbox hub' 2>/dev/null \
		&& echo "hub stopped - the app respawns it with the new build" || true

.PHONY: hub
hub: build # Run the hub locally on http://127.0.0.1:8377 (keep it running; Ctrl-C to stop).
	./$(BIN) hub

.PHONY: test
test: # Run the test suite.
	cd components/cli && bun test

.PHONY: typecheck
typecheck: # Typecheck the CLI sources.
	cd components/cli && bunx tsc --noEmit

.PHONY: check
check: typecheck test # Full local pre-push gate - mirrors what CI runs (typecheck, tests, adapter syntax).
	node --check components/cli/adapters/opencode/signalbox.js
	node --check components/cli/adapters/pi/signalbox.ts

.PHONY: ios
ios: # Build the iOS app for the simulator, install it, and launch it.
	@# No signing: the simulator needs no certificate and no provisioning
	@# profile. Do not add DEVELOPMENT_TEAM - the only cert on a dev machine is
	@# likely a macOS Developer ID, which automatic signing will latch onto and
	@# fail on confusingly for an iOS target.
	@# No -destination and no simulator UDID: a UDID is one machine's, and
	@# -sdk iphonesimulator is enough to build.
	cd components/ios && xcodebuild build -project Signalbox.xcodeproj -scheme Signalbox \
		-sdk iphonesimulator -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO \
		| grep -E 'BUILD (SUCCEEDED|FAILED)|error:' || true
	@# 'Unable to boot device in current state: Booted' is benign.
	@xcrun simctl boot $(IOS_SIM) 2>/dev/null || true
	@open -a Simulator
	xcrun simctl install booted components/ios/build/Build/Products/Debug-iphonesimulator/Signalbox.app
	xcrun simctl launch booted $(IOS_BUNDLE)

.PHONY: ios-logs
ios-logs: # Stream the iOS app's console output from the simulator.
	xcrun simctl spawn booted log stream --level debug --predicate 'subsystem contains "signalbox" or process == "Signalbox"'

.PHONY: ios-shot
ios-shot: # Screenshot the running simulator to /tmp/signalbox-ios.png.
	xcrun simctl io booted screenshot /tmp/signalbox-ios.png
	@echo "wrote /tmp/signalbox-ios.png"

.PHONY: clean
clean: # Remove build artifacts and bun's scratch files.
	rm -rf components/cli/bin components/cli/*.bun-build components/cli/.*.bun-build
	rm -rf components/ios/build
	$(MAKE) -C components/app clean

.PHONY: app
app: build # Build the menu bar app (with the CLI embedded) to components/app/build/Signalbox.app.
	$(MAKE) -C components/app
