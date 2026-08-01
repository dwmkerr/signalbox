import AppKit
import CoreImage

// The "Connect Phone" window has two paths, and both end in the same QR. A
// state-owning hub mints a one-time pairing code on loopback. A forwarder
// cannot mint - the phone's board lives upstream - so this window mints against
// the upstream hub itself, with the token this machine already holds, and polls
// the upstream for redemption. Only when that cannot be done (no upstream
// address, no token, a rejected token, an unreachable hub) does it fall back to
// handing over the `signalbox pair --url` command with the reason why.
//
// This window never changes the hub's mode: Settings owns that (a mode change
// is a confirmed, restart-bearing decision), so a local-only hub gets a pointer
// to the Hub tab rather than an "Allow other devices" toggle here.
//
// The QR carries only the one-time code and the URL the phone dials (the LAN
// address, or the upstream origin), never the hub token - the phone learns the
// token by redeeming the code against that hub over the network, so a photo of
// the QR after use or after it expires is worthless.
@MainActor
final class ConnectPhoneController: NSObject, NSWindowDelegate {
    private let hubURL: URL
    private let openSettingsHubTab: @MainActor () -> Void

    private var window: NSWindow?
    private var remotePairCommand: String?
    // The single in-flight pairing flow (mint + poll). Cancelled when the window
    // closes or a new flow starts, so a closed window never keeps polling the hub.
    private var flowTask: Task<Void, Never>?

    // Loopback pairing calls are quick; a short timeout keeps a wedged hub from
    // hanging the flow.
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    // Upstream pairing crosses the WAN to a hub that may be cold-starting, so it
    // gets a longer leash than the loopback session.
    private let upstreamSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    init(hubURL: URL, openSettingsHubTab: @escaping @MainActor () -> Void) {
        self.hubURL = hubURL
        self.openSettingsHubTab = openSettingsHubTab
        super.init()
    }

    // MARK: - Window

    func show() {
        if window == nil { buildWindow() }
        // Accessory apps run in the background; a real window needs the app
        // frontmost to take key and clicks (orderFrontRegardless because
        // activate alone can leave it behind the previous app on modern macOS).
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()
        startFlow()
    }

    private func buildWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 460),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Connect Phone"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.contentView = NSView()
        self.window = window
    }

    func windowWillClose(_ notification: Notification) {
        // Stop polling the hub the moment the user dismisses the window.
        flowTask?.cancel()
        flowTask = nil
    }

    // MARK: - Flow

    private func startFlow() {
        flowTask?.cancel()
        flowTask = Task { await self.runFlow() }
    }

    private func runFlow() async {
        render(.loading("Preparing pairing code…"))
        let health = await HubHealthProbe.fetch(hubURL: hubURL)
        if health?.mode == "forwarder" {
            await runRemoteFlow(reportedUpstream: health?.upstream?.url)
            return
        }
        switch await mintCode() {
        case .ok(let response):
            await showQRAndPoll(response)
        case .forwarder:
            // The probe missed (its 2s timeout is shorter than the mint's 5s),
            // but the hub's own 409 body has just told us it is a forwarder.
            // Toggling the bind here is exactly the bug this window used to
            // have, so route to the same flow the probe branch runs.
            await runRemoteFlow(reportedUpstream: nil)
        case .localOnly:
            render(.localOnly)
        case .error(let message):
            render(.error(message))
        }
    }

    private func showQRAndPoll(_ response: PairNewResponse) async {
        // The QR needs the address the phone dials, which the hub reports in
        // `bind` when it bound a concrete IP; a wildcard bind (0.0.0.0) tells us
        // nothing, so resolve this Mac's own LAN IPv4 instead.
        guard let ip = concreteIP(response.bind) ?? LANAddress.primary() else {
            render(.error(
                "Could not find this Mac's Wi-Fi address. "
                    + "Connect to Wi-Fi (not just Ethernet or a VPN) and try again."
            ))
            return
        }
        // A fingerprint means the LAN listener is TLS: the phone dials https on
        // the port the hub advertised and pins that cert. Without one the hub is
        // plain http on the loopback port, as before (openssl-less fallback).
        let scheme = response.fp != nil ? "https" : "http"
        let port = response.fp != nil ? (response.port ?? ((hubURL.port ?? 8377) + 1)) : (hubURL.port ?? 8377)
        let lanURL = "\(scheme)://\(ip):\(port)"
        let deepLink = Self.pairDeepLink(url: lanURL, code: response.code, fingerprint: response.fp)
        guard let qr = Self.qrImage(from: deepLink, points: 240) else {
            render(.error("Could not render the pairing code."))
            return
        }
        render(.qr(qr, lanURL))
        await pollStatus(expiresIn: response.expiresIn ?? 180, base: hubURL, token: nil, session: session)
    }

    // Poll /pair/status every 2s on whichever hub minted the code - this Mac's
    // loopback hub, or the upstream with the bearer. Redeemed swaps to the
    // paired state and auto-closes; a code that expires (status back to none, or
    // its lifetime elapsed) offers a fresh one. Transient fetch errors are
    // ignored so a hub blip does not read as expiry.
    private func pollStatus(expiresIn: Int, base: URL, token: String?, session: URLSession) async {
        let deadline = Date().addingTimeInterval(TimeInterval(expiresIn))
        var sawPending = false
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { return }
            switch await fetchStatus(base: base, token: token, session: session) {
            case "redeemed":
                render(.paired)
                await autoClose()
                return
            case "pending":
                sawPending = true
            case "none":
                // Tolerate an early "none" before the code registers; only a
                // "none" after we have seen it pending, or past its lifetime,
                // means expired.
                if sawPending || Date() >= deadline {
                    render(.expired)
                    return
                }
            default:
                break
            }
            if Date() >= deadline {
                render(.expired)
                return
            }
        }
    }

    private func autoClose() async {
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        if Task.isCancelled { return }
        window?.close()
    }

    // MARK: - Hub calls

    private enum MintResult {
        case ok(PairNewResponse)
        case localOnly
        case forwarder
        case error(String)
    }

    private enum RemoteMintResult {
        case ok(PairNewResponse)
        // One line, lower-case, completing "could not mint a pairing code: ...".
        case failed(String)
    }

    // Both the probe branch and the late-409 branch land here: the phone must
    // pair against the upstream hub, never this Mac. The upstream address comes
    // from the probe when it answered, else from the settings intent; the bearer
    // only ever from settings, because /healthz never carries it.
    private func runRemoteFlow(reportedUpstream: String?) async {
        guard let origin = Self.upstreamOrigin(reported: reportedUpstream) else {
            render(.remoteHub(host: "", command: nil, reason: nil))
            return
        }
        let host = URL(string: origin)?.host ?? origin
        let command = "signalbox pair --url \(origin)"
        let token = SharedSettings.hubToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, let base = URL(string: origin) else {
            render(.remoteHub(
                host: host, command: command, reason: "no hub token is stored on this machine"
            ))
            return
        }
        switch await mintUpstream(base: base, token: token) {
        case .ok(let response):
            await showRemoteQRAndPoll(response, origin: origin, base: base, token: token)
        case .failed(let reason):
            render(.remoteHub(host: host, command: command, reason: reason))
        }
    }

    // A remote hub sits behind platform TLS, so its mint carries no fp or port:
    // the QR names the upstream origin exactly as the CLI's `pair --url` does,
    // and the phone validates the CA-issued certificate with system trust.
    private func showRemoteQRAndPoll(
        _ response: PairNewResponse, origin: String, base: URL, token: String
    ) async {
        let deepLink = Self.pairDeepLink(url: origin, code: response.code, fingerprint: nil)
        guard let qr = Self.qrImage(from: deepLink, points: 240) else {
            render(.error("Could not render the pairing code."))
            return
        }
        render(.qr(qr, origin))
        await pollStatus(
            expiresIn: response.expiresIn ?? 180, base: base, token: token, session: upstreamSession
        )
    }

    private func mintUpstream(base: URL, token: String) async -> RemoteMintResult {
        var request = URLRequest(url: base.appendingPathComponent("pair/new"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{}".utf8)
        do {
            let (data, response) = try await upstreamSession.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .failed("the remote hub gave no response")
            }
            switch http.statusCode {
            case 200:
                guard let decoded = try? JSONDecoder().decode(PairNewResponse.self, from: data) else {
                    return .failed("the remote hub sent a pairing response we could not read")
                }
                return .ok(decoded)
            case 401:
                return .failed("the remote hub rejected this machine's token")
            default:
                return .failed("the remote hub returned an unexpected status (\(http.statusCode))")
            }
        } catch {
            return .failed("the remote hub could not be reached")
        }
    }

    // The origin alone, never a path or query: it is both what the phone dials
    // and what `pair --url` accepts.
    private static func upstreamOrigin(reported: String?) -> String? {
        let candidates = [reported ?? "", SharedSettings.hubUpstream]
        for candidate in candidates {
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty,
                  let url = URL(string: trimmed),
                  let scheme = url.scheme,
                  let host = url.host
            else { continue }
            let port = url.port.map { ":\($0)" } ?? ""
            return "\(scheme)://\(host)\(port)"
        }
        return nil
    }

    private func mintCode() async -> MintResult {
        var request = URLRequest(url: hubURL.appendingPathComponent("pair/new"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .error("The hub gave no response.")
            }
            switch http.statusCode {
            case 200:
                guard let decoded = try? JSONDecoder().decode(PairNewResponse.self, from: data) else {
                    return .error("The hub sent a pairing response we could not read.")
                }
                return .ok(decoded)
            case 409:
                // Two hubs 409 here: a forwarder (refuses to mint by design, and
                // says so in the body) and a loopback-only hub. runFlow's probe
                // usually catches the forwarder first, but its timeout is shorter
                // than this request's, so the body is the reliable tell.
                if String(data: data, encoding: .utf8)?.contains("forwarder") == true {
                    return .forwarder
                }
                return .localOnly
            default:
                return .error("The hub returned an unexpected status (\(http.statusCode)).")
            }
        } catch {
            return .error("Could not reach the hub on this Mac.")
        }
    }

    private func fetchStatus(base: URL, token: String?, session: URLSession) async -> String? {
        var request = URLRequest(url: base.appendingPathComponent("pair/status"))
        request.httpMethod = "GET"
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let decoded = try? JSONDecoder().decode(PairStatusResponse.self, from: data)
        else { return nil }
        return decoded.status
    }

    // MARK: - Deep link, QR, LAN IP

    // signalbox://pair?url=<percent-encoded url>&code=<code>[&fp=<hex>] per the
    // iOS spec: `pair` rides in the host (a custom scheme has no authority of its
    // own), the url is the hub to redeem against, the code is single-use, and fp
    // (present for an https hub) is the cert pin the phone verifies (#25).
    private static func pairDeepLink(url: String, code: String, fingerprint: String?) -> String {
        var unreserved = CharacterSet.alphanumerics
        unreserved.insert(charactersIn: "-._~")
        let encodedURL = url.addingPercentEncoding(withAllowedCharacters: unreserved) ?? url
        let encodedCode = code.addingPercentEncoding(withAllowedCharacters: unreserved) ?? code
        var link = "signalbox://pair?url=\(encodedURL)&code=\(encodedCode)"
        if let fp = fingerprint, !fp.isEmpty { link += "&fp=\(fp)" }
        return link
    }

    // Render the deep link as a QR. CIQRCodeGenerator emits one pixel per
    // module, so upscale with nearest-neighbor (interpolation .none) onto a
    // white field: hard-edged squares stay crisp and scannable, and the white
    // background reads right whatever the window appearance. Drawn at 3x the
    // point size so it is sharp on Retina too.
    private static func qrImage(from string: String, points: CGFloat) -> NSImage? {
        guard let data = string.data(using: .utf8),
              let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage,
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        let pixels = Int(points * 3)
        guard let ctx = CGContext(
            data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .none
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: pixels, height: pixels))
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: pixels, height: pixels))
        guard let scaled = ctx.makeImage() else { return nil }
        return NSImage(cgImage: scaled, size: NSSize(width: points, height: points))
    }

    // A concrete IPv4 the phone can dial, or nil for a wildcard/loopback/named
    // bind that tells us nothing (0.0.0.0, "lan", localhost).
    private func concreteIP(_ bind: String?) -> String? {
        guard let bind, !bind.isEmpty else { return nil }
        let lowered = bind.lowercased()
        if ["0.0.0.0", "::", "lan", "localhost", "127.0.0.1"].contains(lowered) { return nil }
        let parts = bind.split(separator: ".")
        guard parts.count == 4, parts.allSatisfy({ Int($0) != nil }) else { return nil }
        return bind
    }

    // MARK: - Rendering

    private enum State {
        case loading(String)
        case qr(NSImage, String)
        case remoteHub(host: String, command: String?, reason: String?)
        case localOnly
        case paired
        case expired
        case error(String)
    }

    private func render(_ state: State) {
        guard let container = window?.contentView else { return }
        if case .remoteHub(_, let command, _) = state {
            remotePairCommand = command
        } else {
            remotePairCommand = nil
        }
        container.subviews.forEach { $0.removeFromSuperview() }
        let stack = buildStack(for: state)
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -28),
        ])
    }

    private func buildStack(for state: State) -> NSStackView {
        let views: [NSView]
        switch state {
        case .loading(let message):
            views = [spinner(), title(message)]
        case .qr(let image, let lanURL):
            views = [
                title("Scan with your iPhone camera"),
                qrCard(image),
                body("Open the Camera app and point it at the code, then tap the Signalbox banner.", secondary: true),
                monospace(lanURL),
                body("The code refreshes every 3 minutes.", secondary: true, size: 11),
            ]
        case .remoteHub(let host, let command, let reason):
            if let command {
                views = [
                    title("Pair with the remote hub"),
                    body(
                        "This Mac forwards to \(host), but this window could not mint a pairing "
                            + "code: \(reason ?? "the remote hub did not mint one"). Run this on a "
                            + "machine that has the hub token:"
                    ),
                    monospace(command),
                    primaryButton("Copy command", action: #selector(copyRemotePairCommand)),
                ]
            } else {
                views = [
                    title("Pair with the remote hub"),
                    body(
                        "This Mac forwards to a remote hub, but its address is not in "
                            + "~/.config/signalbox/settings.json."
                    ),
                ]
            }
        case .localOnly:
            views = [
                title("Phones cannot connect yet"),
                body("The hub is local-only, so phones cannot connect. Open Settings and choose LAN or Remote."),
                primaryButton("Open Settings", action: #selector(openSettingsForHub)),
            ]
        case .paired:
            views = [checkmark(), title("Phone paired")]
        case .expired:
            views = [
                title("Code expired"),
                body("Pairing codes last 3 minutes. Get a fresh one to try again.", secondary: true),
                primaryButton("New code", action: #selector(newCode)),
            ]
        case .error(let message):
            views = [
                title("Something went wrong"),
                body(message, secondary: true),
                primaryButton("Try again", action: #selector(newCode)),
            ]
        }
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        return stack
    }

    @objc private func newCode() {
        startFlow()
    }

    // Settings owns the mode, so this window hands the user over rather than
    // writing hub.bind itself. Closing first keeps the stale "cannot connect"
    // screen from sitting behind the window that fixes it.
    @objc private func openSettingsForHub() {
        window?.close()
        openSettingsHubTab()
    }

    @objc private func copyRemotePairCommand() {
        guard let remotePairCommand else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(remotePairCommand, forType: .string)
    }

    // MARK: - View builders

    private func title(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.alignment = .center
        return label
    }

    private func body(_ text: String, secondary: Bool = false, size: CGFloat = 12.5) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: size)
        label.alignment = .center
        label.textColor = secondary ? .secondaryLabelColor : .labelColor
        label.isSelectable = false
        label.widthAnchor.constraint(equalToConstant: 300).isActive = true
        return label
    }

    private func monospace(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        label.textColor = .secondaryLabelColor
        label.alignment = .center
        label.isSelectable = true
        return label
    }

    private func spinner() -> NSView {
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.startAnimation(nil)
        return spinner
    }

    // A green disc with a white tick, drawn rather than an SF Symbol so the
    // tick stays white on green in both light and dark appearance (a filled
    // symbol's cut-out would show the window background through it).
    private func checkmark() -> NSView {
        let size: CGFloat = 64
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            NSColor.systemGreen.setFill()
            NSBezierPath(ovalIn: rect).fill()
            let tick = NSBezierPath()
            tick.lineWidth = 5
            tick.lineCapStyle = .round
            tick.lineJoinStyle = .round
            tick.move(to: NSPoint(x: size * 0.30, y: size * 0.50))
            tick.line(to: NSPoint(x: size * 0.44, y: size * 0.35))
            tick.line(to: NSPoint(x: size * 0.72, y: size * 0.64))
            NSColor.white.setStroke()
            tick.stroke()
            return true
        }
        return NSImageView(image: image)
    }

    private func primaryButton(_ title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .large
        // The default (blue) button and Return trigger, matching a WhatsApp-Web
        // style single primary action per screen.
        button.keyEquivalent = "\r"
        return button
    }

    // A white card with padding around the QR: the padding is the quiet zone a
    // scanner needs, and the fixed white field keeps contrast whatever the
    // window's light/dark appearance.
    private func qrCard(_ image: NSImage) -> NSView {
        let card = NSView()
        card.wantsLayer = true
        card.layer?.backgroundColor = NSColor.white.cgColor
        card.layer?.cornerRadius = 12
        card.translatesAutoresizingMaskIntoConstraints = false

        let imageView = NSImageView(image: image)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(imageView)

        NSLayoutConstraint.activate([
            imageView.widthAnchor.constraint(equalToConstant: 240),
            imageView.heightAnchor.constraint(equalToConstant: 240),
            imageView.topAnchor.constraint(equalTo: card.topAnchor, constant: 16),
            imageView.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -16),
            imageView.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            imageView.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
        ])
        return card
    }
}

// The loopback hub's reply to POST /pair/new. Lenient like SessionEvent: only
// `code` is required; `expires_in` and `bind` fall back if a field is absent.
struct PairNewResponse: Decodable {
    let code: String
    let expiresIn: Int?
    let bind: String?
    // Present when the hub's LAN listener is TLS (#25): the cert pin and the port
    // that listener is on. Their presence flips the QR to an https url on `port`.
    let fp: String?
    let port: Int?

    enum CodingKeys: String, CodingKey {
        case code
        case expiresIn = "expires_in"
        case bind
        case fp
        case port
    }
}

struct PairStatusResponse: Decodable {
    let status: String
}
