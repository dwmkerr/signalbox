import Foundation
import SwiftUI
import CryptoKit
import Security

// CertPinner verifies a hub's self-signed TLS cert by pinning the SHA-256 of its
// DER encoding - the fingerprint the pairing QR carried (#25). A self-signed cert
// has no CA to chain to, so this pin IS the trust: match it or refuse - the app
// never falls back from a configured pin to unpinned TLS. Without a pin the
// challenge goes to system CA validation, which trusts remote platform TLS but
// still rejects a self-signed LAN MITM. Plain http (loopback dev, or a
// hand-entered hub) raises no such challenge, so the delegate simply never
// fires for it.
//
// The fingerprint is read on URLSession's delegate queue, not the main actor, so
// it is guarded by a lock and updated whenever the active hub changes.
final class CertPinner: NSObject, URLSessionDelegate {
    private let lock = NSLock()
    private var pin: String?

    init(fingerprint: String?) { pin = fingerprint?.lowercased() }

    func setFingerprint(_ fingerprint: String?) {
        lock.lock(); pin = fingerprint?.lowercased(); lock.unlock()
    }

    private var fingerprint: String? {
        lock.lock(); defer { lock.unlock() }; return pin
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let pin = fingerprint, !pin.isEmpty else {
            // System validation is the trust boundary when no explicit pin was
            // supplied, so an untrusted self-signed certificate still fails.
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let der = SecCertificateCopyData(leaf) as Data
        let hex = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
        if hex == pin {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

// What the board is showing, and how much to trust it. A remote hub needs the
// network by contract, so a stale board that looks live is the one genuinely
// dangerous failure on a phone - this is never hidden.
enum Connection: Equatable {
    case connecting
    case live
    case offline(since: Date?)
    case rejected

    var label: String {
        switch self {
        case .connecting: return "Connecting..."
        case .live: return "Live"
        case .offline(let since):
            guard let since else { return "Offline" }
            return "Offline - last seen \(shortAge(since)) ago"
        case .rejected: return "Hub rejected this token"
        }
    }
}

// A hub to watch. A list of these from day one even though the UI shows one:
// the direction of travel is one identity across several hubs, and a singleton
// is cheap now and expensive to unpick later.
struct HubConfig: Equatable {
    // A user-facing nickname for the hub, shown as the title when set. Empty for
    // now - the direction of travel is a multi-hub switcher where you name each
    // one - so the title falls back to a name derived from the host.
    var name: String
    var url: URL
    // Sourced from the Keychain, never UserDefaults: it reads every prompt and
    // reply on the hub and can forge events (see components/specs/ios.html).
    // Nil when the hub has no auth, which sends no Authorization header.
    var token: String?
    // The SHA-256 pin for a self-signed https hub (#25). Nil delegates https to
    // system CA validation and is also used for plain http, which has no TLS.
    var fingerprint: String?

    // The name to show in the nav bar. Calling a hub "local" was a lie on a
    // phone: the hub is always another machine reached over the network, so the
    // honest label is the host you are pointed at. Loopback is the simulator
    // reaching the laptop's own hub, which has no remote host worth naming and
    // reads as the product instead of a bare "127.0.0.1".
    var displayName: String {
        if !name.isEmpty { return name }
        guard let host = url.host, !host.isEmpty else { return "Signalbox" }
        let loopback: Set<String> = ["127.0.0.1", "localhost", "::1", "0.0.0.0"]
        return loopback.contains(host) ? "Signalbox" : host
    }
}

@MainActor
final class HubClient: ObservableObject {
    @Published private(set) var sessions: [Session] = []
    @Published private(set) var connection: Connection = .connecting
    @Published private(set) var lastSeq = 0
    @Published private(set) var hosts: [String] = []
    // The last command sent and what became of it, for the jump feedback line.
    @Published var jumpFeedback: JumpFeedback?
    private var feedbackTask: Task<Void, Never>?

    struct JumpFeedback: Equatable {
        let key: String
        let text: String
        let ok: Bool
    }

    var config: HubConfig
    private var streamTask: Task<Void, Never>?
    private var lastSeen: Date?

    // Enforces a self-signed certificate pin when configured (#25), otherwise
    // preserving system CA validation. Its fingerprint tracks the active hub.
    private let pinner: CertPinner
    private let urlSession: URLSession
    // A short-timeout session for the one-shot /state probe and the pairing
    // redeem. A reachable hub answers these in well under a second, so a tight
    // deadline turns an unreachable hub (a phone on a network that cannot see
    // the hub) into a fast, surfaced failure instead of a 60-90s hang with no
    // feedback. The long-lived stream deliberately does NOT use this - a quiet
    // but live stream must not be killed for being idle.
    private let probeSession: URLSession

    init(config: HubConfig) {
        self.config = config
        self.pinner = CertPinner(fingerprint: config.fingerprint)
        // The stream idles between events; the hub's 15s heartbeat keeps it under
        // this. The macOS app solved this already - 90s is its verified value, and
        // URLSession's 60s default would kill a quiet stream.
        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = 90
        sessionConfig.waitsForConnectivity = false
        self.urlSession = URLSession(configuration: sessionConfig, delegate: pinner, delegateQueue: nil)
        let probeConfig = URLSessionConfiguration.ephemeral
        probeConfig.timeoutIntervalForRequest = 10
        probeConfig.waitsForConnectivity = false
        self.probeSession = URLSession(configuration: probeConfig, delegate: pinner, delegateQueue: nil)
    }

    func start() {
        streamTask?.cancel()
        streamTask = Task { await self.runStreamLoop() }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    /// Forget the hub: stop the stream and drop to a clean disconnected
    /// state. The caller clears the stored url and token; this clears the
    /// board so stale rows never outlive the pairing they came from.
    func disconnect() {
        stop()
        config.url = URL(string: "http://127.0.0.1:8377")!
        config.token = nil
        config.fingerprint = nil
        pinner.setFingerprint(nil)
        Keychain.delete(Keychain.hubFPAccount)
        sessions = []
        hosts = []
        lastSeq = 0
        connection = .offline(since: nil)
    }

    /// Point at a hub and reconnect. Clears the board first so a stale one from
    /// the old hub never looks like the new hub's answer. A changed token counts
    /// as a new hub too: a fresh token is exactly what turns a rejected hub live
    /// again without the url moving, and .rejected otherwise stops retrying.
    ///
    /// fingerprint is the cert pin for a self-signed https hub. Nil preserves
    /// system trust for https and is also used for plain http. It is persisted
    /// here so it always tracks the active url across scans, manual changes and
    /// relaunches.
    func reconfigure(url: URL, token: String?, fingerprint: String?) {
        let token = (token?.isEmpty ?? true) ? nil : token
        let fingerprint = (fingerprint?.isEmpty ?? true) ? nil : fingerprint
        guard url != config.url || token != config.token || fingerprint != config.fingerprint else { return }
        stop()
        config.url = url
        config.token = token
        config.fingerprint = fingerprint
        pinner.setFingerprint(fingerprint)
        Keychain.set(fingerprint ?? "", account: Keychain.hubFPAccount)
        sessions = []
        hosts = []
        lastSeq = 0
        connection = .connecting
        start()
    }

    // MARK: - Pairing

    /// Redeems a pairing code at a hub the phone was just handed by a QR code
    /// or a signalbox:// link, and adopts the hub it returns.
    ///
    /// The request is built here by hand and deliberately does NOT go through
    /// request(): that helper attaches the current bearer token, and this URL
    /// came from outside the app. Shipping the real token to an attacker's URL
    /// is exactly the failure a pairing flow must not have, so the redeem POST
    /// carries no Authorization header at all - only the one-time code.
    func pair(url: URL, code: String, fingerprint: String?) async throws {
        var request = URLRequest(url: url.appendingPathComponent("pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])

        // The live session may still carry the previous hub's pin, so redeem
        // through a throwaway session configured with the new hub's trust mode.
        // Short timeout: a reachable hub redeems instantly, so a phone that
        // cannot see the hub fails fast into the pairing error rather than
        // leaving the "Pairing..." spinner up for a minute.
        let redeemConfig = URLSessionConfiguration.ephemeral
        redeemConfig.timeoutIntervalForRequest = 10
        redeemConfig.waitsForConnectivity = false
        let redeemSession = URLSession(
            configuration: redeemConfig,
            delegate: CertPinner(fingerprint: fingerprint),
            delegateQueue: nil
        )
        defer { redeemSession.finishTasksAndInvalidate() }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await redeemSession.data(for: request)
        } catch {
            // A transport failure here is almost always the phone and the
            // computer being on different networks, so name the host. A pin
            // mismatch also lands here (the TLS handshake is cancelled), which is
            // the same "could not reach it safely" story to a person. A pin
            // mismatch is a LAN case, so the LAN advice is still the right advice.
            throw PairError.unreachable(
                host: url.host ?? "the hub",
                target: .of(url: url, fingerprint: fingerprint)
            )
        }
        guard let http = response as? HTTPURLResponse else { throw PairError.rejected }
        // Any 4xx means the code is bad, expired or already spent - all of
        // which the person fixes by minting a fresh one on the computer.
        guard http.statusCode == 200 else { throw PairError.rejected }

        struct PairResponse: Decodable { let token: String }
        guard let decoded = try? JSONDecoder().decode(PairResponse.self, from: data) else {
            throw PairError.rejected
        }
        let token = decoded.token.isEmpty ? nil : decoded.token
        Keychain.set(decoded.token, account: Keychain.hubTokenAccount)
        reconfigure(url: url, token: token, fingerprint: fingerprint)
    }

    private func request(_ path: String, query: [URLQueryItem] = []) -> URLRequest? {
        guard var components = URLComponents(
            url: config.url.appendingPathComponent(path), resolvingAgainstBaseURL: false
        ) else { return nil }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        if let token = config.token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    // Reconnect with backoff, resyncing /state each time. Backgrounding kills
    // the stream and that is fine: iOS suspends the app, and the loop picks up
    // again on foreground with ?since=N so the hub replays the gap. Fighting
    // for background execution is what push is for.
    private func runStreamLoop() async {
        var backoff: UInt64 = 1
        while !Task.isCancelled {
            do {
                try await resyncState()
                connection = .live
                backoff = 1
                try await readStream()
                // A clean close is still a drop - reconnect.
                connection = .connecting
            } catch is CancellationError {
                return
            } catch {
                if case .rejected = connection {
                    // A bad token will not fix itself by retrying: stop and say so.
                    return
                }
                connection = .offline(since: lastSeen)
            }
            if Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
            backoff = min(backoff * 2, 16)
        }
    }

    func resyncState() async throws {
        guard let request = request("state") else { throw URLError(.badURL) }
        // Probe on the short-timeout session so an unreachable hub fails in ~10s
        // and the offline state (with its message) comes back promptly, instead
        // of the reconnect appearing to do nothing for a minute.
        let (data, response) = try await probeSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 401 || http.statusCode == 403 {
            connection = .rejected
            throw URLError(.userAuthenticationRequired)
        }
        guard http.statusCode == 200 else { throw URLError(.badServerResponse) }
        let doc = try JSONDecoder().decode(StateDoc.self, from: data)
        adopt(doc.sessions)
        lastSeen = Date()
    }

    private func readStream() async throws {
        guard let request = request("stream", query: [URLQueryItem(name: "since", value: String(lastSeq))])
        else { throw URLError(.badURL) }
        let (bytes, response) = try await urlSession.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        // The frame label decides what the next data line means. Commands are
        // not ours to act on - a phone cannot jump - but they are read so the
        // debug surface can show the round trip.
        var frame = "signal"
        for try await line in bytes.lines {
            if Task.isCancelled { throw CancellationError() }
            lastSeen = Date()
            if line.hasPrefix("event:") {
                frame = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                continue
            }
            guard line.hasPrefix("data:") else { continue }
            let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            guard let data = payload.data(using: .utf8) else { continue }
            if frame == "signal", let event = try? JSONDecoder().decode(SessionEvent.self, from: data) {
                // Resync rather than reduce: the hub owns order, acked and
                // hidden, and a second reducer here is how two surfaces start
                // disagreeing. Events are small and rare enough that a refetch
                // is honest and cheap.
                if let seq = event.seq { lastSeq = max(lastSeq, seq) }
                try? await resyncState()
            }
            frame = "signal"
        }
    }

    private func adopt(_ events: [SessionEvent]) {
        // /state arrives in display order (engagement MRU) and is adopted
        // verbatim. Never re-sort: the ordering rules live in the reducer.
        var rows: [Session] = []
        var seenHosts: [String] = []
        for event in events {
            // Hidden rows are kept, not dropped: the view renders the main list
            // from the non-hidden rows and collapses these into the Hidden
            // section, and search must still see through to them.
            let host = event.host ?? "localhost"
            // A hidden row is off the board, so it does not count toward the
            // machine set: the host chip only earns its place by distinguishing
            // visible rows, and the connection line's machine count is the
            // visible board's, not a fleet that includes silenced machines.
            if event.hidden != true, !seenHosts.contains(host) { seenHosts.append(host) }
            rows.append(Session(
                key: event.sessionKey,
                agent: event.agent,
                event: event.event,
                host: host,
                name: displayName(event),
                prompt: event.prompt,
                reply: event.reply,
                tags: event.tags ?? [],
                date: EventDate.parse(event.ts) ?? Date(),
                acked: event.acked ?? false,
                hidden: event.hidden ?? false,
                pinned: event.pinned ?? false,
                // A url origin (a CI run) has no machine to jump on. Rows with
                // no origin at all cannot be jumped to either.
                jumpable: event.origin?.tmux != nil || event.origin?.cursor != nil
            ))
            if let seq = event.seq { lastSeq = max(lastSeq, seq) }
        }
        sessions = rows
        hosts = seenHosts
    }

    // label beats title beats the cwd folder name.
    private func displayName(_ event: SessionEvent) -> String {
        if let label = event.label, !label.isEmpty { return label }
        if let title = event.title, !title.isEmpty { return title }
        if let cwd = event.cwd, !cwd.isEmpty {
            return URL(fileURLWithPath: cwd).lastPathComponent
        }
        return event.sessionKey
    }

    // MARK: - Actions

    /// Clears the flag everywhere. Not queued: if it cannot be delivered, say
    /// so and let the user retry - a second source of truth is how surfaces
    /// start disagreeing.
    func ack(_ session: Session) async {
        await postEvent(["v": 1, "id": UUID().uuidString, "ts": nowTS(),
                         "host": deviceHost(), "agent": agentOf(session.key),
                         "event": "seen", "session_key": session.key])
    }

    func hide(_ session: Session) async {
        await postEvent(["v": 1, "id": UUID().uuidString, "ts": nowTS(),
                         "host": deviceHost(), "agent": agentOf(session.key),
                         "event": "hide", "session_key": session.key])
    }

    /// Clears `hidden` and returns the row to the main list, without waiting for
    /// the agent to speak again. The wire calls this `show`.
    func unhide(_ session: Session) async {
        await postEvent(["v": 1, "id": UUID().uuidString, "ts": nowTS(),
                         "host": deviceHost(), "agent": agentOf(session.key),
                         "event": "show", "session_key": session.key])
    }

    /// Pins the row to the top of the board. Like `seen` and `hide`, this is a
    /// user event: the hub owns the partition and every surface adopts it, so the
    /// app never re-sorts.
    func pin(_ session: Session) async {
        await postEvent(["v": 1, "id": UUID().uuidString, "ts": nowTS(),
                         "host": deviceHost(), "agent": agentOf(session.key),
                         "event": "pin", "session_key": session.key])
    }

    func unpin(_ session: Session) async {
        await postEvent(["v": 1, "id": UUID().uuidString, "ts": nowTS(),
                         "host": deviceHost(), "agent": agentOf(session.key),
                         "event": "unpin", "session_key": session.key])
    }

    /// Asks the machine that owns the session to jump to it. The phone cannot
    /// jump - it has no tmux and no windows - so this is a request, and the
    /// answer comes back as the row going quiet when that machine acks.
    func jump(_ session: Session) async {
        let body: [String: Any] = [
            "v": 1, "id": UUID().uuidString, "ts": nowTS(),
            "command": "jump", "session_key": session.key,
            "target_host": session.host, "host": deviceHost(),
        ]
        guard var request = request("command") else { return }
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                say(session.key, "Hub refused the jump", ok: false)
                return
            }
            // delivered counts listeners reached, never work done. Zero is the
            // useful case: it means no machine is listening, which we can say
            // at once instead of leaving the user waiting for nothing.
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let delivered = (json?["delivered"] as? Int) ?? 0
            if delivered == 0 {
                say(session.key, "Nothing is listening on the hub", ok: false)
            } else {
                say(session.key, "Asked \(session.host) to jump", ok: true)
            }
        } catch {
            say(session.key, "Could not reach the hub", ok: false)
        }
    }

    /// Shows a line and takes it away again. The row going quiet is the real
    /// confirmation; this only covers the gap before it, or the silence when
    /// no machine answers.
    private func say(_ key: String, _ text: String, ok: Bool) {
        jumpFeedback = .init(key: key, text: text, ok: ok)
        feedbackTask?.cancel()
        feedbackTask = Task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard !Task.isCancelled else { return }
            jumpFeedback = nil
        }
    }

    private func postEvent(_ body: [String: Any]) async {
        guard var request = request("events") else { return }
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await urlSession.data(for: request)
        try? await resyncState()
    }

    private func agentOf(_ key: String) -> String {
        guard let idx = key.firstIndex(of: ":") else { return "user" }
        return String(key[key.startIndex..<idx])
    }

    private func deviceHost() -> String { "iphone" }

    private func nowTS() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: Date())
    }
}
