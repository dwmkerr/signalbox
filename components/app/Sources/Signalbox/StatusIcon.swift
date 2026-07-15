import AppKit

// Menu bar icon style, switchable in the Settings window. The beacon (radio
// waves) is the default; the list glyph is the kept alternate.
enum MenuBarIconStyle: String, CaseIterable {
    case beacon
    case list

    static let defaultsKey = "menuBarIcon"

    static var current: MenuBarIconStyle {
        MenuBarIconStyle(
            rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? ""
        ) ?? .beacon
    }

    var displayName: String {
        switch self {
        case .list: return "List"
        case .beacon: return "Beacon"
        }
    }
}

// The Control-Center-style status dot on the icon - one dot, three
// temperatures, highest urgency wins: red = failed (fix) > amber = needs your
// input (act) > blue = output updated (look). Colors match the amber scheme
// (design/amber-scheme.svg).
enum StatusDot {
    case attention
    case output
    case failed

    var color: NSColor {
        switch self {
        case .attention: return NSColor(red: 1.0, green: 0.62, blue: 0.04, alpha: 1) // #FF9F0A
        case .output: return NSColor(red: 0.04, green: 0.52, blue: 1.0, alpha: 1) // #0A84FF
        case .failed: return NSColor(red: 1.0, green: 0.27, blue: 0.23, alpha: 1) // #FF453A
        }
    }
}

// statusItemImage renders the menu bar icon: the glyph, plus the status dot
// top-right when something waits. Idle returns a template image so macOS
// tints it for menu bar appearance and highlight; with a dot the image must
// carry its own colors, so the glyph is drawn in labelColor (resolved at
// draw time against the destination appearance).
@MainActor
func statusItemImage(style: MenuBarIconStyle, dot: StatusDot?) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let image = NSImage(size: size, flipped: true) { _ in
        let glyphColor: NSColor = dot == nil ? .black : .labelColor
        switch style {
        case .list: drawListGlyph(color: glyphColor)
        case .beacon: drawBeaconGlyph(color: glyphColor)
        }
        if let dot {
            let context = NSGraphicsContext.current?.cgContext
            // Punch a halo around the dot so it separates from the glyph the
            // way Control Center badges do, whatever the menu bar tint.
            context?.setBlendMode(.destinationOut)
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: 9.4, y: -0.6, width: 9.2, height: 9.2)).fill()
            context?.setBlendMode(.normal)
            dot.color.setFill()
            NSBezierPath(ovalIn: NSRect(x: 10.5, y: 0.5, width: 7, height: 7)).fill()
        }
        return true
    }
    image.isTemplate = dot == nil
    return image
}

// Three rows of dot + bar, fading downward - the session list in miniature
// (design/menu-bar-icons.svg, "list").
private func drawListGlyph(color: NSColor) {
    for (i, opacity) in [1.0, 0.85, 0.7].enumerated() {
        color.withAlphaComponent(opacity).setFill()
        let y = 2.0 + CGFloat(i) * 6.0
        NSBezierPath(ovalIn: NSRect(x: 1, y: y, width: 3, height: 3)).fill()
        NSBezierPath(
            roundedRect: NSRect(x: 6, y: y + 0.5, width: 11, height: 2), xRadius: 1, yRadius: 1
        ).fill()
    }
}

// Center dot with two pairs of broadcast arcs, fading outward
// (design/menu-bar-icons.svg, "beacon").
private func drawBeaconGlyph(color: NSColor) {
    let center = NSPoint(x: 9, y: 9)
    color.setFill()
    NSBezierPath(
        ovalIn: NSRect(x: center.x - 2.4, y: center.y - 2.4, width: 4.8, height: 4.8)
    ).fill()
    for (radius, opacity) in [(5.0, 0.9), (8.0, 0.55)] {
        color.withAlphaComponent(opacity).setStroke()
        for arcUp in [true, false] {
            let arc = NSBezierPath()
            arc.lineWidth = 1.6
            arc.lineCapStyle = .round
            // 45°-135° arcs above and below the dot; the flipped context
            // mirrors them, which is symmetric so the angles stay literal.
            arc.appendArc(
                withCenter: center, radius: radius,
                startAngle: arcUp ? 45 : 225, endAngle: arcUp ? 135 : 315
            )
            arc.stroke()
        }
    }
}
