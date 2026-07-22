import SwiftUI

@main
struct SignalboxApp: App {
    // Default hub. The simulator reaches the host Mac's loopback, so it defaults
    // to the laptop's hub for zero-config dev. A real device has no hub yet, so it
    // starts empty and lands on Scan to Connect rather than an offline loopback.
    // SIGNALBOX_URL overrides either (a test hook). Loopback needs no ATS exception;
    // a real device over the LAN rides Partial-Info.plist - see components/specs/ios.html.
    static var defaultHubURL: String {
        if let env = ProcessInfo.processInfo.environment["SIGNALBOX_URL"] { return env }
        #if targetEnvironment(simulator)
        return "http://127.0.0.1:8377"
        #else
        return ""
        #endif
    }
    @AppStorage("hubURL") private var hubURL = SignalboxApp.defaultHubURL
    // The token comes from the Keychain, never AppStorage - it is a credential,
    // not a preference. Nil when unset, which sends no Authorization header.
    @StateObject private var hub = HubClient(config: HubConfig(
        // No nickname yet, so the title derives an honest name from the host
        // rather than claiming the hub is "local" (see HubConfig.displayName).
        name: "",
        // A saved hub, else the platform default. Empty (fresh device) falls back
        // to loopback as a harmless placeholder; the stream only starts when a hub
        // is actually configured, so a fresh device never hammers loopback.
        url: URL(string: UserDefaults.standard.string(forKey: "hubURL")
            ?? SignalboxApp.defaultHubURL) ?? URL(string: "http://127.0.0.1:8377")!,
        token: Keychain.get(Keychain.hubTokenAccount)
    ))
    // Sessions is home - the board. Settings is one tap away. SIGNALBOX_TAB is a
    // test hook (like SIGNALBOX_URL) so e2e can launch straight into a tab.
    @State private var tab = Int(ProcessInfo.processInfo.environment["SIGNALBOX_TAB"] ?? "") ?? 0
    // The pairing alert doubles as the confirmation gate and the error surface,
    // so a link never pairs without a tap and a failure has somewhere to land.
    @State private var pairAlert: PairAlert?
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Test hook: seed a hub token so e2e can screenshot an authed connection.
        // Env-only, so it is inert in a shipped build where nothing sets it.
        if let seed = ProcessInfo.processInfo.environment["SIGNALBOX_SEED_TOKEN"], !seed.isEmpty {
            Keychain.set(seed, account: Keychain.hubTokenAccount)
        }
    }

    var body: some Scene {
        WindowGroup {
            TabView(selection: $tab) {
                SessionsView(hub: hub)
                    .tabItem { Label("Sessions", systemImage: "list.bullet") }.tag(0)
                SettingsView(hub: hub, hubURL: $hubURL)
                    .tabItem { Label("Settings", systemImage: "gearshape") }.tag(1)
            }
            .tint(Theme.blue)
            .preferredColorScheme(.dark)
            // On the TabView root, not inside a tab: a tab's content is built
            // lazily, so a modifier on an unvisited tab may never install. The
            // deep link can arrive before the Settings tab has been drawn.
            .onOpenURL { url in receivePairLink(url) }
            .alert(pairAlertTitle, isPresented: pairAlertPresented, presenting: pairAlert) { alert in
                switch alert {
                case .confirm(let link):
                    // Only this button touches the network. onOpenURL fires for
                    // any signalbox:// link a webpage or message can carry, so
                    // pairing is never silent - it waits for this tap.
                    Button("Pair") { performPair(link) }
                    Button("Cancel", role: .cancel) {}
                case .failed:
                    Button("OK", role: .cancel) {}
                }
            } message: { alert in
                switch alert {
                case .confirm(let link): Text(confirmMessage(for: link))
                case .failed(let error): Text(error.message)
                }
            }
            // Only start the stream when a hub is configured; a fresh device with
            // no hub stays on Scan to Connect instead of retrying loopback.
            .onAppear { if !hubURL.isEmpty { hub.start() } }
            .task {
                // Zero-touch side door for the simulator, which has no camera
                // and cannot tap an alert unattended. DEBUG-only so a shipped
                // build can never be paired by an environment variable, and it
                // is the one path that skips the confirmation on purpose.
                #if DEBUG
                PairLink.runSelfCheck()
                let env = ProcessInfo.processInfo.environment
                if let raw = env["SIGNALBOX_PAIR_URL"],
                   let url = URL(string: raw), let link = PairLink(url) {
                    performPair(link)
                }
                // The simulator cannot tap the SpringBoard "Open in app?" prompt
                // that gates an openurl, so this drives the confirmation path
                // itself - the same code onOpenURL runs, stopping at the alert.
                if let raw = env["SIGNALBOX_PAIR_CONFIRM_URL"], let url = URL(string: raw) {
                    receivePairLink(url)
                }
                #endif
            }
            .onChange(of: scenePhase) { _, phase in
                // iOS suspends the app and the stream dies with it. That is
                // expected: reconnect on foreground with ?since=N and the hub
                // replays the gap. Fighting to stay alive in the background is
                // what push is for.
                if phase == .active { if !hubURL.isEmpty { hub.start() } } else if phase == .background { hub.stop() }
            }
        }
    }

    // Parse first, present second: a link that is not a valid pairing request
    // never reaches the confirmation, it reaches the error.
    private func receivePairLink(_ url: URL) {
        guard let link = PairLink(url) else {
            pairAlert = .failed(.badLink)
            return
        }
        pairAlert = .confirm(link)
    }

    private func performPair(_ link: PairLink) {
        Task { @MainActor in
            do {
                try await hub.pair(url: link.url, code: link.code)
                // The Keychain and HubClient already hold the new token; mirror
                // the url into the persisted setting so Settings shows it and a
                // relaunch keeps it, then land the user on their board, not on
                // the settings they just came from.
                hubURL = link.url.absoluteString
                pairAlert = nil
                tab = 0
            } catch let error as PairError {
                pairAlert = .failed(error)
            } catch {
                pairAlert = .failed(.unreachable(link.url.host ?? "the hub"))
            }
        }
    }

    private var pairAlertPresented: Binding<Bool> {
        Binding(get: { pairAlert != nil }, set: { if !$0 { pairAlert = nil } })
    }

    private var pairAlertTitle: String {
        switch pairAlert {
        case .confirm(let link): return "Pair with the hub at \(link.url.host ?? "the hub")?"
        case .failed: return "Pairing"
        case .none: return ""
        }
    }

    // Name the exact target, and warn when a working pairing is about to be
    // replaced - the whole point of the gate is that the user sees where the
    // token is going before it goes.
    private func confirmMessage(for link: PairLink) -> String {
        var message = "The hub can then read this device's actions on your board."
        let replacesExisting = hub.config.token != nil || hub.config.url != link.url
        if replacesExisting, let currentHost = hub.config.url.host {
            message += " This replaces your current pairing with \(currentHost)."
        }
        return message
    }
}

// The pairing alert is either asking to confirm a link or reporting why one
// failed; one state keeps both in a single alert so they never fight.
private enum PairAlert: Identifiable {
    case confirm(PairLink)
    case failed(PairError)

    var id: String {
        switch self {
        case .confirm(let link): return "confirm:\(link.url.absoluteString)"
        case .failed(let error): return "failed:\(error.message)"
        }
    }
}
