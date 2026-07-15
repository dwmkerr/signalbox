import Foundation

// Wire-format event per specs/events.md. Lenient: only the fields the app
// renders are decoded, and most are optional so a schema tweak on the hub
// side does not brick the menu bar.
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
    // User-set display label (the "label" user-event); beats title everywhere.
    let label: String?
    // Discreet free-form tags carried across agent events; drive `#tag` search.
    let tags: [String]?
    let ts: String?
    let engagedTs: String?
    let seq: Int?
    let acked: Bool?
    let hidden: Bool?
    let origin: SessionOrigin?

    enum CodingKeys: String, CodingKey {
        case agent, event, reason, host, cwd, title, prompt, detail, reply, label, tags, ts, seq, acked, hidden, origin
        case sessionKey = "session_key"
        case engagedTs = "engaged_ts"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Routing fields must exist - an event we cannot status or address is
        // unusable, so let those two throw and the caller drop the event.
        event = try container.decode(String.self, forKey: .event)
        sessionKey = try container.decode(String.self, forKey: .sessionKey)
        // Everything else decodes leniently: `acked`, `hidden`, and `detail`
        // are landing on the hub concurrently, and a missing or retyped field
        // must never fail the whole /state decode or silently drop stream events.
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
        // Landing on the hub concurrently - absent means "fall back to ts".
        engagedTs = try? container.decodeIfPresent(String.self, forKey: .engagedTs)
        seq = try? container.decodeIfPresent(Int.self, forKey: .seq)
        acked = try? container.decodeIfPresent(Bool.self, forKey: .acked)
        hidden = try? container.decodeIfPresent(Bool.self, forKey: .hidden)
        origin = try? container.decodeIfPresent(SessionOrigin.self, forKey: .origin)
    }
}

// Origin union per contract: {"tmux": {...}} or {"url": "..."}. Decoding never
// throws: origin is display-hint data only, and a type mismatch from a skewed
// hub would otherwise fail the whole /state decode and blind the app (or
// silently drop stream events, including `ended`).
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

    // Cursor's own agent: the origin carries only the app bundle id - the CLI
    // raises the window by app + a title match on the session cwd.
    struct CursorTarget: Decodable {
        let bundle: String?

        private enum CodingKeys: String, CodingKey { case bundle }

        init(from decoder: Decoder) throws {
            let container = try? decoder.container(keyedBy: CodingKeys.self)
            bundle = try? container?.decodeIfPresent(String.self, forKey: .bundle)
        }
    }

    struct TmuxTarget: Decodable {
        let session: String?
        let window: Int?
        let pane: String?
        // Terminal app bundle id captured at fire time; the preview's action
        // line resolves it to a display name ("Jump to iTerm (…)").
        let terminal: String?

        private enum CodingKeys: String, CodingKey { case session, window, pane, terminal }

        init(from decoder: Decoder) throws {
            let container = try? decoder.container(keyedBy: CodingKeys.self)
            session = try? container?.decodeIfPresent(String.self, forKey: .session)
            window = try? container?.decodeIfPresent(Int.self, forKey: .window)
            pane = try? container?.decodeIfPresent(String.self, forKey: .pane)
            terminal = try? container?.decodeIfPresent(String.self, forKey: .terminal)
        }
    }
}

struct StateResponse: Decodable {
    let sessions: [SessionEvent]
}

// "Needs checking" per contract: an unacked attention/error/done row is the
// user's work queue; busy rows are informational only.
func needsCheck(_ event: String) -> Bool {
    event == "attention" || event == "error" || event == "done"
}

// Three temperatures, three meanings (the amber scheme): amber = needs your
// input (act), blue = output updated (look), red = failed (fix). Bold =
// unread; faint ring = read. The dot color alone carries the ask signal - the
// old "?" pill is gone.
enum StatusMark {
    case working   // busy: spinner in the palette, static dotted circle in menus
    case attention // attention, unacked: amber dot - blocked on you
    case unread    // done, unacked: blue dot - finished, FYI
    case failed    // error, unacked: the only red in the system
    case read      // acked: faint hollow ring - the row keeps its slot
}

func statusMark(event: String, acked: Bool) -> StatusMark {
    // Busy stays "working" even when acked: seen only clears the needs-you
    // flag, and a running session must keep reading as running.
    if event == "busy" { return .working }
    if acked { return .read }
    switch event {
    case "attention": return .attention
    case "done": return .unread
    case "error": return .failed
    // Unknown events read as working rather than vanishing from the board.
    default: return .working
    }
}

// Static SF Symbol per mark, for surfaces that cannot animate (menus) or that
// render the non-working marks (the palette gutter).
func markSymbolName(_ mark: StatusMark) -> String {
    switch mark {
    case .working: return "circle.dotted"
    case .attention, .unread: return "circle.fill"
    case .failed: return "xmark.circle.fill"
    case .read: return "circle"
    }
}

// Status names per contract, kept as the symbols' accessibility descriptions.
// Unknown events fall through as their raw name rather than hiding.
func statusWord(_ event: String) -> String {
    switch event {
    case "attention": return "needs you"
    case "error": return "error"
    case "done": return "ready"
    case "busy": return "working"
    default: return event
    }
}

func ageString(from date: Date, to now: Date = Date()) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86400 { return "\(seconds / 3600)h" }
    return "\(seconds / 86400)d"
}

// MainActor because ISO8601DateFormatter is not Sendable; all parsing happens
// on the main actor anyway.
@MainActor
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
