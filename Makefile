default: help

BIN := components/cli/bin/signalbox

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

.PHONY: clean
clean: # Remove build artifacts and bun's scratch files.
	rm -rf components/cli/bin components/cli/*.bun-build components/cli/.*.bun-build
	$(MAKE) -C components/app clean

.PHONY: app
app: build # Build the menu bar app (with the CLI embedded) to components/app/build/Signalbox.app.
	$(MAKE) -C components/app
