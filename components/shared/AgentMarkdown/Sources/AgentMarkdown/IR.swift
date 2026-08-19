public struct MarkdownDocument: Equatable, Sendable {
    public var blocks: [Block]

    public init(blocks: [Block]) {
        self.blocks = blocks
    }
}

public enum Block: Equatable, Sendable {
    case paragraph([Span])
    case heading(level: Int, spans: [Span])
    case bulletList([[Span]])
    case orderedList(start: Int, items: [[Span]])
    case codeBlock(language: String?, code: String)
    case table(header: [[Span]], rows: [[[Span]]])
}

public struct Span: Equatable, Sendable {
    public var text: String
    public var style: SpanStyle
    public var link: String?

    public init(text: String, style: SpanStyle, link: String?) {
        self.text = text
        self.style = style
        self.link = link
    }

    public init(_ text: String) {
        self.init(text: text, style: [], link: nil)
    }

    public init(_ text: String, _ style: SpanStyle) {
        self.init(text: text, style: style, link: nil)
    }

    public init(_ text: String, link: String) {
        self.init(text: text, style: [], link: link)
    }
}

public struct SpanStyle: OptionSet, Sendable {
    public let rawValue: Int

    public init(rawValue: Int) {
        self.rawValue = rawValue
    }

    public static let bold: SpanStyle = SpanStyle(rawValue: 1 << 0)
    public static let italic: SpanStyle = SpanStyle(rawValue: 1 << 1)
    public static let code: SpanStyle = SpanStyle(rawValue: 1 << 2)
}

public enum Dialect: Sendable {
    // The common grammar every agent we have seen emits. Per-agent dialects
    // are added here, so a call site never has to know which agent it is
    // rendering.
    case common
}

public enum AgentMarkdown {
    // One definition of the affordance, so the spec, both apps and the tests
    // cannot disagree about what a cut reply ends with.
    public static let croppedMarker = "\u{2026}"
}
