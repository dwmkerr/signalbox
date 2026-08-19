#if canImport(AppKit)
import AppKit

// The Mac renders the exchange terminal-style: everything mono, styling by
// weight and colour, never proportional rich text. The caller owns the palette
// so the package never has to know the jumplist's theme.
// AppKit font and colour values are immutable, so this palette remains safe to
// pass across task boundaries even though NSFont does not declare Sendable.
public struct TerminalStyle: @unchecked Sendable {
    public var font: NSFont
    public var boldFont: NSFont
    public var italicFont: NSFont
    public var textColor: NSColor
    public var codeColor: NSColor
    public var headingColor: NSColor
    public var linkColor: NSColor
    public var markerColor: NSColor
    public var lineHeight: CGFloat
    public var paragraphSpacing: CGFloat
    public var indent: CGFloat

    public init(
        font: NSFont,
        boldFont: NSFont,
        italicFont: NSFont,
        textColor: NSColor,
        codeColor: NSColor,
        headingColor: NSColor,
        linkColor: NSColor,
        markerColor: NSColor,
        lineHeight: CGFloat,
        paragraphSpacing: CGFloat,
        indent: CGFloat
    ) {
        self.font = font
        self.boldFont = boldFont
        self.italicFont = italicFont
        self.textColor = textColor
        self.codeColor = codeColor
        self.headingColor = headingColor
        self.linkColor = linkColor
        self.markerColor = markerColor
        self.lineHeight = lineHeight
        self.paragraphSpacing = paragraphSpacing
        self.indent = indent
    }
}

public func render(
    _ document: MarkdownDocument,
    style: TerminalStyle,
    cropped: Bool = false
) -> NSAttributedString {
    let result = NSMutableAttributedString()

    for (index, block) in document.blocks.enumerated() {
        if index > 0 {
            result.append(NSAttributedString(string: "\n"))
        }
        append(block, style: style, to: result)
    }

    if cropped {
        if let lastBlock = document.blocks.last, croppedMarkerNeedsTrailingLine(after: lastBlock) {
            result.append(NSAttributedString(string: "\n"))
        }
        result.append(render(spans: [Span(AgentMarkdown.croppedMarker)], style: style))
    }
    return result
}

public func render(
    _ markdown: String,
    style: TerminalStyle,
    cropped: Bool = false
) -> NSAttributedString {
    render(parse(markdown), style: style, cropped: cropped)
}

public func render(spans: [Span], style: TerminalStyle) -> NSAttributedString {
    let result = NSMutableAttributedString()
    append(spans, style: style, paragraphStyle: nil, to: result)
    return result
}

private func append(
    _ block: Block,
    style: TerminalStyle,
    to result: NSMutableAttributedString
) {
    switch block {
    case let .paragraph(spans):
        append(spans, style: style, paragraphStyle: paragraphStyle(style), to: result)
    case let .heading(_, spans):
        let attributes: [NSAttributedString.Key: Any] = [
            .font: style.boldFont,
            .foregroundColor: style.headingColor,
            .paragraphStyle: paragraphStyle(style, spacingBefore: style.paragraphSpacing),
        ]
        append(spans, style: style, baseAttributes: attributes, to: result)
    case let .bulletList(items):
        appendList(items, start: nil, style: style, to: result)
    case let .orderedList(start, items):
        appendList(items, start: start, style: style, to: result)
    case let .codeBlock(_, code):
        let blockStyle = paragraphStyle(
            style,
            firstLineHeadIndent: style.indent,
            headIndent: style.indent
        )
        result.append(NSAttributedString(string: code, attributes: [
            .font: style.font,
            .foregroundColor: style.codeColor,
            .paragraphStyle: blockStyle,
        ]))
    case let .table(header, rows):
        appendTable(header: header, rows: rows, style: style, to: result)
    }
}

private func appendList(
    _ items: [[Span]],
    start: Int?,
    style: TerminalStyle,
    to result: NSMutableAttributedString
) {
    let listStyle = paragraphStyle(style, headIndent: style.indent, tabStop: style.indent)

    for (index, spans) in items.enumerated() {
        if index > 0 {
            result.append(NSAttributedString(string: "\n"))
        }
        let marker = start.map { "\($0 + index).\t" } ?? "•\t"
        result.append(NSAttributedString(string: marker, attributes: [
            .font: style.font,
            .foregroundColor: style.markerColor,
            .paragraphStyle: listStyle,
        ]))
        append(spans, style: style, paragraphStyle: listStyle, to: result)
    }
}

private func appendTable(
    header: [[Span]],
    rows: [[[Span]]],
    style: TerminalStyle,
    to result: NSMutableAttributedString
) {
    let allRows = [header] + rows
    let columnCount = allRows.map(\.count).max() ?? 0
    var widths = Array(repeating: 0, count: columnCount)

    for row in allRows {
        for (index, cell) in row.enumerated() {
            widths[index] = max(widths[index], cellText(cell).count)
        }
    }

    let tableStyle = paragraphStyle(style)
    for (rowIndex, row) in allRows.enumerated() {
        if rowIndex > 0 {
            result.append(NSAttributedString(string: "\n"))
        }
        for columnIndex in 0..<columnCount {
            let cell = columnIndex < row.count ? row[columnIndex] : []
            append(cell, style: style, paragraphStyle: tableStyle, to: result)

            let padding = widths[columnIndex] - cellText(cell).count
            if padding > 0 || columnIndex + 1 < columnCount {
                let gap = columnIndex + 1 < columnCount ? 2 : 0
                result.append(NSAttributedString(
                    string: String(repeating: " ", count: padding + gap),
                    attributes: baseAttributes(style, paragraphStyle: tableStyle)
                ))
            }
        }
    }
}

private func append(
    _ spans: [Span],
    style: TerminalStyle,
    paragraphStyle: NSParagraphStyle?,
    to result: NSMutableAttributedString
) {
    append(
        spans,
        style: style,
        baseAttributes: baseAttributes(style, paragraphStyle: paragraphStyle),
        to: result
    )
}

private func append(
    _ spans: [Span],
    style: TerminalStyle,
    baseAttributes: [NSAttributedString.Key: Any],
    to result: NSMutableAttributedString
) {
    for span in spans {
        var attributes = baseAttributes
        if let font = font(for: span.style, style: style) {
            attributes[.font] = font
        }
        if let link = span.link {
            attributes[.foregroundColor] = style.linkColor
            attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            attributes[.link] = link
            // A selectable NSTextField honours the cursor attribute, so links
            // get the pointing hand without a tracking-area dance.
            attributes[.cursor] = NSCursor.pointingHand
        }
        if span.style.contains(.code) {
            attributes[.foregroundColor] = style.codeColor
        }
        result.append(NSAttributedString(string: span.text, attributes: attributes))
    }
}

private func font(for spanStyle: SpanStyle, style: TerminalStyle) -> NSFont? {
    if spanStyle.contains(.code) {
        return style.font
    }
    if spanStyle.contains(.bold), spanStyle.contains(.italic) {
        let traits: NSFontDescriptor.SymbolicTraits = [.bold, .italic]
        let descriptor = style.boldFont.fontDescriptor.withSymbolicTraits(traits)
        return NSFont(descriptor: descriptor, size: style.boldFont.pointSize) ?? style.boldFont
    }
    if spanStyle.contains(.bold) {
        return style.boldFont
    }
    if spanStyle.contains(.italic) {
        return style.italicFont
    }
    return nil
}

private func baseAttributes(
    _ style: TerminalStyle,
    paragraphStyle: NSParagraphStyle?
) -> [NSAttributedString.Key: Any] {
    var attributes: [NSAttributedString.Key: Any] = [
        .font: style.font,
        .foregroundColor: style.textColor,
    ]
    if let paragraphStyle {
        attributes[.paragraphStyle] = paragraphStyle
    }
    return attributes
}

private func paragraphStyle(
    _ style: TerminalStyle,
    spacingBefore: CGFloat = 0,
    firstLineHeadIndent: CGFloat = 0,
    headIndent: CGFloat = 0,
    tabStop: CGFloat? = nil
) -> NSParagraphStyle {
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = style.lineHeight
    paragraph.maximumLineHeight = style.lineHeight
    paragraph.paragraphSpacing = style.paragraphSpacing
    paragraph.paragraphSpacingBefore = spacingBefore
    paragraph.firstLineHeadIndent = firstLineHeadIndent
    paragraph.headIndent = headIndent
    paragraph.lineBreakMode = .byWordWrapping
    if let tabStop {
        paragraph.tabStops = [NSTextTab(textAlignment: .left, location: tabStop)]
    }
    return paragraph
}

private func cellText(_ spans: [Span]) -> String {
    spans.map(\.text).joined()
}

private func croppedMarkerNeedsTrailingLine(after block: Block) -> Bool {
    switch block {
    case .codeBlock, .table:
        return true
    case .paragraph, .heading, .bulletList, .orderedList:
        return false
    }
}
#endif
