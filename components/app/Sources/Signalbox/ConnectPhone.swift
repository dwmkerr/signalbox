import AppKit
import CoreImage

// The "Connect Phone" window: a WhatsApp-Web style QR pairing flow. It mints a
// one-time pairing code from the loopback hub, renders the pairing deep link as
// a QR the phone scans, and polls until the phone redeems the code. When the
// hub only answers this Mac (its default), pairing needs other devices allowed,
// so the window offers to do that: it writes hub.bind = "0.0.0.0" to the shared
// settings, restarts the hub, and re-mints once the reachable hub is up.
//
// The QR carries only the one-time code and the LAN URL, never the hub token -
// the phone learns the token by redeeming the code against the hub over the
// network, so a photo of the QR after use or after it expires is worthless.
@MainActor
final class ConnectPhoneController: NSObject, NSWindowDelegate {
    private let hubURL: URL
    private let restartHub: @MainActor () async -> Void

    private var window: NSWindow?
    // The single in-flight pairing flow (mint + poll, or enable-access + re-mint).
    // Cancelled when the window closes or a new flow starts, so a closed window
    // never keeps polling the hub.
    private var flowTask: Task<Void, Never>?

    // Loopback pairing calls are quick; a short timeout keeps a wedged hub from
    // hanging the flow.
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    init(hubURL: URL, restartHub: @escaping @MainActor () async -> Void) {
        self.hubURL = hubURL
        self.restartHub = restartHub
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

    private func runFlow(afterEnableAccess: Bool = false) async {
        render(.loading(afterEnableAccess ? "Reconnecting to the hub…" : "Preparing pairing code…"))
        switch await mintCode() {
        case .ok(let response):
            await showQRAndPoll(response)
        case .needsAccess:
            if afterEnableAccess {
                // We just wrote hub.bind = "0.0.0.0" and restarted, yet the hub
                // is still refusing to mint - surface it rather than looping
                // back to the same "Allow other devices" screen.
                render(.error(
                    "Other devices were allowed, but the hub is still local-only. "
                        + "Try again in a moment, or check ~/.config/signalbox/settings.json."
                ))
            } else {
                render(.needsAccess)
            }
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
        let port = hubURL.port ?? 8377
        let lanURL = "http://\(ip):\(port)"
        let deepLink = Self.pairDeepLink(url: lanURL, code: response.code)
        guard let qr = Self.qrImage(from: deepLink, points: 240) else {
            render(.error("Could not render the pairing code."))
            return
        }
        render(.qr(qr, lanURL))
        await pollStatus(expiresIn: response.expiresIn ?? 180)
    }

    // Poll /pair/status every 2s. Redeemed swaps to the paired state and
    // auto-closes; a code that expires (status back to none, or its lifetime
    // elapsed) offers a fresh one. Transient fetch errors are ignored so a hub
    // blip does not read as expiry.
    private func pollStatus(expiresIn: Int) async {
        let deadline = Date().addingTimeInterval(TimeInterval(expiresIn))
        var sawPending = false
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { return }
            switch await fetchStatus() {
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

    // MARK: - Network access

    @objc private func allowOtherDevices() {
        flowTask?.cancel()
        flowTask = Task { await self.enableAccessAndReconnect() }
    }

    private func enableAccessAndReconnect() async {
        render(.enablingAccess)
        // Deep-merges hub.bind = "0.0.0.0" and leaves every other key (including
        // an existing hub.token) untouched. Never enabled silently: we are here
        // only because the user clicked "Allow other devices".
        SharedSettings.enableNetworkAccess()
        // The restarted hub re-reads settings.json, binds every interface, and
        // mints a token if it has none.
        await restartHub()
        guard await waitForHub() else {
            if Task.isCancelled { return }
            render(.error(
                "The hub did not come back after allowing other devices. "
                    + "Try again in a moment."
            ))
            return
        }
        if Task.isCancelled { return }
        await runFlow(afterEnableAccess: true)
    }

    // Wait for the freshly restarted hub to answer on loopback again (about 20s
    // of headroom) before re-minting a code.
    private func waitForHub() async -> Bool {
        for _ in 0..<40 {
            if Task.isCancelled { return false }
            var request = URLRequest(url: hubURL.appendingPathComponent("state"))
            request.timeoutInterval = 1
            if let (_, response) = try? await session.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 200 {
                return true
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        return false
    }

    // MARK: - Hub calls

    private enum MintResult {
        case ok(PairNewResponse)
        case needsAccess
        case error(String)
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
                // The hub only answers this Mac or has no token - pairing needs
                // other devices allowed.
                return .needsAccess
            default:
                return .error("The hub returned an unexpected status (\(http.statusCode)).")
            }
        } catch {
            return .error("Could not reach the hub on this Mac.")
        }
    }

    private func fetchStatus() async -> String? {
        var request = URLRequest(url: hubURL.appendingPathComponent("pair/status"))
        request.httpMethod = "GET"
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let decoded = try? JSONDecoder().decode(PairStatusResponse.self, from: data)
        else { return nil }
        return decoded.status
    }

    // MARK: - Deep link, QR, LAN IP

    // signalbox://pair?url=<percent-encoded http URL>&code=<code> per the iOS
    // spec: `pair` rides in the host (a custom scheme has no authority of its
    // own), the url is the hub to redeem against, the code is single-use.
    private static func pairDeepLink(url: String, code: String) -> String {
        var unreserved = CharacterSet.alphanumerics
        unreserved.insert(charactersIn: "-._~")
        let encodedURL = url.addingPercentEncoding(withAllowedCharacters: unreserved) ?? url
        let encodedCode = code.addingPercentEncoding(withAllowedCharacters: unreserved) ?? code
        return "signalbox://pair?url=\(encodedURL)&code=\(encodedCode)"
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
        case needsAccess
        case enablingAccess
        case paired
        case expired
        case error(String)
    }

    private func render(_ state: State) {
        guard let container = window?.contentView else { return }
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
        case .needsAccess:
            views = [
                title("Connect your phone"),
                body("Signalbox only answers this Mac. Allow other devices to connect to show the QR."),
                primaryButton("Allow other devices", action: #selector(allowOtherDevices)),
                body(
                    "Anyone on your network with the code could pair; the hub token is stored on your phone.",
                    secondary: true, size: 11
                ),
            ]
        case .enablingAccess:
            views = [spinner(), title("Allowing other devices…")]
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

    enum CodingKeys: String, CodingKey {
        case code
        case expiresIn = "expires_in"
        case bind
    }
}

struct PairStatusResponse: Decodable {
    let status: String
}
