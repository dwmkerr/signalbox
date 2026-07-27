import Foundation

// A pairing link the hub hands the phone, either as a QR code or a tappable
// signalbox:// URL. The shape is fixed by the wire contract shared with the
// CLI half:
//
//   signalbox://pair?url=<percent-encoded "https://LAN-IP:PORT">&code=<base64url>&fp=<hex>
//
// "pair" is the URL host, not a path - a custom-scheme URL has no authority of
// its own, so the verb rides in host. The embedded url is where the phone then
// POSTs the code to redeem a token. `fp` is the SHA-256 of the hub's self-signed
// cert (DER), present on an https url so the phone can pin it (#25); an http url
// (the openssl-less fallback, or a hand-entered hub) carries none.
//
// This is a pure value type on purpose: onOpenURL is triggerable by any webpage
// or iMessage link, so every field is validated here before anything reaches
// the network, and the parser is small enough to reason about and test on its
// own (see the DEBUG self-check in SignalboxApp).
struct PairLink: Equatable {
    let url: URL
    let code: String
    // The cert pin for an https hub, lowercase hex; nil for a plain-http hub.
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
        for item in items {
            switch item.name {
            case "url": embedded = item.value
            case "code": codeValue = item.value
            case "fp": fpValue = item.value
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

        // An https hub MUST carry a valid pin: connecting to a self-signed cert
        // without one cannot be verified, so a pin-less https link is refused
        // rather than trusted blindly. A pin is a 64-char SHA-256 hex string.
        let fp = fpValue.map { $0.lowercased() }
        let validFP = fp.map { Self.isSHA256Hex($0) } ?? false
        if scheme == "https" {
            guard validFP else { return nil }
        }

        self.url = target
        self.code = codeValue
        // Keep the pin only for https; an http url ignores any stray fp.
        self.fingerprint = scheme == "https" ? fp : nil
    }

    private static func isSHA256Hex(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { $0.isHexDigit && (!$0.isLetter || $0.isLowercase) }
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
        // https without a pin, or with a malformed one, cannot be verified: reject.
        expectNil("signalbox://pair?url=https%3A%2F%2F192.168.1.20%3A8378&code=abc", "https without pin")
        expectNil("signalbox://pair?url=https%3A%2F%2F192.168.1.20%3A8378&code=abc&fp=xyz", "https bad pin")
        expectNil("signalbox://pair?url=https%3A%2F%2F192.168.1.20%3A8378&code=abc&fp=ABCDEF", "https short/upper pin")
        // Wrong verb, hostile embedded schemes, and empty code all reject.
        expectNil("signalbox://open?url=http%3A%2F%2F127.0.0.1%3A8377&code=abc", "host != pair")
        expectNil("signalbox://pair?url=file%3A%2F%2F%2Fetc%2Fpasswd&code=abc", "file: embedded url")
        expectNil("signalbox://pair?url=javascript%3Aalert(1)&code=abc", "javascript: embedded url")
        expectNil("signalbox://pair?url=%2F%2F127.0.0.1%3A8377&code=abc", "scheme-less embedded url")
        expectNil("signalbox://pair?url=http%3A%2F%2F127.0.0.1%3A8377&code=", "empty code")
        expectNil("signalbox://pair?code=abc", "missing url")
        expectNil("notsignalbox://pair?url=http%3A%2F%2F127.0.0.1%3A8377&code=abc", "wrong scheme")
    }
}
#endif

// The failure surface for the whole pairing flow, phrased for a person holding
// a phone rather than a log. Every path that can go wrong maps to exactly one
// of these so the alert always has something plain to say.
enum PairError: Error, Equatable {
    case badLink
    case unreachable(String)
    case rejected

    var message: String {
        switch self {
        case .badLink:
            return "That is not a valid signalbox pairing code."
        case .unreachable(let host):
            return "Could not reach \(host); phone and computer must be on the same Wi-Fi."
        case .rejected:
            return "Code expired or already used - run signalbox pair again on your computer."
        }
    }
}
