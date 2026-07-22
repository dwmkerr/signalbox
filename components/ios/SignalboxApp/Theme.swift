import SwiftUI

// The same signals, the same words, the same colours as every other surface
// (components/specs/hub-jumplist.html). A phone that invents its own language
// for "needs you" would make the product mean two different things.

enum Mark {
    case attention  // amber: needs your input (act)
    case unread     // blue: output updated (look)
    case failed     // red: failed (fix)
    case working    // spinner
    case read       // faint ring: dealt with, keeps its place

    static func of(_ session: Session) -> Mark {
        if session.event == "busy" { return .working }
        if session.acked { return .read }
        switch session.event {
        case "attention": return .attention
        case "error": return .failed
        case "done": return .unread
        default: return .unread
        }
    }

    var color: Color {
        switch self {
        case .attention: return Theme.amber
        case .unread: return Theme.blue
        case .failed: return Theme.red
        case .working, .read: return Theme.dim
        }
    }

    /// The amber mark alone means "asking" - there is no extra badge anywhere
    /// else, and adding one here would break the shared language.
    var isAsking: Bool { self == .attention }
}

enum Theme {
    static let amber = Color(red: 1.0, green: 0.624, blue: 0.039)      // #FF9F0A
    static let blue = Color(red: 0.039, green: 0.518, blue: 1.0)       // #0A84FF
    static let red = Color(red: 1.0, green: 0.271, blue: 0.227)        // #FF453A
    static let green = Color(red: 0.204, green: 0.780, blue: 0.349)    // #34C759
    static let bg = Color(red: 0.043, green: 0.043, blue: 0.051)       // #0B0B0D
    static let card = Color(red: 0.078, green: 0.078, blue: 0.086)
    static let text = Color(red: 0.929, green: 0.929, blue: 0.929)     // #EDEDED
    static let dim = Color(red: 0.557, green: 0.557, blue: 0.576)      // #8E8E93
    static let faint = Color(red: 0.431, green: 0.431, blue: 0.451)    // #6E6E73
}

// The glyph comes from the event's `agent` field: there is no icon metadata on
// the wire, each surface maps the name itself. SF Symbols stand in for the
// macOS app's hand-drawn marks; the mapping is what matters.
func agentGlyph(_ agent: String) -> String {
    switch agent.lowercased() {
    case "claude": return "sparkle"
    case "opencode": return "terminal"
    case "pi": return "function"
    case "codex": return "hexagon"
    case "github": return "checkmark.seal"
    case let a where a.hasPrefix("cursor"): return "cube"
    // Editor-hosted agents (e.g. vscode/claude) show the host's mark; the phone
    // has no room to badge the sub-agent, so it stands in for the whole row,
    // matching how cursor/* shows the cube.
    case let a where a.hasPrefix("vscode"): return "chevron.left.forwardslash.chevron.right"
    default: return "circle"
    }
}

func agentColor(_ agent: String) -> Color {
    switch agent.lowercased() {
    case "claude": return Color(red: 0.851, green: 0.467, blue: 0.341)  // #D97757
    case "pi": return Theme.blue
    case "codex": return Color(red: 0.063, green: 0.639, blue: 0.498)  // #10A37F
    case let a where a.hasPrefix("vscode"): return Color(red: 0.0, green: 0.478, blue: 0.8)  // #007ACC
    default: return Theme.dim
    }
}

/// The line under each name: your prompt while it works (what it is working
/// on), its reply once it finishes, asks or fails (what came back). Identical
/// rule to the jumplist, so the two never disagree.
func subtext(_ session: Session) -> String? {
    session.event == "busy" ? session.prompt : (session.reply ?? session.prompt)
}

/// Agent replies carry inline markdown (bold, code); render it rather than
/// showing the asterisks. Inline-only: block syntax in a one-line breadcrumb
/// would do more harm than good. Malformed markdown falls back to plain text.
func markdownText(_ text: String) -> AttributedString {
    (try? AttributedString(
        markdown: text,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    )) ?? AttributedString(text)
}
