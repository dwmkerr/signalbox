import Foundation

// Copied from components/app/Sources/Signalbox/Model.swift, which is the only
// Foundation-only file in the macOS app and so ports here unchanged. The
// duplication is deliberate for now: factoring a shared SwiftPM target touches
// the macOS app's layout, and these two surfaces are moving fast in parallel.
// Fold them together once both settle.
//
// Wire format per components/specs/events.md. Lenient: only the fields a
// surface renders are decoded, and most are optional so a schema tweak on the
// hub side does not brick the app.

struct SessionEvent: Decodable {
    let agent: String
    let event: String
    let reason: String?
    let sessionKey: String
    let host: String?
    let cwd: String?
    let title: String?
    // The human/trigger side of the exchange breadcrumb. The hub sends
    // `prompt`; `detail` is the pre-v0.2 name, still accepted so a mixed log
    // or an older hub never blanks the row.
    let prompt: String?
    let reply: String?
    // User-set display label; beats title everywhere.
    let label: String?
    let tags: [String]?
    let ts: String?
    let engagedTs: String?
    let seq: Int?
    let acked: Bool?
    let hidden: Bool?
    // Kept at the top of the board regardless of engagement order. The hub owns
    // the partition and omits the field when false, so a missing key is unpinned.
    let pinned: Bool?
    let origin: SessionOrigin?

    enum CodingKeys: String, CodingKey {
        case agent, event, reason, host, cwd, title, prompt, detail, reply, label, tags, ts, seq, acked, hidden, pinned, origin
        case sessionKey = "session_key"
        case engagedTs = "engaged_ts"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Routing fields must exist - an event we cannot status or address is
        // unusable, so let those two throw and the caller drop the event. This
        // is also what makes a command frame inert to a client that predates
        // commands: a command has no `event` key, so it fails here and is
        // skipped rather than misread as a session status.
        event = try container.decode(String.self, forKey: .event)
        sessionKey = try container.decode(String.self, forKey: .sessionKey)
        // Everything else decodes leniently: a missing or retyped field must
        // never fail the whole /state decode or silently drop stream events.
        agent = (try? container.decodeIfPresent(String.self, forKey: .agent)) ?? ""
        reason = try? container.decodeIfPresent(String.self, forKey: .reason)
        host = try? container.decodeIfPresent(String.self, forKey: .host)
        cwd = try? container.decodeIfPresent(String.self, forKey: .cwd)
        title = try? container.decodeIfPresent(String.self, forKey: .title)
        prompt = (try? container.decodeIfPresent(String.self, forKey: .prompt))
            ?? (try? container.decodeIfPresent(String.self, forKey: .detail)) ?? nil
        reply = try? container.decodeIfPresent(String.self, forKey: .reply)
        label = try? container.decodeIfPresent(String.self, forKey: .label)
        tags = try? container.decodeIfPresent([String].self, forKey: .tags)
        ts = try? container.decodeIfPresent(String.self, forKey: .ts)
        engagedTs = try? container.decodeIfPresent(String.self, forKey: .engagedTs)
        seq = try? container.decodeIfPresent(Int.self, forKey: .seq)
        acked = try? container.decodeIfPresent(Bool.self, forKey: .acked)
        hidden = try? container.decodeIfPresent(Bool.self, forKey: .hidden)
        pinned = try? container.decodeIfPresent(Bool.self, forKey: .pinned)
        origin = try? container.decodeIfPresent(SessionOrigin.self, forKey: .origin)
    }
}

// Origin per contract: {"tmux": {...}}, {"url": "..."} or {"cursor": {...}}.
// Decoding never throws: origin is display-hint data only, and a type mismatch
// from a skewed hub would otherwise fail the whole /state decode.
struct SessionOrigin: Decodable {
    let tmux: TmuxTarget?
    let url: String?
    let cursor: CursorTarget?

    private enum CodingKeys: String, CodingKey { case tmux, url, cursor }

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        tmux = try? container?.decodeIfPresent(TmuxTarget.self, forKey: .tmux)
        url = try? container?.decodeIfPresent(String.self, forKey: .url)
        cursor = try? container?.decodeIfPresent(CursorTarget.self, forKey: .cursor)
    }
}

struct TmuxTarget: Decodable {
    let session: String?
    let window: Int?
    let pane: String?
    let terminal: String?
}

struct CursorTarget: Decodable {
    let bundle: String?
}

struct StateDoc: Decodable {
    let sessions: [SessionEvent]
}

// A session row: the hub's own view, adopted rather than re-derived. The hub
// owns order, acked and hidden - this app renders, it does not reduce.
struct Session: Identifiable, Equatable {
    let key: String
    let agent: String
    let event: String
    let host: String
    let name: String
    let prompt: String?
    let reply: String?
    let tags: [String]
    let date: Date
    let acked: Bool
    let hidden: Bool
    // Pinned to the top of the board by the user. The hub owns the partition, so
    // this is adopted, never re-derived, and pinned rows already arrive first.
    let pinned: Bool
    // Whether this row can be jumped to at all: a github/CI row has no machine
    // to jump on, so it is information rather than an action.
    let jumpable: Bool

    var id: String { key }

    // Bold means unread, and it is also the only state where firing `seen` would
    // change anything: a quiet acked row and a busy-working row are both no-ops,
    // so the trailing swipe only offers Seen when this is true.
    var isUnread: Bool { !acked && event != "busy" }
}

enum EventDate {
    private static let plain = ISO8601DateFormatter()
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func parse(_ ts: String?) -> Date? {
        guard let ts else { return nil }
        return plain.date(from: ts) ?? fractional.date(from: ts)
    }
}

func shortAge(_ date: Date, now: Date = Date()) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86400 { return "\(seconds / 3600)h" }
    return "\(seconds / 86400)d"
}
