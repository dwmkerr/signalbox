import AppKit

final class HubTopology: NSView {
    var mode: HubDisplayMode = .local {
        didSet {
            if oldValue != mode {
                invalidateIntrinsicContentSize()
                needsDisplay = true
            }
        }
    }

    // Each mode draws a different amount, and the labels have to stay at a
    // readable 9pt, so the canvas is sized per mode rather than padded out to
    // the widest one.
    private static func canvas(for mode: HubDisplayMode) -> NSSize {
        switch mode {
        case .local, .other: return NSSize(width: 60, height: 48)
        case .lan: return NSSize(width: 80, height: 48)
        case .remote: return NSSize(width: 116, height: 79)
        }
    }

    override var intrinsicContentSize: NSSize { Self.canvas(for: mode) }
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard bounds.width > 0, bounds.height > 0,
              let context = NSGraphicsContext.current?.cgContext else { return }
        let canvas = Self.canvas(for: mode)
        context.saveGState()
        context.scaleBy(x: bounds.width / canvas.width, y: bounds.height / canvas.height)

        switch mode {
        case .local, .other:
            drawMachine(x: 1, y: 0, filled: true)
        case .lan:
            drawMachine(x: 1, y: 0, filled: true)
            drawLine(from: NSPoint(x: 47, y: 23.5), to: NSPoint(x: 64, y: 23.5), dashed: true)
            drawPhone(x: 64, y: 13.5, height: 20)
        case .remote:
            // Two machines side by side, both forwarding up to the cloud: a
            // remote hub takes forwards from many machines, not just this one.
            drawMachine(x: 1, y: 30, filled: false)
            drawMachine(x: 68, y: 30, filled: false)
            drawCloud(center: NSPoint(x: 57, y: 14))
            drawLine(from: NSPoint(x: 23, y: 42), to: NSPoint(x: 48, y: 20), dashed: true)
            drawLine(from: NSPoint(x: 90, y: 42), to: NSPoint(x: 66, y: 20), dashed: true)
            drawLine(from: NSPoint(x: 69.5, y: 14), to: NSPoint(x: 82, y: 14), dashed: true)
            drawPhone(x: 82, y: 4, height: 20)
        }
        context.restoreGState()
    }

    /// A machine frame with its agents drawn inside it. `y` is the top of the
    /// "agents" caption; the frame sits below it and the "machine" caption
    /// below that. The nesting alone did not read at this size, so both parts
    /// are named.
    private func drawMachine(x: CGFloat, y: CGFloat, filled: Bool) {
        drawLabel("agents", x: x + 4, y: y)
        let top = y + 12
        stroke(NSBezierPath(roundedRect: NSRect(x: x, y: top, width: 44, height: 23), xRadius: 3, yRadius: 3))
        stroke(NSBezierPath(roundedRect: NSRect(x: x + 5, y: top + 3.5, width: 9, height: 6.5), xRadius: 1.5, yRadius: 1.5))
        stroke(NSBezierPath(roundedRect: NSRect(x: x + 5, y: top + 13, width: 9, height: 6.5), xRadius: 1.5, yRadius: 1.5))
        let hub = NSPoint(x: x + 32, y: top + 11.5)
        drawLine(from: NSPoint(x: x + 14, y: top + 6.75), to: NSPoint(x: hub.x - 5.5, y: hub.y))
        drawLine(from: NSPoint(x: x + 14, y: top + 16.25), to: NSPoint(x: hub.x - 5.5, y: hub.y))
        let dot = NSBezierPath(ovalIn: NSRect(x: hub.x - 3.4, y: hub.y - 3.4, width: 6.8, height: 6.8))
        // The filled dot is the board of record: Remote moves it from this
        // machine to the cloud because many machines can forward there.
        if filled {
            NSColor.tertiaryLabelColor.setFill()
            dot.fill()
        } else {
            stroke(dot)
        }
        drawLabel("machine", x: x + 4, y: y + 37)
    }

    private func drawPhone(x: CGFloat, y: CGFloat, height: CGFloat) {
        stroke(NSBezierPath(roundedRect: NSRect(x: x, y: y, width: 9, height: height), xRadius: 2, yRadius: 2))
        drawLine(from: NSPoint(x: x + 2.6, y: y + height - 2.6), to: NSPoint(x: x + 6.4, y: y + height - 2.6))
    }

    private func drawCloud(center: NSPoint) {
        let color = NSColor.tertiaryLabelColor
        color.withAlphaComponent(0.28).setFill()
        NSBezierPath(ovalIn: NSRect(x: center.x - 12.6, y: center.y - 3.6, width: 9.2, height: 9.2)).fill()
        NSBezierPath(ovalIn: NSRect(x: center.x - 6, y: center.y - 8, width: 12, height: 12)).fill()
        NSBezierPath(ovalIn: NSRect(x: center.x + 3.8, y: center.y - 3.2, width: 8.4, height: 8.4)).fill()
        NSBezierPath(roundedRect: NSRect(x: center.x - 12.5, y: center.y, width: 25, height: 5.5), xRadius: 2.7, yRadius: 2.7).fill()
        color.setFill()
        NSBezierPath(ovalIn: NSRect(x: center.x - 2.7, y: center.y - 1.7, width: 5.4, height: 5.4)).fill()
    }

    private func drawLabel(_ text: String, x: CGFloat, y: CGFloat) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
        NSAttributedString(string: text, attributes: attributes).draw(at: NSPoint(x: x, y: y))
    }

    private func drawLine(from start: NSPoint, to end: NSPoint, dashed: Bool = false) {
        let path = NSBezierPath()
        path.move(to: start)
        path.line(to: end)
        if dashed {
            let pattern: [CGFloat] = [2.4, 2.4]
            path.setLineDash(pattern, count: pattern.count, phase: 0)
        }
        stroke(path)
    }

    private func stroke(_ path: NSBezierPath) {
        NSColor.tertiaryLabelColor.setStroke()
        path.lineWidth = 1.05
        path.lineCapStyle = .round
        path.stroke()
    }
}
