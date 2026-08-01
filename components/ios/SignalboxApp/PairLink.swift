import Foundation

// A pairing link the hub hands the phone, either as a QR code or a tappable
// signalbox:// URL. The shape is fixed by the wire contract shared with the
// CLI half:
//
//   signalbox://pair?url=<percent-encoded http(s) URL>&code=<base64url>[&fp=<hex>]
//
// "pair" is the URL host, not a path - a custom-scheme URL has no authority of
// its own, so the verb rides in host. The embedded url is where the phone then
// POSTs the code to redeem a token. `fp` is the SHA-256 of a LAN hub's
// self-signed cert (DER), while an https platform URL without `fp` uses system
// trust. An http url ignores `fp` because there is no TLS certificate to pin.
//
// This is a pure value type on purpose: onOpenURL is triggerable by any webpage
// or iMessage link, so every field is validated here before anything reaches
// the network, and the parser is small enough to reason about and test on its
// own (see the DEBUG self-check in SignalboxApp).
struct PairLink: Equatable {
    let url: URL
    let code: String
    // The cert pin for a pinned (LAN self-signed) https hub, lowercase hex.
    // nil for plain http, and for a remote https hub verified by system CAs.
    let fingerprint: String?

    init?(_ deepLink: URL) {
        // Only our own scheme, and only the pair verb. A stray signalbox://
        // link to anything else is not a pairing request and must not be
        // treated as one.
        guard deepLink.scheme == "signalbox", deepLink.host == "pair" else { return nil }
        guard let components = URLComponents(url: deepLink, resolvingAgainstBaseURL: false),
              let items = components.queryItems else { return nil }

        var embedded: String?
        var codeValue: String?
        var fpValue: String?
        var fpPresent = false
        for item in items {
            switch item.name {
            case "url": embedded = item.value
            case "code": codeValue = item.value
            case "fp": fpPresent = true; fpValue = item.value
            default: break
            }
        }

        // The embedded url must be a real http(s) endpoint. Rejecting anything
        // else here is the guard that stops a crafted link (file:, javascript:,
        // a scheme-less string) from steering the redeem POST somewhere it
        // should never go.
        guard let embedded, let target = URL(string: embedded),
              let scheme = target.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              target.host?.isEmpty == false else { return nil }
        guard let codeValue, !codeValue.isEmpty else { return nil }

        // An https link either carries a valid pin (a LAN hub's self-signed
        // cert, verified by the pin) or no fp at all (a remote hub behind real
        // platform TLS, verified by system CAs - see CertPinner). A malformed
        // pin is still refused because falling back to system trust would
        // quietly drop the pin the hub asked for.
        let fp = fpValue.map { $0.lowercased() }
        if scheme == "https", fpPresent {
            guard let fp, Self.isSHA256Hex(fp) else { return nil }
        }

        self.url = target
        self.code = codeValue
        // Keep the pin only for https; an http url ignores any stray fp.
        self.fingerprint = scheme == "https" ? fp : nil
    }

    private static func isSHA256Hex(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
        }
    }
}

#if DEBUG
extension PairLink {
    // A pure-code check of the parsing contract, run once at launch in DEBUG.
    // The hand-written pbxproj has no test target, so this stands in for the
    // XCTest that would otherwise pin these invariants: every case here is a
    // must-not-regress from the security review.
    static func runSelfCheck() {
        func expectValid(_ raw: String, host: String, code: String, fp: String?, _ label: String) {
            guard let url = URL(string: raw), let link = PairLink(url) else {
                assertionFailure("PairLink self-check: expected \(label) to parse")
                return
            }
            assert(link.url.host == host, "PairLink self-check: \(label) host was \(link.url.host ?? "nil")")
            assert(link.code == code, "PairLink self-check: \(label) code was \(link.code)")
            assert(link.fingerprint == fp, "PairLink self-check: \(label) fp was \(link.fingerprint ?? "nil")")
        }
        func expectNil(_ raw: String, _ label: String) {
            let url = URL(string: raw)
            assert(url.flatMap(PairLink.init) == nil, "PairLink self-check: expected \(label) to be rejected")
        }
        func expectTarget(_ raw: String, fingerprint: String?, _ target: PairTarget, _ label: String) {
            guard let url = URL(string: raw) else {
                assertionFailure("PairLink self-check: expected \(label) URL to parse")
                return
            }
            assert(
                PairTarget.of(url: url, fingerprint: fingerprint) == target,
                "PairLink self-check: expected \(label) to be \(target)"
            )
        }

        let hex64 = String(repeating: "a1", count: 32) // 64 hex chars

        // The happy path: a percent-encoded LAN http url decodes; no pin on http.
        expectValid(
            "signalbox://pair?url=http%3A%2F%2F192.168.1.20%3A8377&code=abc123",
            host: "192.168.1.20", code: "abc123", fp: nil, "percent-encoded http lan url"
        )
        // The TLS path (#25): https with a valid 64-hex pin keeps the pin.
        expectValid(
            "signalbox://pair?url=https%3A%2F%2F192.168.1.20%3A8378&code=x-y_z&fp=\(hex64)",
            host: "192.168.1.20", code: "x-y_z", fp: hex64, "https url + pin"
        )
        // A stray fp on an http url is ignored, not pinned.
        expectValid(
            "signalbox://pair?url=http%3A%2F%2F192.168.1.20%3A8377&code=abc&fp=\(hex64)",
            host: "192.168.1.20", code: "abc", fp: nil, "http url ignores fp"
        )
        // https with NO pin is the remote-hub case: system CA trust, fp nil.
        expectValid(
            "signalbox://pair?url=https%3A%2F%2Fmy-hub.fly.dev&code=abc",
            host: "my-hub.fly.dev", code: "abc", fp: nil, "https remote url without pin"
        )
        // A malformed pin is a corrupted or crafted link, never a fallback: reject.
        expectNil("signalbox://pair?url=https%3A%2F%2F192.168.1.20%3A8378&code=abc&fp=xyz", "https bad pin")
        expectNil("signalbox://pair?url=https%3A%2F%2F192.168.1.20%3A8378&code=abc&fp=ABCDEF", "https short pin")
        expectNil("signalbox://pair?url=https%3A%2F%2F192.168.1.20%3A8378&code=abc&fp=", "https empty pin")
        // Wrong verb, hostile embedded schemes, and empty code all reject.
        expectNil("signalbox://open?url=http%3A%2F%2F127.0.0.1%3A8377&code=abc", "host != pair")
        expectNil("signalbox://pair?url=file%3A%2F%2F%2Fetc%2Fpasswd&code=abc", "file: embedded url")
        expectNil("signalbox://pair?url=javascript%3Aalert(1)&code=abc", "javascript: embedded url")
        expectNil("signalbox://pair?url=%2F%2F127.0.0.1%3A8377&code=abc", "scheme-less embedded url")
        expectNil("signalbox://pair?url=http%3A%2F%2F127.0.0.1%3A8377&code=", "empty code")
        expectNil("signalbox://pair?code=abc", "missing url")
        expectNil("notsignalbox://pair?url=http%3A%2F%2F127.0.0.1%3A8377&code=abc", "wrong scheme")

        let lanMessage = PairError.unreachable(host: "192.168.1.20", target: .lan).message
        assert(lanMessage.contains("same Wi-Fi"), "PairLink self-check: LAN advice must name same Wi-Fi")
        assert(lanMessage.contains("remote hub"), "PairLink self-check: LAN advice must name remote hub")
        let remoteMessage = PairError.unreachable(host: "hub.example.com", target: .remote).message
        assert(remoteMessage.contains("internet connection"), "PairLink self-check: remote advice must name internet")
        assert(!remoteMessage.contains("Wi-Fi"), "PairLink self-check: remote advice must not name Wi-Fi")

        expectTarget("https://192.168.1.20:8378", fingerprint: hex64, .lan, "https with pin")
        expectTarget("http://192.168.1.20:8377", fingerprint: nil, .lan, "http without pin")
        expectTarget("https://hub.example.com", fingerprint: nil, .remote, "https without pin")
        expectTarget("http://192.168.1.20:8377", fingerprint: hex64, .lan, "http with stray fp")
    }
}
#endif

// Which kind of hub failed to answer. The advice differs completely: a LAN
// hub is unreachable when the two devices cannot see each other, which hotel
// and office networks routinely arrange even on one SSID (AP isolation),
// while a remote hub is unreachable when the phone has no internet at all.
enum PairTarget: Equatable { case lan, remote }

extension PairTarget {
    // A pin means a LAN hub's self-signed cert; plain http means a LAN hub
    // with no TLS at all. https with no pin is a hub behind platform TLS,
    // which is only ever reached over the internet.
    static func of(url: URL, fingerprint: String?) -> PairTarget {
        fingerprint != nil || url.scheme?.lowercased() == "http" ? .lan : .remote
    }
}

// The failure surface for the whole pairing flow, phrased for a person holding
// a phone rather than a log. Every path that can go wrong maps to exactly one
// of these so the alert always has something plain to say.
enum PairError: Error, Equatable {
    case badLink
    case unreachable(host: String, target: PairTarget)
    case rejected

    var message: String {
        switch self {
        case .badLink:
            return "That is not a valid signalbox pairing code."
        case .unreachable(let host, let target):
            switch target {
            case .lan:
                return "Could not reach \(host). The phone and the Mac must be on the same Wi-Fi - and some hotel and office networks stop devices seeing each other even when they are. If that is what is happening, run a remote hub instead: see \"Run a remote hub\" in the signalbox docs."
            case .remote:
                return "Could not reach \(host). Check the phone's internet connection, and that the hub is running."
            }
        case .rejected:
            return "Code expired or already used - run signalbox pair again on your computer."
        }
    }
}
