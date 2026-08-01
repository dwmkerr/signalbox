import Foundation

// The hub's own account of what it is. Every hub status surface in this app
// renders from this: settings.json records what the user ASKED for,
// /healthz reports what is actually RUNNING, and the two disagree whenever
// the hub is a forwarder. Reading intent as reality is exactly the bug this
// type exists to end.
struct HubHealth: Decodable, Equatable, Sendable {
    let ok: Bool
    let version: String?
    let build: String?
    // "local" | "lan" | "remote" | "forwarder". Optional so an older hub
    // that predates the field decodes rather than failing.
    let mode: String?
    let bind: String?
    let port: Int?
    let upstream: Upstream?

    struct Upstream: Decodable, Equatable, Sendable {
        let url: String
        let connected: Bool
        let lastSeq: Int
        let spooled: Int
    }
}

enum HubHealthProbe {
    static func fetch(hubURL: URL) async -> HubHealth? {
        let configuration = URLSessionConfiguration.ephemeral
        // A slow answer is indistinguishable from no answer to a person looking
        // at a window, and this probe runs repeatedly while a surface is open.
        configuration.timeoutIntervalForRequest = 2
        configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }

        var request = HubAuth.request(hubURL.appendingPathComponent("healthz"))
        request.httpMethod = "GET"
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return nil
            }
            return try JSONDecoder().decode(HubHealth.self, from: data)
        } catch {
            // Nil means the hub did not answer - it may be down, restarting or
            // wedged. The monitor decides whether that is starting or a warning.
            return nil
        }
    }
}

@MainActor
final class HubHealthMonitor {
    private let hubURL: URL
    private var callbacks: [String: @MainActor () -> Void] = [:]
    private var pollTask: Task<Void, Never>?
    private var startingUntil: Date

    // The last answer; nil when the last probe went unanswered.
    private(set) var health: HubHealth?
    // The last answer that actually arrived, kept after the hub goes away so a
    // restarting hub does not blank the mode out of every surface.
    private(set) var lastGood: HubHealth?
    // Only the app knows whether an unanswered hub is expected to be coming up
    // or has been absent long enough to call broken.
    var isStarting: Bool { Date() < startingUntil }

    init(hubURL: URL) {
        self.hubURL = hubURL
        self.startingUntil = Date().addingTimeInterval(20)
    }

    // A deliberate restart gets the same grace as app launch so the user's own
    // action does not immediately produce a warning.
    func noteRestart() {
        startingUntil = Date().addingTimeInterval(20)
    }

    // Keys make polling reference-counted: a surface can replace its callback
    // without accidentally creating a second repeating probe.
    func begin(_ key: String, onUpdate: @escaping @MainActor () -> Void) {
        callbacks[key] = onUpdate
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshNow()
                do {
                    try await Task.sleep(for: .seconds(3))
                } catch {
                    return
                }
            }
        }
    }

    func end(_ key: String) {
        callbacks.removeValue(forKey: key)
        guard callbacks.isEmpty else { return }
        pollTask?.cancel()
        pollTask = nil
    }

    func refreshNow() async {
        let result = await HubHealthProbe.fetch(hubURL: hubURL)
        health = result
        if let result { lastGood = result }
        // Every result redraws every active surface. Suppressing an unchanged
        // value only creates ways for a cheap status view to become stale.
        for callback in Array(callbacks.values) {
            callback()
        }
    }
}

// The three states the whole app speaks: what a person needs to know is
// whether the hub is fine, broken, or not up yet - never which mode it is,
// because "Remote" as a status reads as a place, not a health.
enum HubCondition {
    case healthy
    case warning
    case starting
}

// The mode as the UI names it, which is not always the mode /healthz names:
// a forwarder is what the user chose when they chose "Remote".
enum HubDisplayMode: String {
    case local = "Local"
    case lan = "LAN"
    case remote = "Remote"
    case other = "Hub"
}

struct HubStatus {
    let mode: HubDisplayMode
    let address: String
    let condition: HubCondition
    // "", " - not responding", " - uplink down" or " - starting".
    let suffix: String
    // "Local - 127.0.0.1:8377 - starting" etc: mode, address, suffix.
    let pillText: String
    // "Hub healthy" / "Hub warning" / "Hub starting".
    let lightText: String
    let versionRow: String
    let addressRow: String
    let uplinkRow: String?

    init(
        health: HubHealth?,
        lastGood: HubHealth?,
        intentMode: HubDisplayMode,
        isStarting: Bool,
        lanIP: String?
    ) {
        // Intent is a last resort for naming a hub that is not there, never a
        // description of one that is answering. The last answer wins between
        // those cases so a restart does not blank the running mode.
        mode = Self.displayMode(for: health)
            ?? Self.displayMode(for: lastGood)
            ?? intentMode

        let source = health ?? lastGood
        let reportedPort = source?.port
        let displayPort: Int
        if mode == .lan, let reportedPort {
            // /healthz answers on the loopback HTTP listener and does not expose
            // the TLS port. The normal app-managed LAN path uses the next port,
            // which is the address a phone receives during pairing.
            displayPort = reportedPort + 1
        } else {
            displayPort = reportedPort ?? 8377
        }

        switch mode {
        case .local:
            address = "127.0.0.1:\(displayPort)"
        case .lan:
            let ip = source?.bind.flatMap(Self.concreteIPv4)
                ?? lanIP.flatMap(Self.concreteIPv4)
            if let ip {
                address = "\(ip):\(displayPort)"
            } else {
                address = "port \(displayPort), no Wi-Fi address yet"
            }
        case .remote:
            let upstream = source?.upstream?.url ?? ""
            address = URL(string: upstream)?.host ?? upstream
        case .other:
            address = "\(source?.bind ?? ""):\(displayPort)"
        }

        if health == nil {
            condition = isStarting ? .starting : .warning
        } else if mode == .remote, health?.upstream?.connected == false {
            condition = .warning
        } else {
            condition = .healthy
        }

        switch condition {
        case .healthy:
            suffix = ""
            lightText = "Hub healthy"
        case .warning:
            suffix = mode == .remote ? " - uplink down" : " - not responding"
            lightText = "Hub warning"
        case .starting:
            suffix = " - starting"
            lightText = "Hub starting"
        }
        pillText = "\(mode.rawValue) - \(address)\(suffix)"

        if let answered = health ?? lastGood, let version = answered.version {
            if let build = answered.build, !build.isEmpty {
                versionRow = "\(version) (\(build))"
            } else {
                versionRow = version
            }
        } else {
            versionRow = "unknown"
        }
        addressRow = health == nil ? "not answering" : address

        if mode != .remote {
            uplinkRow = nil
        } else if case .starting = condition {
            uplinkRow = "starting"
        } else {
            let currentUpstream = health?.upstream
            if currentUpstream?.connected == true {
                uplinkRow = "connected"
            } else {
                let spooled = currentUpstream?.spooled ?? lastGood?.upstream?.spooled ?? 0
                uplinkRow = "down, \(spooled) events spooled"
            }
        }
    }

    private static func displayMode(for health: HubHealth?) -> HubDisplayMode? {
        guard let health else { return nil }
        switch health.mode {
        case "local": return .local
        case "lan": return .lan
        case "forwarder": return .remote
        default: return .other
        }
    }

    private static func concreteIPv4(_ address: String) -> String? {
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4,
              parts.allSatisfy({ part in
                  guard let octet = Int(part) else { return false }
                  return (0...255).contains(octet)
              }),
              address != "0.0.0.0",
              parts[0] != "127"
        else { return nil }
        return address
    }

    #if DEBUG
    static func runSelfCheck() {
        func health(
            mode: String,
            bind: String? = nil,
            port: Int? = 8377,
            build: String? = nil,
            connected: Bool? = nil,
            spooled: Int = 0
        ) -> HubHealth {
            HubHealth(
                ok: true,
                version: "0.9.2",
                build: build,
                mode: mode,
                bind: bind,
                port: port,
                upstream: connected.map {
                    HubHealth.Upstream(
                        url: "https://signalbox-hub.fly.dev",
                        connected: $0,
                        lastSeq: 42,
                        spooled: spooled
                    )
                }
            )
        }

        func status(
            _ current: HubHealth?,
            lastGood: HubHealth? = nil,
            intent: HubDisplayMode = .local,
            starting: Bool = false,
            lanIP: String? = nil
        ) -> HubStatus {
            HubStatus(
                health: current,
                lastGood: lastGood,
                intentMode: intent,
                isStarting: starting,
                lanIP: lanIP
            )
        }

        let local = health(mode: "local", bind: "127.0.0.1")
        // A loopback listener on 8376 has the 8377 phone-facing TLS address used
        // by the exact illustrative strings in the living spec. The default
        // 8377 loopback listener correspondingly renders LAN port 8378.
        let lan = health(mode: "lan", bind: "192.168.1.24", port: 8376)
        let remote = health(mode: "forwarder", connected: true)

        let healthyLocal = status(local)
        let healthyLAN = status(lan)
        let healthyRemote = status(remote)
        assert(healthyLocal.pillText == "Local - 127.0.0.1:8377")
        assert(healthyLAN.pillText == "LAN - 192.168.1.24:8377")
        assert(healthyRemote.pillText == "Remote - signalbox-hub.fly.dev")

        let offlineLocal = status(nil, lastGood: local)
        let offlineLAN = status(nil, lastGood: lan)
        let downRemote = status(health(mode: "forwarder", connected: false, spooled: 12))
        assert(offlineLocal.pillText == "Local - 127.0.0.1:8377 - not responding")
        assert(offlineLAN.pillText == "LAN - 192.168.1.24:8377 - not responding")
        assert(downRemote.pillText == "Remote - signalbox-hub.fly.dev - uplink down")

        let startingLocal = status(nil, starting: true)
        assert(startingLocal.pillText == "Local - 127.0.0.1:8377 - starting")
        let noLANAddress = status(
            health(mode: "lan", bind: "0.0.0.0", port: nil),
            intent: .lan
        )
        assert(noLANAddress.pillText == "LAN - port 8377, no Wi-Fi address yet")

        assert(healthyLocal.lightText == "Hub healthy")
        assert(offlineLocal.lightText == "Hub warning")
        assert(startingLocal.lightText == "Hub starting")
        assert(offlineLocal.addressRow == "not answering")
        assert(healthyRemote.uplinkRow == "connected")
        assert(downRemote.uplinkRow == "down, 12 events spooled")
        assert(status(nil, lastGood: remote, intent: .remote, starting: true).uplinkRow == "starting")
        assert(status(nil, lastGood: remote, intent: .remote).uplinkRow == "down, 0 events spooled")

        assert(healthyLocal.versionRow == "0.9.2")
        assert(status(health(mode: "local", build: "abc1234")).versionRow == "0.9.2 (abc1234)")
        assert(status(nil).versionRow == "unknown")
    }
    #endif
}
