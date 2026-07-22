import AppKit

// One display row, precomputed by the AppDelegate from its session model so
// the palette never duplicates ordering, status, or naming logic. Rows arrive
// already filtered (hidden rows dropped; acked rows present with a neutral
// icon and needsCheck false) and in /state order (engagement MRU).
struct PaletteRow {
    let sessionKey: String
    let mark: StatusMark
    let statusWord: String
    // Amber scheme: the amber mark alone says "needs your input" (no pill);
    // this flag drives the preview's ask-colored bullet and action line.
    let isAsking: Bool
    // Bold title = unread (done/attention/error, unacked).
    let isUnread: Bool
    // Read rows keep their slot but go quiet: regular weight, dim reply.
    let isRead: Bool
    let agent: String
    let name: String
    // Ages tick live (list and Working… runtime), so rows carry the start
    // date rather than a pre-rendered string.
    let ageStart: Date
    let detail: String?
    let reply: String?
    // The action line's "where": derived from origin + host by the delegate
    // (terminal app name, tmux coords, host) - display data, not jump logic.
    let location: String
    let needsCheck: Bool
    // Drives next-to-check and Tab cycling; display order stays the hub's.
    let engagedDate: Date
    // Discreet session tags; matched by `#tag` search, never rendered.
    let tags: [String]
    // User-pinned: draws a quiet pin mark. Order is the hub's (pinned-first);
    // this flag never sorts locally.
    let pinned: Bool
    // A hidden session: drawn dimmed under the Hidden divider, and inert (not
    // selectable, not reachable by keys). It resurfaces when the agent speaks
    // again, or on a click that fires `show`.
    var isHidden = false
    // The "Hidden (N)" divider row itself. Not a session; carries the count and
    // toggles the section open on click.
    var isDivider = false
    var hiddenCount = 0
}

// Mark tints per the amber scheme: amber = needs your input (act), blue =
// output updated (look), red = failed (fix); neutral gray for ambient work;
// the read ring fades further so dealt-with rows go quiet without losing
// their slot. (Also used by the menu bar menu and status icon dot.)
func markColor(_ mark: StatusMark) -> NSColor {
    switch mark {
    case .attention: return Theme.attention
    case .unread: return .systemBlue
    case .failed: return .systemRed
    case .read: return NSColor.secondaryLabelColor.withAlphaComponent(0.65)
    case .working: return .secondaryLabelColor
    }
}

// MARK: - Theme

private extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

// Colors and metrics come verbatim from palette-interactive.html - the
// approved visual reference. Fixed (not dynamic) colors because the mock is
// dark-only; the panel forces dark appearance to match.
enum Theme {
    static let panelBG = NSColor(hex: 0x1E1E21)
    static let terminalBG = NSColor.black // preview pane: the terminal it quotes
    static let panelBorder = NSColor(white: 1, alpha: 0.125) // #ffffff20
    static let hairline = NSColor(white: 1, alpha: 0.078) // #ffffff14
    static let selection = NSColor(hex: 0x2C2C31)
    static let textMid = NSColor(hex: 0xB5B5BA) // brand, header verbs, glyph strokes
    static let textDim = NSColor(hex: 0x6E6E73) // breadcrumb, footer, action line
    static let title = NSColor(hex: 0xADADB2)
    static let titleUnread = NSColor(hex: 0xEDEDED)
    static let age = NSColor(hex: 0x98989D)
    static let accent = NSColor(hex: 0x0A84FF)
    static let green = NSColor(hex: 0x32D74B)
    static let rust = NSColor(hex: 0xD97757) // claude sunburst
    static let vscode = NSColor(hex: 0x007ACC) // VS Code blue (host mark)
    static let amber = NSColor(hex: 0xE8B339) // Working… line
    // The scheme's "act" temperature (design/amber-scheme.svg) - hotter than
    // the Working… amber so an ask reads distinctly from ambient work.
    static let attention = NSColor(hex: 0xFF9F0A)
    static let keycapBG = NSColor(hex: 0x3A3A3F)
    static let keycapBorder = NSColor(white: 1, alpha: 0.10) // #ffffff1a
    static let keycapText = NSColor(hex: 0xD8D8DC)
    static let caret = NSColor(hex: 0x5A5A5F) // ❯ prefix, read bullet
    static let promptText = NSColor(hex: 0x98989D)
    static let replyText = NSColor(hex: 0xD8D8DC)
    static let readText = NSColor(hex: 0x8E8E93)
    static let spinFaint = NSColor(hex: 0x98989D, alpha: 0.25)
    static let spinArc = NSColor(hex: 0x98989D)
    static let ring = NSColor(hex: 0x98989D, alpha: 0.55)
}

// MARK: - UI scale (jumplist zoom)

// The jumplist zoom (⌘+/⌘−/⌘0). Geometry and font sizes multiply by this
// factor - never a layer transform - so text stays crisp at every step.
// Persisted in UserDefaults per components/specs/settings.html; the menu bar dropdown
// and Settings window deliberately do not scale.
@MainActor
enum PaletteScale {
    static let defaultsKey = "uiScale"
    static let minimum: CGFloat = 0.8
    static let maximum: CGFloat = 1.6
    static let step: CGFloat = 0.1

    static var current: CGFloat {
        let stored = UserDefaults.standard.object(forKey: defaultsKey) as? Double
        return stored.map { clamp(CGFloat($0)) } ?? 1.0
    }

    static func set(_ value: CGFloat) {
        UserDefaults.standard.set(Double(clamp(value)), forKey: defaultsKey)
    }

    // Snap to the 0.1 grid so repeated ⌘+/⌘− steps cannot drift on float error.
    static func clamp(_ value: CGFloat) -> CGFloat {
        min(max((value * 10).rounded() / 10, minimum), maximum)
    }
}

// Scales a design-reference point value (the mock's 1.0× metrics) by the
// current jumplist zoom.
@MainActor
private func s(_ value: CGFloat) -> CGFloat { value * PaletteScale.current }

// MARK: - SVG path support (octocat)

// Minimal SVG path-data parser: just enough commands for the glyph paths in
// the approved mock (the octocat uses M/C/c/s/A/z). Drawing the real path
// beats approximating the mark - there is no octocat SF Symbol.
enum SVGPath {
    static func bezierPath(_ d: String) -> NSBezierPath {
        var scanner = Scanner(d)
        let path = NSBezierPath()
        var current = CGPoint.zero
        var subpathStart = CGPoint.zero
        var lastCubicControl: CGPoint?
        var command: Character?
        while true {
            if let next = scanner.consumeCommand() {
                command = next
            } else if !scanner.hasNumber() {
                break
            }
            guard let cmd = command else { break }
            let relative = cmd.isLowercase
            func point() -> CGPoint? {
                guard let x = scanner.number(), let y = scanner.number() else { return nil }
                return relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
            }
            switch Character(cmd.uppercased()) {
            case "M":
                guard let p = point() else { return path }
                path.move(to: p)
                current = p
                subpathStart = p
                // Extra coordinate pairs after a moveto are implicit linetos.
                command = relative ? "l" : "L"
                lastCubicControl = nil
            case "L":
                guard let p = point() else { return path }
                path.line(to: p)
                current = p
                lastCubicControl = nil
            case "H":
                guard let x = scanner.number() else { return path }
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.line(to: current)
                lastCubicControl = nil
            case "V":
                guard let y = scanner.number() else { return path }
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.line(to: current)
                lastCubicControl = nil
            case "C":
                guard let c1 = point(), let c2 = point(), let p = point() else { return path }
                path.curve(to: p, controlPoint1: c1, controlPoint2: c2)
                current = p
                lastCubicControl = c2
            case "S":
                // First control point reflects the previous curve's second one.
                let c1 = lastCubicControl.map {
                    CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y)
                } ?? current
                guard let c2 = point(), let p = point() else { return path }
                path.curve(to: p, controlPoint1: c1, controlPoint2: c2)
                current = p
                lastCubicControl = c2
            case "A":
                guard let rx = scanner.number(), let ry = scanner.number(),
                      let rotation = scanner.number(),
                      let largeArc = scanner.number(), let sweep = scanner.number(),
                      let p = point()
                else { return path }
                appendArc(
                    to: path, from: current, to: p, rx: rx, ry: ry,
                    rotationDegrees: rotation, largeArc: largeArc != 0, sweep: sweep != 0
                )
                current = p
                lastCubicControl = nil
            case "Z":
                path.close()
                current = subpathStart
                lastCubicControl = nil
            default:
                return path
            }
        }
        return path
    }

    // Endpoint→center arc conversion (SVG spec F.6.5) then cubic segments of
    // ≤90° - the standard construction, exact enough at glyph scale.
    private static func appendArc(
        to path: NSBezierPath, from p1: CGPoint, to p2: CGPoint,
        rx rxIn: CGFloat, ry ryIn: CGFloat, rotationDegrees: CGFloat,
        largeArc: Bool, sweep: Bool
    ) {
        var rx = abs(rxIn)
        var ry = abs(ryIn)
        guard rx > 0, ry > 0, p1 != p2 else {
            path.line(to: p2)
            return
        }
        let phi = rotationDegrees * .pi / 180
        let cosPhi = cos(phi)
        let sinPhi = sin(phi)
        let dx = (p1.x - p2.x) / 2
        let dy = (p1.y - p2.y) / 2
        let x1p = cosPhi * dx + sinPhi * dy
        let y1p = -sinPhi * dx + cosPhi * dy
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 {
            let scale = sqrt(lambda)
            rx *= scale
            ry *= scale
        }
        let numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        var coefficient = sqrt(max(0, numerator / denominator))
        if largeArc == sweep { coefficient = -coefficient }
        let cxp = coefficient * rx * y1p / ry
        let cyp = -coefficient * ry * x1p / rx
        let cx = cosPhi * cxp - sinPhi * cyp + (p1.x + p2.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (p1.y + p2.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
            var a = acos(min(1, max(-1, dot / len)))
            if ux * vy - uy * vx < 0 { a = -a }
            return a
        }
        let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var delta = angle(
            (x1p - cxp) / rx, (y1p - cyp) / ry,
            (-x1p - cxp) / rx, (-y1p - cyp) / ry
        )
        if !sweep, delta > 0 { delta -= 2 * .pi }
        if sweep, delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let segmentAngle = delta / CGFloat(segments)
        let k = 4 / 3 * tan(segmentAngle / 4)
        func pointAt(_ t: CGFloat) -> CGPoint {
            CGPoint(
                x: cx + rx * cos(t) * cosPhi - ry * sin(t) * sinPhi,
                y: cy + rx * cos(t) * sinPhi + ry * sin(t) * cosPhi
            )
        }
        func derivativeAt(_ t: CGFloat) -> CGPoint {
            CGPoint(
                x: -rx * sin(t) * cosPhi - ry * cos(t) * sinPhi,
                y: -rx * sin(t) * sinPhi + ry * cos(t) * cosPhi
            )
        }
        var t1 = theta1
        for _ in 0..<segments {
            let t2 = t1 + segmentAngle
            let e1 = pointAt(t1)
            let e2 = pointAt(t2)
            let d1 = derivativeAt(t1)
            let d2 = derivativeAt(t2)
            path.curve(
                to: e2,
                controlPoint1: CGPoint(x: e1.x + k * d1.x, y: e1.y + k * d1.y),
                controlPoint2: CGPoint(x: e2.x - k * d2.x, y: e2.y - k * d2.y)
            )
            t1 = t2
        }
    }

    private struct Scanner {
        private let chars: [Character]
        private var index = 0

        init(_ s: String) { chars = Array(s) }

        private mutating func skipSeparators() {
            while index < chars.count,
                  chars[index] == " " || chars[index] == "," || chars[index].isNewline {
                index += 1
            }
        }

        mutating func consumeCommand() -> Character? {
            skipSeparators()
            guard index < chars.count, chars[index].isLetter else { return nil }
            defer { index += 1 }
            return chars[index]
        }

        mutating func hasNumber() -> Bool {
            skipSeparators()
            guard index < chars.count else { return false }
            let c = chars[index]
            return c.isNumber || c == "." || c == "-" || c == "+"
        }

        // SVG packs numbers tightly (".4.07", "-.01-.53"): a sign or a second
        // dot terminates the current number.
        mutating func number() -> CGFloat? {
            skipSeparators()
            guard index < chars.count else { return nil }
            var text = ""
            if chars[index] == "-" || chars[index] == "+" {
                text.append(chars[index])
                index += 1
            }
            var seenDot = false
            while index < chars.count {
                let c = chars[index]
                if c.isNumber {
                    text.append(c)
                } else if c == ".", !seenDot {
                    seenDot = true
                    text.append(c)
                } else {
                    break
                }
                index += 1
            }
            return Double(text).map { CGFloat($0) }
        }
    }
}

// MARK: - Glyph views

// Brand mark: the beacon, exactly as the menu bar draws it - monochrome,
// one product mark everywhere.
final class BrandGlyphView: NSView {
    override var intrinsicContentSize: NSSize { NSSize(width: s(16), height: s(16)) }

    override func draw(_ dirtyRect: NSRect) {
        // Context scale keeps the mock's fixed coordinates while the vector
        // strokes render crisply at any zoom.
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        defer { ctx.restoreGState() }
        ctx.scaleBy(x: PaletteScale.current, y: PaletteScale.current)
        let center = NSPoint(x: 8, y: 8)
        Theme.textMid.setFill()
        NSBezierPath(
            ovalIn: NSRect(x: center.x - 2, y: center.y - 2, width: 4, height: 4)
        ).fill()
        for (radius, opacity) in [(CGFloat(4.6), 0.9), (CGFloat(7.2), 0.55)] {
            Theme.textMid.withAlphaComponent(opacity).setStroke()
            for arcUp in [true, false] {
                let arc = NSBezierPath()
                arc.lineWidth = 1.5
                arc.lineCapStyle = .round
                arc.appendArc(
                    withCenter: center, radius: radius,
                    startAngle: arcUp ? 45 : 225, endAngle: arcUp ? 135 : 315
                )
                arc.stroke()
            }
        }
    }
}

// Agent glyphs per the mock: claude sunburst (rust), opencode terminal with a
// green chevron, github octocat path, pi "π", generic ring. Drawn (not font
// glyphs) so they match the SVG reference at any backing scale.
final class AgentGlyphView: NSView {
    private let agent: String

    // Parsed once: the octocat outline from the mock, 16×16 viewBox.
    private static let octocat = SVGPath.bezierPath(
        "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 "
            + "0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13"
            + "-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07"
            + "-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08"
            + "-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 "
            + ".27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 "
            + "2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 "
            + "2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
    )

    init(agent: String) {
        self.agent = agent
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override var intrinsicContentSize: NSSize { NSSize(width: s(22), height: s(20)) }

    // Unscaled: the menu bar renders glyphs through image(for:) at this fixed
    // slot - the jumplist zoom must not leak into the dropdown.
    static let slot = NSSize(width: 22, height: 20)

    override func draw(_ dirtyRect: NSRect) {
        // Context scale keeps drawGlyph's fixed coordinates shared with the
        // (unscaled) menu bar while the vectors stay crisp at any zoom.
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        defer { ctx.restoreGState() }
        ctx.scaleBy(x: PaletteScale.current, y: PaletteScale.current)
        Self.drawGlyph(agent)
    }

    // Shared drawing so the same glyphs render in the jumplist rows (this view)
    // and the menu bar list (rendered to an image below). The context is
    // top-left origin (flipped) in both, so the fixed coordinates line up.
    static func drawGlyph(_ agent: String) {
        // Editor-hosted agents carry a "<host>/<sub>" display name (e.g.
        // cursor/claude, vscode/claude): the editor's mark with the sub-agent
        // badged bottom-right. The bare host name draws the mark alone.
        if agent == "cursor" { drawCursor(); return }
        if agent.hasPrefix("cursor/") {
            drawCursor()
            drawBadge(String(agent.dropFirst("cursor/".count)))
            return
        }
        if agent == "vscode" { drawVSCode(); return }
        if agent.hasPrefix("vscode/") {
            drawVSCode()
            drawBadge(String(agent.dropFirst("vscode/".count)))
            return
        }
        switch agent {
        case "claude": drawClaude()
        case "opencode": drawOpencode()
        case "github": drawGithub()
        case "pi": drawPi()
        case "codex": drawCodex()
        default: drawGeneric()
        }
    }

    // The agent glyph as an NSImage, for NSMenuItem titles which take images,
    // not views.
    static func image(for agent: String) -> NSImage {
        NSImage(size: slot, flipped: true) { _ in
            drawGlyph(agent)
            return true
        }
    }

    private static func drawClaude() {
        // Eight 8pt rays from the center - the sunburst from the mock.
        let center = CGPoint(x: 11, y: 10)
        let path = NSBezierPath()
        path.lineWidth = 2.1
        path.lineCapStyle = .round
        for i in 0..<8 {
            let angle = CGFloat(i) * .pi / 4
            path.move(to: center)
            path.line(to: CGPoint(x: center.x + 8 * cos(angle), y: center.y + 8 * sin(angle)))
        }
        Theme.rust.setStroke()
        path.stroke()
    }

    private static func drawOpencode() {
        // Terminal frame, green prompt chevron, underscore cursor line.
        let frame = NSBezierPath(
            roundedRect: NSRect(x: 2.5, y: 3, width: 17, height: 14), xRadius: 3, yRadius: 3
        )
        frame.lineWidth = 1.6
        Theme.textMid.setStroke()
        frame.stroke()

        let chevron = NSBezierPath()
        chevron.lineWidth = 1.6
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        chevron.move(to: CGPoint(x: 7, y: 8))
        chevron.line(to: CGPoint(x: 10, y: 10.4))
        chevron.line(to: CGPoint(x: 7, y: 12.8))
        Theme.green.setStroke()
        chevron.stroke()

        let cursor = NSBezierPath()
        cursor.lineWidth = 1.6
        cursor.lineCapStyle = .round
        cursor.move(to: CGPoint(x: 12, y: 13))
        cursor.line(to: CGPoint(x: 15.5, y: 13))
        Theme.textMid.setStroke()
        cursor.stroke()
    }

    private static func drawCodex() {
        // A hexagon in OpenAI green - a simple stand-in for Codex's mark.
        let center = CGPoint(x: 11, y: 10)
        let radius: CGFloat = 8
        let path = NSBezierPath()
        for i in 0..<6 {
            let angle = CGFloat(i) * .pi / 3
            let point = CGPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
            if i == 0 { path.move(to: point) } else { path.line(to: point) }
        }
        path.close()
        path.lineWidth = 1.7
        path.lineJoinStyle = .round
        NSColor(hex: 0x10A37F).setStroke()
        path.stroke()
    }

    private static func drawGithub() {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()
        // 19×19 target from a 16×16 viewBox, centered in the 22×20 slot.
        context.translateBy(x: 1.5, y: 0.5)
        context.scaleBy(x: 19.0 / 16.0, y: 19.0 / 16.0)
        Theme.textMid.setFill()
        Self.octocat.fill()
        context.restoreGState()
    }

    private static func drawPi() {
        let text = NSAttributedString(string: "π", attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 15, weight: .regular),
            .foregroundColor: Theme.accent,
        ])
        let size = text.size()
        text.draw(at: CGPoint(x: (22 - size.width) / 2, y: (20 - size.height) / 2))
    }

    private static func drawGeneric() {
        let ring = NSBezierPath(ovalIn: NSRect(x: 4.5, y: 3.5, width: 13, height: 13))
        ring.lineWidth = 1.6
        Theme.textMid.setStroke()
        ring.stroke()
    }

    // Cursor's mark, approximated as an isometric cube (hexagon outline + the
    // three near-corner edges). Placeholder-grade - refined when the Cursor
    // integration lands; enough to read as "Cursor" on the board.
    private static func drawCursor() {
        let c = CGPoint(x: 11, y: 10)
        let r: CGFloat = 6.5
        let dx = r * 0.866, dy = r * 0.5
        let top = CGPoint(x: c.x, y: c.y - r)
        let ur = CGPoint(x: c.x + dx, y: c.y - dy)
        let lr = CGPoint(x: c.x + dx, y: c.y + dy)
        let bot = CGPoint(x: c.x, y: c.y + r)
        let ll = CGPoint(x: c.x - dx, y: c.y + dy)
        let ul = CGPoint(x: c.x - dx, y: c.y - dy)

        let hex = NSBezierPath()
        hex.move(to: top)
        for p in [ur, lr, bot, ll, ul] { hex.line(to: p) }
        hex.close()
        hex.lineWidth = 1.5
        hex.lineJoinStyle = .round
        Theme.textMid.setStroke()
        hex.stroke()

        // The Y - three edges from the near corner (center) to alternating
        // vertices, giving the cube its faces.
        let y = NSBezierPath()
        for p in [top, lr, ll] { y.move(to: c); y.line(to: p) }
        y.lineWidth = 1.5
        y.lineCapStyle = .round
        Theme.textMid.setStroke()
        y.stroke()
    }

    // VS Code's folded-ribbon mark, hand-drawn (not the shipped asset, per the
    // task): a spine on the right with two flaps folding to a point at the
    // left, filled in VS Code blue. Recognizably VS Code without embedding
    // Microsoft's logo - the counterpart to drawCursor for vscode/<sub>.
    private static func drawVSCode() {
        let ribbon = NSBezierPath()
        let points: [CGPoint] = [
            CGPoint(x: 16.5, y: 2.5),   // spine top
            CGPoint(x: 16.5, y: 17.5),  // spine bottom
            CGPoint(x: 9.5, y: 12.3),   // lower inner fold
            CGPoint(x: 5.3, y: 15.2),   // lower flap, outer corner
            CGPoint(x: 3.6, y: 13.9),   // lower flap, tip
            CGPoint(x: 10.6, y: 10.0),  // centre fold
            CGPoint(x: 3.6, y: 6.1),    // upper flap, tip
            CGPoint(x: 5.3, y: 4.8),    // upper flap, outer corner
            CGPoint(x: 9.5, y: 7.7),    // upper inner fold
        ]
        ribbon.move(to: points[0])
        for p in points.dropFirst() { ribbon.line(to: p) }
        ribbon.close()
        ribbon.lineJoinStyle = .round
        Theme.vscode.setFill()
        ribbon.fill()
    }

    // A sub-agent glyph badged into the bottom-right corner over the host mark
    // (Cursor or VS Code) - for an agent hosted in that editor's terminal
    // (cursor/claude, vscode/claude etc).
    private static func drawBadge(_ sub: String) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        // Punch a clear halo so the badge reads as a separate mark, not part of
        // the cube's lines.
        ctx.saveGState()
        ctx.setBlendMode(.destinationOut)
        NSColor.black.setFill()
        NSBezierPath(ovalIn: NSRect(x: 11, y: 10, width: 12, height: 12)).fill()
        ctx.restoreGState()
        // Draw the sub glyph scaled into that corner.
        ctx.saveGState()
        ctx.translateBy(x: 10.5, y: 9.5)
        ctx.scaleBy(x: 0.5, y: 0.5)
        drawGlyph(sub)
        ctx.restoreGState()
    }
}

// The mock's working mark: a faint ring with a darker quarter-arc rotating at
// 0.9s/turn. Core Animation drives it so scrolling and timers stay out of it.
final class SpinnerMarkView: NSView {
    private let arcLayer = CAShapeLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        let side: CGFloat = s(11)
        let lineWidth: CGFloat = s(1.7)
        let circle = CGPath(
            ellipseIn: CGRect(x: 0, y: 0, width: side, height: side)
                .insetBy(dx: lineWidth / 2, dy: lineWidth / 2),
            transform: nil
        )

        let track = CAShapeLayer()
        track.frame = CGRect(x: 0, y: 0, width: side, height: side)
        track.path = circle
        track.fillColor = nil
        track.strokeColor = Theme.spinFaint.cgColor
        track.lineWidth = lineWidth
        layer?.addSublayer(track)

        arcLayer.frame = CGRect(x: 0, y: 0, width: side, height: side)
        arcLayer.path = circle
        arcLayer.fillColor = nil
        arcLayer.strokeColor = Theme.spinArc.cgColor
        arcLayer.lineWidth = lineWidth
        arcLayer.lineCap = .round
        arcLayer.strokeEnd = 0.25
        layer?.addSublayer(arcLayer)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var intrinsicContentSize: NSSize { NSSize(width: s(11), height: s(11)) }

    // Animations are dropped when the layer leaves the window; re-arm on attach.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        arcLayer.removeAnimation(forKey: "spin")
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.fromValue = 0
        spin.toValue = -2 * Double.pi
        spin.duration = 0.9
        spin.repeatCount = .infinity
        arcLayer.add(spin, forKey: "spin")
    }
}

// MARK: - Panel

// Borderless panels cannot become key unless they say so; key status without
// app activation is the whole point of the .nonactivatingPanel palette.
final class PalettePanel: NSPanel {
    var onKeyDown: ((NSEvent) -> Bool)?

    override var canBecomeKey: Bool { true }

    override func keyDown(with event: NSEvent) {
        // Swallow unhandled keys: a palette must never beep or type-select.
        _ = onKeyDown?(event)
    }
}

// The session list. Right-clicking a row builds a context menu for that row,
// the mouse-discoverable form of the keyboard row actions (pin/rename/hide/
// remove). Keys still belong to the panel (refusesFirstResponder), so this
// only adds the menu.
final class PaletteTableView: NSTableView {
    var onContextMenu: ((Int) -> NSMenu?)?

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        let clicked = row(at: point)
        guard clicked >= 0 else { return nil }
        return onContextMenu?(clicked)
    }
}

@MainActor
final class PaletteController: NSObject {
    private let rowsProvider: @MainActor () -> [PaletteRow]
    private let onJump: @MainActor (String) -> Void
    private let onHide: @MainActor (String) -> Void
    // Unhide a session (fires `show`), used by a click on a hidden row.
    private let onShow: @MainActor (String) -> Void
    private let onRemove: @MainActor (String) -> Void
    private let onLabel: @MainActor (String, String) -> Void
    // Desired pinned state (true = pin, false = unpin) for the given session.
    private let onPin: @MainActor (String, Bool) -> Void
    private let onSettings: @MainActor () -> Void

    // All rows from the provider, and the slice that survives the search
    // filter - every selection/cycle operation works on the filtered view.
    private var allRows: [PaletteRow] = []
    private var rows: [PaletteRow] = []
    // Leading count of selectable rows in `rows` - the visible sessions sit at
    // the front, then the Hidden divider and any hidden rows, which are inert.
    private var visibleCount = 0
    // Whether the Hidden section is expanded. A search reveals it regardless.
    private var hiddenExpanded = false
    private var query = ""
    private var panel: PalettePanel!
    private var tableView: NSTableView!
    private var emptyLabel: NSTextField!
    private var termLabel: NSTextField!
    private var actionRow: NSStackView!
    private var actionLabel: NSTextField!
    private var searchField: NSTextField!
    private var labelBar: NSView!
    private var labelField: NSTextField!
    // Typing goes to the search field (its field editor is first responder);
    // a local monitor intercepts the command keys (⌃j/⌃k/⌃x/⌃r/⌃1-9/⌃⌫,
    // arrows, tab, ↩, esc) before the field editor sees them.
    private var keyMonitor: Any?
    // The session being renamed; nil when the label editor is closed. Held by
    // key, not row index, so an SSE reload mid-edit cannot retarget the rename.
    private var labelEditingKey: String?
    private var tickTimer: Timer?
    private var spinIndex = 0

    // Working-state glyphs cycled once per second, matching the mock.
    private static let spinGlyphs = ["·", "✢", "✳", "∗", "✻", "✽"]

    // Mock geometry: 960-wide panel, 46pt header, 34pt footer, 430pt list -
    // reference values at 1.0×, multiplied by the current zoom.
    private static var panelSize: NSSize { NSSize(width: s(960), height: s(460)) }
    private static var headerHeight: CGFloat { s(46) }
    private static var footerHeight: CGFloat { s(34) }
    private static var listWidth: CGFloat { s(430) }
    private static var cornerRadius: CGFloat { s(16) }
    private static var rowHeight: CGFloat { s(47) }

    init(
        rowsProvider: @escaping @MainActor () -> [PaletteRow],
        onJump: @escaping @MainActor (String) -> Void,
        onHide: @escaping @MainActor (String) -> Void,
        onShow: @escaping @MainActor (String) -> Void,
        onRemove: @escaping @MainActor (String) -> Void,
        onLabel: @escaping @MainActor (String, String) -> Void,
        onPin: @escaping @MainActor (String, Bool) -> Void,
        onSettings: @escaping @MainActor () -> Void
    ) {
        self.rowsProvider = rowsProvider
        self.onJump = onJump
        self.onHide = onHide
        self.onShow = onShow
        self.onRemove = onRemove
        self.onLabel = onLabel
        self.onPin = onPin
        self.onSettings = onSettings
        super.init()
        buildPanel()
    }

    // MARK: - Show / hide

    func toggle() {
        if panel.isVisible { hide() } else { show() }
    }

    func show() {
        // Every open starts with an empty search (Raycast/Spotlight model).
        searchField.stringValue = ""
        query = ""
        reload(preservingSelection: false)
        restorePosition()
        startTicking()
        // Nonactivating panel takes key focus while the previous app stays
        // active - Spotlight's pattern. Never call NSApp.activate here.
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(searchField)
        if keyMonitor == nil {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                // Local monitors always fire on the main thread; NSEvent just
                // lacks a Sendable annotation to prove it, so only a Bool
                // (consumed or not) crosses the assumeIsolated boundary.
                nonisolated(unsafe) let event = event
                let consumed = MainActor.assumeIsolated {
                    self.map { $0.handleMonitoredKey(event) == nil } ?? false
                }
                return consumed ? nil : event
            }
        }
    }

    func hide() {
        guard panel.isVisible else { return }
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
        cancelLabelEdit()
        stopTicking()
        panel.orderOut(nil)
    }

    /// Called by the AppDelegate on every SSE-driven state change: both panes
    /// refresh (the preview re-renders from the reloaded selection).
    func reloadIfVisible() {
        guard panel.isVisible else { return }
        reload(preservingSelection: true)
    }

    // MARK: - Data

    private func reload(preservingSelection: Bool) {
        let previousKey = selectedKey()
        let previousIndex = tableView.selectedRow
        allRows = rowsProvider()
        rows = composeRows()
        tableView.reloadData()
        emptyLabel.stringValue = allRows.isEmpty ? "No sessions" : "No matches"
        emptyLabel.isHidden = !rows.isEmpty
        if rows.isEmpty {
            renderPreview()
            return
        }
        if preservingSelection,
           let previousKey,
           let index = rows.firstIndex(where: { $0.sessionKey == previousKey && !$0.isHidden && !$0.isDivider }) {
            // Never move the cursor under the user: follow the session_key
            // across reorders.
            select(index)
        } else if preservingSelection {
            // The selected row vanished (hidden or removed): land on the
            // round-robin next thing to deal with, else hold position.
            if let next = nextToCheckIndex() {
                select(next)
            } else if visibleCount > 0 {
                select(min(max(previousIndex, 0), visibleCount - 1))
            }
        } else if visibleCount > 0 {
            select(defaultSelectionIndex())
        }
        // selectRowIndexes only notifies on change; re-render explicitly so an
        // SSE update to the already-selected session reaches the preview.
        renderPreview()
    }

    // Preselect the topmost unread row (oldest-engaged was jarring at the
    // bottom of the list); with nothing needing you, the top row.
    private func defaultSelectionIndex() -> Int {
        nextToCheckIndex() ?? 0
    }

    // MARK: - Search

    // The filter matches what the row shows: name, prompt breadcrumb, agent.
    // A `#tag` query switches to tag mode - the discreet, no-new-UI way to
    // narrow the board to one tag (e.g. `#demo`); clearing it restores all.
    // Does a row survive the current search? An empty query matches everything;
    // a `#tag` query narrows to that tag.
    private func matchesQuery(_ row: PaletteRow) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return true }
        if q.hasPrefix("#") {
            let tag = String(q.dropFirst()).trimmingCharacters(in: .whitespaces)
            guard !tag.isEmpty else { return true }
            return row.tags.contains { $0.caseInsensitiveCompare(tag) == .orderedSame }
        }
        return row.name.localizedCaseInsensitiveContains(q)
            || (row.detail ?? "").localizedCaseInsensitiveContains(q)
            || (row.reply ?? "").localizedCaseInsensitiveContains(q)
            || row.agent.localizedCaseInsensitiveContains(q)
    }

    // The display rows: matching visible sessions first (the selectable span,
    // recorded in visibleCount), then a "Hidden (N)" divider and, when the
    // section is open or a search is running, the matching hidden rows. A search
    // reveals hidden matches so the board never hides what it knows about.
    private func composeRows() -> [PaletteRow] {
        let matching = allRows.filter { matchesQuery($0) }
        let visible = matching.filter { !$0.isHidden }
        let hidden = matching.filter { $0.isHidden }
        visibleCount = visible.count
        var display = visible
        // Always show the Hidden divider once the board has any session, even at
        // "Hidden (0)", so it is always clear whether a session is set aside (a
        // missing row is otherwise a mystery). A truly empty board shows the empty
        // state instead. A zero count is inert (no chevron, nothing to expand).
        if !matching.isEmpty {
            var divider = PaletteRow(
                sessionKey: "", mark: .working, statusWord: "", isAsking: false,
                isUnread: false, isRead: false, agent: "", name: "", ageStart: Date(),
                detail: nil, reply: nil, location: "", needsCheck: false,
                engagedDate: Date(), tags: [], pinned: false
            )
            divider.isDivider = true
            divider.hiddenCount = hidden.count
            display.append(divider)
            let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
            if !hidden.isEmpty && (hiddenExpanded || searching) { display.append(contentsOf: hidden) }
        }
        return display
    }

    // Query changes reset the cursor to the topmost unread within the
    // filtered rows - searching is re-asking "what needs me in here".
    private func applyQuery(_ newQuery: String) {
        query = newQuery
        rows = composeRows()
        tableView.reloadData()
        emptyLabel.stringValue = allRows.isEmpty ? "No sessions" : "No matches"
        emptyLabel.isHidden = !rows.isEmpty
        if visibleCount > 0 { select(defaultSelectionIndex()) }
        renderPreview()
    }

    private func clearQuery() {
        searchField.stringValue = ""
        applyQuery("")
    }

    // "Next to check": the first unread row from the top - reading order, so
    // where the cursor lands is always where the eye already is.
    private func nextToCheckIndex(excluding key: String? = nil) -> Int? {
        rows.indices.first {
            rows[$0].needsCheck && !rows[$0].isHidden && !rows[$0].isDivider
                && rows[$0].sessionKey != key
        }
    }

    private func selectedKey() -> String? {
        let index = tableView.selectedRow
        guard rows.indices.contains(index), !rows[index].isHidden, !rows[index].isDivider else { return nil }
        return rows[index].sessionKey
    }

    // Selection only ever lands on a visible session row (the leading span);
    // the Hidden divider and hidden rows are inert.
    private func select(_ index: Int) {
        guard index >= 0, index < visibleCount, rows.indices.contains(index) else { return }
        tableView.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        tableView.scrollRowToVisible(index)
    }

    // MARK: - Live ticking

    // The mock's ages, spinner glyph, and Working… runtime advance every
    // second; one timer drives all three, and only while the panel shows.
    private func startTicking() {
        stopTicking()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func stopTicking() {
        tickTimer?.invalidate()
        tickTimer = nil
    }

    private func tick() {
        spinIndex = (spinIndex + 1) % Self.spinGlyphs.count
        let now = Date()
        tableView.enumerateAvailableRowViews { rowView, _ in
            (rowView.view(atColumn: 0) as? SessionCellView)?.tick(now: now)
        }
        // Only the working preview shows a moving glyph/runtime; static
        // previews would just re-render identically.
        let index = tableView.selectedRow
        if rows.indices.contains(index), rows[index].mark == .working {
            renderPreview(now: now)
        }
    }

    // MARK: - Keys

    // Typing is searching, so list commands take ⌃ (⌃j/⌃k/⌃1-9/⌃r/⌃x/⌃⌫);
    // arrows, tab, ↩ and esc stay bare. Anything unhandled falls through to
    // the search field's editor. Returns nil when the event was consumed.
    private func handleMonitoredKey(_ event: NSEvent) -> NSEvent? {
        guard event.window === panel else { return event }
        // While the label editor is up its field delegate owns ↩/esc; the
        // list must not react underneath the rename.
        guard labelEditingKey == nil else { return event }
        let ctrl = event.modifierFlags.contains(.control)
        switch event.keyCode {
        case 53: // esc clears the search first; a second esc closes
            if query.isEmpty { hide() } else { clearQuery() }
            return nil
        case 36, 76: jumpSelected(); return nil // return / keypad enter
        case 48: cycleNeedsCheck(); return nil // tab
        case 51 where ctrl: removeSelected(); return nil // ⌃⌫ (bare ⌫ edits the search)
        case 125: moveSelection(1); return nil // down arrow
        case 126: moveSelection(-1); return nil // up arrow
        default: break
        }
        // Bare-⌘ commands: ⌘, settings (the macOS convention, mirroring the
        // footer cog) and ⌘+/⌘−/⌘0 zoom. ⌃/⌥ combinations fall through so
        // they cannot shadow other bindings.
        if event.modifierFlags.contains(.command),
           !event.modifierFlags.contains(.control),
           !event.modifierFlags.contains(.option),
           let chars = event.charactersIgnoringModifiers {
            switch chars {
            case ",":
                settingsClicked()
                return nil
            // "=" is the +/= key unshifted - ⌘= must zoom in like ⌘+.
            case "=", "+":
                setZoom(PaletteScale.current + PaletteScale.step)
                return nil
            case "-":
                setZoom(PaletteScale.current - PaletteScale.step)
                return nil
            case "0":
                setZoom(1.0)
                return nil
            default:
                break
            }
        }
        guard ctrl, let chars = event.charactersIgnoringModifiers else { return event }
        switch chars {
        case "j": moveSelection(1)
        case "k": moveSelection(-1)
        case "x": hideSelected()
        case "r": beginLabelEdit()
        case "p": togglePinSelected()
        default:
            guard let digit = Int(chars), (1...9).contains(digit), digit <= visibleCount else {
                return event
            }
            jumpRow(digit - 1)
        }
        return nil
    }

    private func moveSelection(_ delta: Int) {
        guard visibleCount > 0 else { return }
        let current = tableView.selectedRow
        let base = (current >= 0 && current < visibleCount) ? current : 0
        select(min(max(base + delta, 0), visibleCount - 1))
    }

    // Tab cycles unread rows in list order, top to bottom - same reading
    // order as the topmost-unread default selection.
    private func cycleNeedsCheck() {
        let cycle = rows.indices.filter { rows[$0].needsCheck && !rows[$0].isHidden && !rows[$0].isDivider }
        guard !cycle.isEmpty else { return }
        if let position = cycle.firstIndex(of: tableView.selectedRow) {
            select(cycle[(position + 1) % cycle.count])
        } else {
            select(cycle[0])
        }
    }

    private func jumpSelected() {
        jumpRow(tableView.selectedRow)
    }

    private func jumpRow(_ index: Int) {
        guard rows.indices.contains(index), !rows[index].isDivider, !rows[index].isHidden else { return }
        hide()
        onJump(rows[index].sessionKey)
    }

    private func hideSelected() {
        guard let key = selectedKey() else { return }
        onHide(key)
        parkSelection(leaving: key)
    }

    private func removeSelected() {
        guard let key = selectedKey() else { return }
        onRemove(key)
        parkSelection(leaving: key)
    }

    // ⌃P / context menu: toggle the pin. Fires optimistically; the hub echoes
    // pin/unpin over SSE (mark updates) and returns pinned-first order on the
    // next /state, so the row keeps its slot until that resync.
    private func togglePinSelected() {
        guard let key = selectedKey(),
              let index = rows.firstIndex(where: { $0.sessionKey == key }) else { return }
        onPin(key, !rows[index].pinned)
    }

    // MARK: - Right-click context menu

    // Right-click exposes the keyboard row actions to the mouse. The clicked
    // row is selected first so the menu items (which act on the selection) and
    // the keyboard bindings always target the same row.
    private func contextMenu(forRow row: Int) -> NSMenu? {
        guard rows.indices.contains(row) else { return nil }
        // The Hidden divider has no menu; a hidden row offers only Unhide.
        if rows[row].isDivider { return nil }
        if rows[row].isHidden {
            let menu = NSMenu()
            let item = NSMenuItem(title: "Unhide", action: #selector(contextUnhide(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = rows[row].sessionKey
            menu.addItem(item)
            return menu
        }
        select(row)
        renderPreview()
        let menu = NSMenu()
        func add(_ title: String, _ action: Selector) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        add(rows[row].pinned ? "Unpin" : "Pin", #selector(contextPin))
        add("Rename…", #selector(contextRename))
        menu.addItem(.separator())
        add("Hide", #selector(contextHide))
        add("Remove", #selector(contextRemove))
        return menu
    }

    @objc private func contextPin() { togglePinSelected() }

    @objc private func contextUnhide(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        onShow(key)
    }
    @objc private func contextRename() { beginLabelEdit() }
    @objc private func contextHide() { hideSelected() }
    @objc private func contextRemove() { removeSelected() }

    // Move ahead of the SSE round trip: the acted-on row is dealt with
    // (vanishing, or staying as a seen busy row) and the cursor should
    // already sit on the next thing to deal with.
    private func parkSelection(leaving key: String) {
        if let next = nextToCheckIndex(excluding: key) {
            select(next)
            return
        }
        let index = tableView.selectedRow
        let candidates = rows.indices.filter { rows[$0].sessionKey != key }
        if let next = candidates.first(where: { $0 > index }) ?? candidates.last {
            select(next)
        }
    }

    // MARK: - Zoom (⌘+ / ⌘− / ⌘0)

    private func setZoom(_ value: CGFloat) {
        let clamped = PaletteScale.clamp(value)
        guard abs(clamped - PaletteScale.current) > 0.001 else { return }
        PaletteScale.set(clamped)
        // Rebuild outside the key-monitor callback - the rebuild removes and
        // re-registers that very monitor.
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.rebuildPanel() }
        }
    }

    // Geometry and fonts are baked in at construction, so a zoom change
    // rebuilds the panel wholesale and re-shows it like a fresh open (search
    // reset included) - simpler than re-threading every metric live.
    private func rebuildPanel() {
        let wasVisible = panel.isVisible
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
        stopTicking()
        labelEditingKey = nil
        // Detach the delegate first: orderOut resigns key, and the resign-key
        // hide would fight the re-show.
        panel.delegate = nil
        panel.orderOut(nil)
        panel.close()
        buildPanel()
        if wasVisible { show() }
    }

    // Mock interaction: single click selects (the preview is the payoff);
    // double click jumps. Enter remains the primary jump.
    @objc private func rowDoubleClicked(_ sender: Any?) {
        jumpRow(tableView.clickedRow)
    }

    // Single click: the Hidden divider toggles the section open/closed; a hidden
    // row unhides (fires `show`). Clicks on visible rows fall through to normal
    // selection.
    @objc private func rowClicked(_ sender: Any?) {
        let index = tableView.clickedRow
        guard rows.indices.contains(index) else { return }
        let row = rows[index]
        if row.isDivider {
            // "Hidden (0)" has nothing to expand.
            guard row.hiddenCount > 0 else { return }
            hiddenExpanded.toggle()
            reload(preservingSelection: true)
        } else if row.isHidden {
            onShow(row.sessionKey)
        }
    }

    // MARK: - Label editing (`r`)

    // `r` opens an inline editor over the footer: type a signalbox display
    // label for the selected session (this is signalbox's own name, not the
    // agent's /rename - there is no reverse channel). Enter fires
    // `signalbox label`; empty text clears back to the agent title; Esc cancels.
    private func beginLabelEdit() {
        guard let key = selectedKey(), let index = rows.firstIndex(where: { $0.sessionKey == key })
        else { return }
        labelEditingKey = key
        labelField.stringValue = rows[index].name
        labelBar.isHidden = false
        panel.makeFirstResponder(labelField)
        // Select-all so typing replaces the prefilled name outright.
        labelField.currentEditor()?.selectAll(nil)
    }

    private func commitLabelEdit() {
        guard let key = labelEditingKey else { return }
        let text = labelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        endLabelEdit()
        // Empty commits too: it is the documented way to clear a label. The
        // hub echoes the label event over SSE and every surface re-renders.
        onLabel(key, text)
    }

    private func cancelLabelEdit() {
        guard labelEditingKey != nil else { return }
        endLabelEdit()
    }

    private func endLabelEdit() {
        labelEditingKey = nil
        labelBar.isHidden = true
        labelField.stringValue = ""
        // Hand the keyboard back to the search field so typing filters again.
        panel.makeFirstResponder(searchField)
    }

    // MARK: - Panel construction

    private func buildPanel() {
        let panel = PalettePanel(
            contentRect: NSRect(origin: .zero, size: Self.panelSize),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered,
            defer: true
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        // Draggable like Alfred/Raycast: grab any background area to move it,
        // and the position is remembered across opens (restorePosition). The
        // search and rename fields handle their own mouse, so dragging inside
        // them selects text rather than moving the panel.
        panel.isMovable = true
        panel.isMovableByWindowBackground = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .utilityWindow
        // The mock is dark-only; forcing dark keeps AppKit-provided chrome
        // (scrollers, symbol images) consistent with the fixed theme colors.
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.delegate = self
        // Fallback only: the local monitor handles keys while the search
        // field is first responder; this swallows strays so the panel never
        // beeps or type-selects.
        panel.onKeyDown = { _ in true }

        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = Theme.panelBG.cgColor
        root.layer?.cornerRadius = Self.cornerRadius
        root.layer?.borderWidth = 1
        root.layer?.borderColor = Theme.panelBorder.cgColor
        root.layer?.masksToBounds = true
        panel.contentView = root

        let header = buildHeader()
        let footer = buildFooter()
        let body = buildBody()
        let labelBar = buildLabelBar()
        for view in [header, body, footer, labelBar] {
            view.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(view)
        }
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: Self.headerHeight),
            body.topAnchor.constraint(equalTo: header.bottomAnchor),
            body.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            body.bottomAnchor.constraint(equalTo: footer.topAnchor),
            footer.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            footer.heightAnchor.constraint(equalToConstant: Self.footerHeight),
            // The label editor covers the footer while renaming - same slot,
            // no layout jump.
            labelBar.leadingAnchor.constraint(equalTo: footer.leadingAnchor),
            labelBar.trailingAnchor.constraint(equalTo: footer.trailingAnchor),
            labelBar.topAnchor.constraint(equalTo: footer.topAnchor),
            labelBar.bottomAnchor.constraint(equalTo: footer.bottomAnchor),
        ])

        self.panel = panel
    }

    // The rename editor: a footer-sized bar with a "Rename:" prompt and a
    // borderless field. Hidden until `r`.
    private func buildLabelBar() -> NSView {
        let bar = NSView()
        bar.wantsLayer = true
        // Opaque over the footer keys so the two never read as one line.
        bar.layer?.backgroundColor = Theme.panelBG.cgColor
        bar.isHidden = true

        let prompt = NSTextField(labelWithString: "Rename:")
        prompt.font = .systemFont(ofSize: s(11), weight: .semibold)
        prompt.textColor = Theme.textMid

        let field = NSTextField(string: "")
        field.font = .systemFont(ofSize: s(12))
        field.textColor = Theme.titleUnread
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.placeholderAttributedString = NSAttributedString(
            string: "session label - empty clears, ↩ saves, esc cancels",
            attributes: [
                .font: NSFont.systemFont(ofSize: s(12)),
                .foregroundColor: Theme.textDim,
            ]
        )
        field.delegate = self

        let border = Self.hairlineView()
        for view in [prompt, field, border] {
            view.translatesAutoresizingMaskIntoConstraints = false
            bar.addSubview(view)
        }
        NSLayoutConstraint.activate([
            prompt.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: s(20)),
            prompt.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            field.leadingAnchor.constraint(equalTo: prompt.trailingAnchor, constant: s(8)),
            field.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -s(20)),
            field.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            border.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
            border.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
            border.topAnchor.constraint(equalTo: bar.topAnchor),
        ])

        self.labelBar = bar
        self.labelField = field
        return bar
    }

    private func buildHeader() -> NSView {
        let header = NSView()

        let brandGlyph = BrandGlyphView()
        let brandLabel = NSTextField(labelWithString: "signalbox")
        brandLabel.font = .systemFont(ofSize: s(13), weight: .semibold)
        brandLabel.textColor = Theme.textMid
        let brand = NSStackView(views: [brandGlyph, brandLabel])
        brand.orientation = .horizontal
        brand.spacing = s(8)
        brand.alignment = .centerY

        func verb(_ text: String) -> NSTextField {
            let label = NSTextField(labelWithString: text)
            label.font = .systemFont(ofSize: s(12))
            label.textColor = Theme.textMid
            return label
        }
        let verbs = NSStackView(views: [verb("Jump"), Self.keycap("↩")])
        verbs.orientation = .horizontal
        verbs.spacing = s(10)
        verbs.alignment = .centerY

        // The search bar: always focused, type-to-filter (Raycast model).
        let search = NSTextField(string: "")
        search.font = .systemFont(ofSize: s(13))
        search.textColor = Theme.titleUnread
        search.isBordered = false
        search.drawsBackground = false
        search.focusRingType = .none
        search.placeholderAttributedString = NSAttributedString(
            string: "Search sessions…",
            attributes: [
                .font: NSFont.systemFont(ofSize: s(13)),
                .foregroundColor: Theme.textDim,
            ]
        )
        search.delegate = self

        let border = Self.hairlineView()
        for view in [brand, search, verbs, border] {
            view.translatesAutoresizingMaskIntoConstraints = false
            header.addSubview(view)
        }
        NSLayoutConstraint.activate([
            brand.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: s(20)),
            brand.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            search.leadingAnchor.constraint(equalTo: brand.trailingAnchor, constant: s(16)),
            search.trailingAnchor.constraint(equalTo: verbs.leadingAnchor, constant: -s(16)),
            search.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            verbs.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -s(20)),
            verbs.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            border.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            border.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            border.bottomAnchor.constraint(equalTo: header.bottomAnchor),
        ])

        self.searchField = search
        return header
    }

    private func buildFooter() -> NSView {
        let footer = NSView()
        let label = NSTextField(
            labelWithString:
                "type to search  ·  ⌃j/⌃k move  ·  ⌃1-9 direct  ·  tab next unread  ·  ⌃p pin  ·  ⌃r rename  ·  ⌃x hide  ·  ⌃⌫ remove  ·  ↩ jump  ·  esc clear/close"
        )
        label.font = .systemFont(ofSize: s(10.5))
        label.textColor = Theme.textDim
        label.alignment = .center

        // Settings cog, bottom-right - the launcher convention (Raycast). Opens
        // the Settings window and closes the palette.
        let gear = NSButton()
        gear.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: "Settings")?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: s(13), weight: .regular))
        gear.imagePosition = .imageOnly
        gear.isBordered = false
        gear.contentTintColor = Theme.textDim
        gear.target = self
        gear.action = #selector(settingsClicked)
        gear.toolTip = "Settings (⌘,)"

        let border = Self.hairlineView()
        for view in [label, gear, border] {
            view.translatesAutoresizingMaskIntoConstraints = false
            footer.addSubview(view)
        }
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: footer.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
            gear.trailingAnchor.constraint(equalTo: footer.trailingAnchor, constant: -s(16)),
            gear.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
            border.leadingAnchor.constraint(equalTo: footer.leadingAnchor),
            border.trailingAnchor.constraint(equalTo: footer.trailingAnchor),
            border.topAnchor.constraint(equalTo: footer.topAnchor),
        ])
        return footer
    }

    @objc private func settingsClicked() {
        hide()
        onSettings()
    }

    private func buildBody() -> NSView {
        let body = NSView()

        // LEFT: session list under a "SESSIONS" heading, mock metrics.
        let list = NSView()
        let heading = NSTextField(labelWithString: "SESSIONS")
        heading.font = .systemFont(ofSize: s(10), weight: .semibold)
        heading.textColor = Theme.textDim
        heading.attributedStringValue = NSAttributedString(string: "SESSIONS", attributes: [
            .font: NSFont.systemFont(ofSize: s(10), weight: .semibold),
            .foregroundColor: Theme.textDim,
            .kern: s(1.5),
        ])

        let table = PaletteTableView()
        table.onContextMenu = { [weak self] row in self?.contextMenu(forRow: row) }
        table.headerView = nil
        table.rowHeight = Self.rowHeight
        table.style = .fullWidth
        table.backgroundColor = .clear
        table.intercellSpacing = .zero
        table.allowsMultipleSelection = false
        // Keys stay with the panel itself so one keyDown handles j/k/enter/
        // digits/tab/x/⌫ without fighting NSTableView's own key handling.
        table.refusesFirstResponder = true
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("session"))
        column.width = Self.listWidth
        table.addTableColumn(column)
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(rowClicked(_:))
        table.doubleAction = #selector(rowDoubleClicked(_:))

        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false

        let empty = NSTextField(labelWithString: "No sessions")
        empty.font = .systemFont(ofSize: s(13))
        empty.textColor = Theme.textDim
        empty.isHidden = true

        let listBorder = NSView()
        listBorder.wantsLayer = true
        listBorder.layer?.backgroundColor = Theme.hairline.cgColor

        for view in [heading, scroll, empty, listBorder] {
            view.translatesAutoresizingMaskIntoConstraints = false
            list.addSubview(view)
        }
        NSLayoutConstraint.activate([
            heading.topAnchor.constraint(equalTo: list.topAnchor, constant: s(20)),
            heading.leadingAnchor.constraint(equalTo: list.leadingAnchor, constant: s(24)),
            scroll.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: s(8)),
            scroll.leadingAnchor.constraint(equalTo: list.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: list.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: list.bottomAnchor, constant: -s(12)),
            empty.centerXAnchor.constraint(equalTo: list.centerXAnchor),
            empty.centerYAnchor.constraint(equalTo: list.centerYAnchor),
            listBorder.trailingAnchor.constraint(equalTo: list.trailingAnchor),
            listBorder.topAnchor.constraint(equalTo: list.topAnchor),
            listBorder.bottomAnchor.constraint(equalTo: list.bottomAnchor),
            listBorder.widthAnchor.constraint(equalToConstant: 1),
        ])

        // RIGHT: the terminal-styled last exchange plus the action line. No
        // preview title - the location lives in the action line (contract v4).
        // Full black, like the terminal it is quoting - the pane reads as a
        // window into the session, not more panel chrome.
        let preview = NSView()
        preview.wantsLayer = true
        preview.layer?.backgroundColor = Theme.terminalBG.cgColor
        let term = NSTextField(wrappingLabelWithString: "")
        term.isSelectable = false
        term.preferredMaxLayoutWidth =
            Self.panelSize.width - Self.listWidth - s(44)

        let keycap = Self.keycap("↩", fontSize: 10.5)
        let action = NSTextField(labelWithString: "")
        action.font = .systemFont(ofSize: s(11))
        action.textColor = Theme.textDim
        action.lineBreakMode = .byTruncatingTail
        let actionRow = NSStackView(views: [keycap, action])
        actionRow.orientation = .horizontal
        actionRow.spacing = s(6)
        actionRow.alignment = .centerY

        for view in [term, actionRow] {
            view.translatesAutoresizingMaskIntoConstraints = false
            preview.addSubview(view)
        }
        NSLayoutConstraint.activate([
            term.topAnchor.constraint(equalTo: preview.topAnchor, constant: s(18)),
            term.leadingAnchor.constraint(equalTo: preview.leadingAnchor, constant: s(22)),
            term.trailingAnchor.constraint(lessThanOrEqualTo: preview.trailingAnchor, constant: -s(22)),
            actionRow.topAnchor.constraint(equalTo: term.bottomAnchor, constant: s(16)),
            actionRow.leadingAnchor.constraint(equalTo: preview.leadingAnchor, constant: s(22)),
            actionRow.trailingAnchor.constraint(lessThanOrEqualTo: preview.trailingAnchor, constant: -s(22)),
        ])

        for view in [list, preview] {
            view.translatesAutoresizingMaskIntoConstraints = false
            body.addSubview(view)
        }
        NSLayoutConstraint.activate([
            list.leadingAnchor.constraint(equalTo: body.leadingAnchor),
            list.topAnchor.constraint(equalTo: body.topAnchor),
            list.bottomAnchor.constraint(equalTo: body.bottomAnchor),
            list.widthAnchor.constraint(equalToConstant: Self.listWidth),
            preview.leadingAnchor.constraint(equalTo: list.trailingAnchor),
            preview.trailingAnchor.constraint(equalTo: body.trailingAnchor),
            preview.topAnchor.constraint(equalTo: body.topAnchor),
            preview.bottomAnchor.constraint(equalTo: body.bottomAnchor),
        ])

        self.tableView = table
        self.emptyLabel = empty
        self.termLabel = term
        self.actionRow = actionRow
        self.actionLabel = action
        return body
    }

    private static func hairlineView() -> NSView {
        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = Theme.hairline.cgColor
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return line
    }

    // The mock's <kbd>: dark cap, hairline border, mono glyph.
    static func keycap(_ text: String, fontSize: CGFloat = 11) -> NSView {
        let cap = NSView()
        cap.wantsLayer = true
        cap.layer?.backgroundColor = Theme.keycapBG.cgColor
        cap.layer?.borderColor = Theme.keycapBorder.cgColor
        cap.layer?.borderWidth = 1
        cap.layer?.cornerRadius = s(4)
        let label = NSTextField(labelWithString: text)
        label.font = .monospacedSystemFont(ofSize: s(fontSize), weight: .regular)
        label.textColor = Theme.keycapText
        label.translatesAutoresizingMaskIntoConstraints = false
        cap.addSubview(label)
        cap.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: cap.leadingAnchor, constant: s(6)),
            label.trailingAnchor.constraint(equalTo: cap.trailingAnchor, constant: -s(6)),
            label.topAnchor.constraint(equalTo: cap.topAnchor, constant: 1),
            label.bottomAnchor.constraint(equalTo: cap.bottomAnchor, constant: -1),
        ])
        return cap
    }

    // MARK: - Preview rendering

    private func renderPreview(now: Date = Date()) {
        let index = tableView.selectedRow
        guard rows.indices.contains(index) else {
            termLabel.attributedStringValue = NSAttributedString()
            actionRow.isHidden = true
            return
        }
        let row = rows[index]
        actionRow.isHidden = false

        let mono = NSFont.monospacedSystemFont(ofSize: s(11.5), weight: .regular)
        let text = NSMutableAttributedString()

        // "❯ <prompt>" - the user's half of the exchange, dim.
        let prompt = (row.detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !prompt.isEmpty {
            let promptStyle = NSMutableParagraphStyle()
            promptStyle.minimumLineHeight = s(20)
            promptStyle.maximumLineHeight = s(20)
            promptStyle.paragraphSpacing = s(12)
            promptStyle.lineBreakMode = .byWordWrapping
            text.append(NSAttributedString(string: "❯ ", attributes: [
                .font: mono, .foregroundColor: Theme.caret, .paragraphStyle: promptStyle,
            ]))
            text.append(NSAttributedString(string: "\(prompt)\n", attributes: [
                .font: mono, .foregroundColor: Theme.promptText, .paragraphStyle: promptStyle,
            ]))
        }

        // Hanging indent so wrapped reply lines align after the bullet,
        // matching the mock's flex row.
        let bodyStyle = NSMutableParagraphStyle()
        bodyStyle.minimumLineHeight = s(20)
        bodyStyle.maximumLineHeight = s(20)
        bodyStyle.lineBreakMode = .byWordWrapping
        bodyStyle.headIndent = s(16)
        bodyStyle.tabStops = [NSTextTab(textAlignment: .left, location: s(16))]

        if row.mark == .working {
            let runtime = ageString(from: row.ageStart, to: now)
            let glyph = Self.spinGlyphs[spinIndex]
            text.append(NSAttributedString(string: "\(glyph)\tWorking… (\(runtime))", attributes: [
                .font: mono, .foregroundColor: Theme.amber, .paragraphStyle: bodyStyle,
            ]))
        } else if let reply = row.reply?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !reply.isEmpty {
            // Bullet color is the temperature: amber = ask, blue = output
            // updated, dim = read, red = failed (amber scheme).
            let bulletColor: NSColor
            let bodyColor: NSColor
            if row.mark == .failed {
                bulletColor = .systemRed
                bodyColor = Theme.replyText
            } else if row.isAsking {
                bulletColor = Theme.attention
                bodyColor = Theme.replyText
            } else if row.isRead {
                bulletColor = Theme.caret
                bodyColor = Theme.readText
            } else {
                bulletColor = Theme.accent
                bodyColor = Theme.replyText
            }
            text.append(NSAttributedString(string: "●\t", attributes: [
                .font: mono, .foregroundColor: bulletColor, .paragraphStyle: bodyStyle,
            ]))
            text.append(NSAttributedString(string: reply, attributes: [
                .font: mono, .foregroundColor: bodyColor, .paragraphStyle: bodyStyle,
            ]))
        }
        termLabel.attributedStringValue = text

        // Action line: "↩ <where>", plus the ask marker in amber - the same
        // temperature as the row's mark.
        let action = NSMutableAttributedString(string: row.location, attributes: [
            .font: NSFont.systemFont(ofSize: s(11)), .foregroundColor: Theme.textDim,
        ])
        if row.isAsking {
            action.append(NSAttributedString(string: " · ", attributes: [
                .font: NSFont.systemFont(ofSize: s(11)), .foregroundColor: Theme.textDim,
            ]))
            action.append(NSAttributedString(string: "needs your input", attributes: [
                .font: NSFont.systemFont(ofSize: s(11), weight: .semibold),
                .foregroundColor: Theme.attention,
            ]))
        }
        actionLabel.attributedStringValue = action
    }

    // The remembered panel origin (bottom-left, screen coordinates). A dragged
    // position should survive both reopening and app relaunches.
    private static let frameOriginKey = "paletteFrameOrigin"

    // Restore the dragged position if it is still reachable, else center. A
    // remembered origin can fall offscreen when a display is unplugged, so the
    // header (drag handle and search) must land on some screen's visible area.
    private func restorePosition() {
        guard let saved = UserDefaults.standard.string(forKey: Self.frameOriginKey) else {
            position()
            return
        }
        let origin = NSPointFromString(saved)
        let frame = NSRect(origin: origin, size: panel.frame.size)
        let header = NSPoint(x: frame.midX, y: frame.maxY - Self.headerHeight / 2)
        let reachable = NSScreen.screens.contains { NSMouseInRect(header, $0.visibleFrame, false) }
        if reachable {
            panel.setFrameOrigin(origin)
        } else {
            // Stale offscreen origin (screen change): recenter and forget it.
            UserDefaults.standard.removeObject(forKey: Self.frameOriginKey)
            position()
        }
    }

    private func savePosition() {
        UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: Self.frameOriginKey)
    }

    private func position() {
        // Summon onto the screen the user is looking at: the one with the mouse.
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
            ?? NSScreen.main
        guard let screen else { return }
        let visible = screen.visibleFrame
        let size = panel.frame.size
        let x = visible.midX - size.width / 2
        // Spotlight-style placement: panel top sits a sixth of the way down,
        // keeping the list in the top third of the screen.
        let top = visible.maxY - visible.height / 6
        let y = max(visible.minY, top - size.height)
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

// Selection is the mock's rounded #2C2C31 pill, inset to the row margins -
// never AppKit's accent-colored bar.
private final class PaletteRowView: NSTableRowView {
    override var isEmphasized: Bool {
        get { true }
        set {}
    }

    override func drawSelection(in dirtyRect: NSRect) {
        Theme.selection.setFill()
        NSBezierPath(
            roundedRect: bounds.insetBy(dx: s(10), dy: 0), xRadius: s(9), yRadius: s(9)
        ).fill()
    }
}

// MARK: - Hidden divider

// The "Hidden (N)" row: a dim count, always shown so it is clear whether a
// session is set aside. With a count it carries a disclosure chevron and toggles
// the section (rowClicked); at "Hidden (0)" it is inert - no chevron, nothing to
// expand.
private final class HiddenDividerView: NSView {
    init(count: Int, expanded: Bool) {
        super.init(frame: .zero)
        let label = NSTextField(labelWithString: "Hidden (\(count))")
        label.font = .systemFont(ofSize: s(12), weight: .medium)
        label.textColor = Theme.textDim
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)

        if count == 0 {
            // No chevron: nothing to expand.
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: s(20)),
                label.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
            return
        }

        let chevron = NSImageView()
        chevron.image = NSImage(
            systemSymbolName: expanded ? "chevron.down" : "chevron.right",
            accessibilityDescription: expanded ? "Collapse hidden" : "Expand hidden"
        )
        chevron.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: s(10), weight: .semibold)
        chevron.contentTintColor = Theme.textDim
        chevron.translatesAutoresizingMaskIntoConstraints = false
        addSubview(chevron)

        NSLayoutConstraint.activate([
            chevron.leadingAnchor.constraint(equalTo: leadingAnchor, constant: s(20)),
            chevron.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(equalTo: chevron.trailingAnchor, constant: s(9)),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - Table data source / delegate

extension PaletteController: NSTableViewDataSource, NSTableViewDelegate {
    func numberOfRows(in tableView: NSTableView) -> Int {
        rows.count
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        PaletteRowView()
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row index: Int) -> NSView? {
        guard rows.indices.contains(index) else { return nil }
        let row = rows[index]
        if row.isDivider {
            return HiddenDividerView(count: row.hiddenCount, expanded: hiddenExpanded)
        }
        let cell = SessionCellView(row: row)
        // Hidden rows read as dismissed: dimmed, and inert (see shouldSelectRow).
        cell.alphaValue = row.isHidden ? 0.45 : 1
        return cell
    }

    // Only visible session rows select. The Hidden divider and hidden rows are
    // inert to selection and the keyboard; a click on them is handled separately.
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        row < visibleCount
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        // The right pane follows the cursor: every selection move re-renders
        // the exchange preview.
        renderPreview()
    }
}

// MARK: - Session cell

// Layout per the mock row: [mark 14][glyph 22][title + breadcrumb][pill/age],
// 10pt gaps, inside a 10pt row margin + 10pt padding.
private final class SessionCellView: NSTableCellView {
    private static var markCenterX: CGFloat { s(27) } // 20 content start + 14/2
    private static var glyphCenterX: CGFloat { s(55) } // 20 + 14 + 10 + 22/2
    private static var textLeading: CGFloat { s(76) } // 20 + 14 + 10 + 22 + 10

    private let row: PaletteRow
    private let titleLabel = NSTextField(labelWithString: "")
    private let ageLabel = NSTextField(labelWithString: "")

    init(row: PaletteRow) {
        self.row = row
        super.init(frame: .zero)
        build()
        applyColors()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    // Selection turns the title white (mock: .row.sel .t) - marks, pill and
    // age keep their colors on the #2C2C31 selection pill.
    override var backgroundStyle: NSView.BackgroundStyle {
        didSet { applyColors() }
    }

    func tick(now: Date) {
        ageLabel.stringValue = ageString(from: row.ageStart, to: now)
    }

    private func build() {
        let mark = makeMarkView()
        mark.translatesAutoresizingMaskIntoConstraints = false
        addSubview(mark)

        let glyph = AgentGlyphView(agent: row.agent)
        glyph.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glyph)

        titleLabel.font = .systemFont(ofSize: s(13), weight: row.isUnread ? .bold : .regular)
        titleLabel.stringValue = row.name
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.maximumNumberOfLines = 1
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        addSubview(titleLabel)

        ageLabel.font = .monospacedDigitSystemFont(ofSize: s(11), weight: .semibold)
        ageLabel.textColor = Theme.age
        ageLabel.stringValue = ageString(from: row.ageStart)
        ageLabel.alignment = .right

        // No "?" pill: the amber mark alone carries the ask (amber scheme). A
        // pinned row gets a quiet pin just left of the age.
        let right = NSStackView()
        right.orientation = .horizontal
        right.alignment = .centerY
        right.spacing = s(5)
        if row.pinned {
            let pin = NSImageView()
            let config = NSImage.SymbolConfiguration(pointSize: s(9), weight: .semibold)
            pin.image = NSImage(systemSymbolName: "pin.fill", accessibilityDescription: "Pinned")?
                .withSymbolConfiguration(config)
            pin.contentTintColor = Theme.textDim
            right.addArrangedSubview(pin)
        }
        right.addArrangedSubview(ageLabel)
        right.translatesAutoresizingMaskIntoConstraints = false
        right.setContentHuggingPriority(.required, for: .horizontal)
        right.setContentCompressionResistancePriority(.required, for: .horizontal)
        addSubview(right)

        NSLayoutConstraint.activate([
            mark.centerXAnchor.constraint(equalTo: leadingAnchor, constant: Self.markCenterX),
            mark.centerYAnchor.constraint(equalTo: centerYAnchor),
            glyph.centerXAnchor.constraint(equalTo: leadingAnchor, constant: Self.glyphCenterX),
            glyph.centerYAnchor.constraint(equalTo: centerYAnchor),
            glyph.widthAnchor.constraint(equalToConstant: s(22)),
            glyph.heightAnchor.constraint(equalToConstant: s(20)),
            titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.textLeading),
            right.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -s(20)),
            right.centerYAnchor.constraint(equalTo: centerYAnchor),
            right.leadingAnchor.constraint(greaterThanOrEqualTo: titleLabel.trailingAnchor, constant: s(8)),
        ])

        // The subtext is the latest line of the exchange (spec: Subtext):
        // the prompt while working, the reply once the session has finished,
        // asked, or failed.
        let prompt = (row.detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let reply = (row.reply ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let detail = (row.mark == .working || reply.isEmpty) ? prompt : reply
        if detail.isEmpty {
            titleLabel.centerYAnchor.constraint(equalTo: centerYAnchor).isActive = true
        } else {
            let breadcrumb = NSTextField(labelWithString: detail)
            breadcrumb.font = .systemFont(ofSize: s(10.5))
            breadcrumb.textColor = Theme.textDim
            breadcrumb.lineBreakMode = .byTruncatingTail
            breadcrumb.maximumNumberOfLines = 1
            breadcrumb.translatesAutoresizingMaskIntoConstraints = false
            addSubview(breadcrumb)
            NSLayoutConstraint.activate([
                titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: s(8)),
                breadcrumb.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: s(2)),
                breadcrumb.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.textLeading),
                breadcrumb.trailingAnchor.constraint(
                    lessThanOrEqualTo: right.leadingAnchor, constant: -s(8)
                ),
            ])
        }
    }

    private func makeMarkView() -> NSView {
        switch row.mark {
        case .working:
            return SpinnerMarkView(frame: NSRect(x: 0, y: 0, width: s(11), height: s(11)))
        case .attention, .unread:
            // Same dot, two temperatures: amber = blocked on you, blue =
            // output updated (amber scheme; no "?" pill).
            let dot = NSView()
            dot.wantsLayer = true
            dot.layer?.backgroundColor = markColor(row.mark).cgColor
            dot.layer?.cornerRadius = s(4.25)
            NSLayoutConstraint.activate([
                dot.widthAnchor.constraint(equalToConstant: s(8.5)),
                dot.heightAnchor.constraint(equalToConstant: s(8.5)),
            ])
            return dot
        case .read:
            let ring = NSView()
            ring.wantsLayer = true
            ring.layer?.borderColor = Theme.ring.cgColor
            ring.layer?.borderWidth = s(1.4)
            ring.layer?.cornerRadius = s(4)
            NSLayoutConstraint.activate([
                ring.widthAnchor.constraint(equalToConstant: s(8)),
                ring.heightAnchor.constraint(equalToConstant: s(8)),
            ])
            return ring
        case .failed:
            // Not in the mock's data; keep the contract's red xmark - the
            // only red in the system.
            let view = NSImageView()
            let config = NSImage.SymbolConfiguration(pointSize: s(12), weight: .regular)
            view.image = NSImage(
                systemSymbolName: "xmark.circle.fill",
                accessibilityDescription: row.statusWord
            )?.withSymbolConfiguration(config)
            view.contentTintColor = .systemRed
            return view
        }
    }

    private func applyColors() {
        let selected = backgroundStyle == .emphasized
        titleLabel.textColor = selected
            ? .white
            : (row.isUnread ? Theme.titleUnread : Theme.title)
    }
}

// MARK: - Label field delegate

extension PaletteController: NSTextFieldDelegate {
    func controlTextDidChange(_ obj: Notification) {
        guard let field = obj.object as? NSTextField, field === searchField else { return }
        applyQuery(field.stringValue)
    }

    func control(
        _ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector
    ) -> Bool {
        // Only the label editor gets command handling here - the search
        // field's ↩/esc/arrows are consumed by the key monitor first.
        guard control === labelField else { return false }
        switch commandSelector {
        case #selector(NSResponder.insertNewline(_:)):
            commitLabelEdit()
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            // Esc cancels the rename only - the palette stays up.
            cancelLabelEdit()
            return true
        default:
            return false
        }
    }
}

// MARK: - Window delegate

extension PaletteController: NSWindowDelegate {
    func windowDidResignKey(_ notification: Notification) {
        // Clicked elsewhere: dismiss, matching Spotlight/Raycast behaviour.
        hide()
    }

    func windowDidMove(_ notification: Notification) {
        // Persist only real user drags: the programmatic restore/center happens
        // before the panel is ordered in, so it is skipped here.
        guard panel.isVisible else { return }
        savePosition()
    }
}
