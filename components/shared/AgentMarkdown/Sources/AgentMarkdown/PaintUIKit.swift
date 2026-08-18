#if canImport(UIKit)
import UIKit

// The phone renders a chat, so the styling is proportional and softer; the IR
// is identical, only the paint differs.
// UIKit font and colour values are immutable, so this palette remains safe to
// pass across task boundaries even though UIKit does not declare them Sendable.
public struct ChatStyle: @unchecked Sendable {
    public var font: UIFont
    public var boldFont: UIFont
    public var italicFont: UIFont
    public var codeFont: UIFont
    public var textColor: UIColor
    public var codeColor: UIColor
    public var headingFont: UIFont
    public var headingColor: UIColor
    public var linkColor: UIColor
    public var lineSpacing: CGFloat
    public var paragraphSpacing: CGFloat
    public var indent: CGFloat

    public init(
        font: UIFont,
        boldFont: UIFont,
        italicFont: UIFont,
        codeFont: UIFont,
        textColor: UIColor,
        codeColor: UIColor,
        headingFont: UIFont,
        headingColor: UIColor,
        linkColor: UIColor,
        lineSpacing: CGFloat,
        paragraphSpacing: CGFloat,
        indent: CGFloat
    ) {
        self.font = font
        self.boldFont = boldFont
        self.italicFont = italicFont
        self.codeFont = codeFont
        self.textColor = textColor
        self.codeColor = codeColor
        self.headingFont = headingFont
        self.headingColor = headingColor
        self.linkColor = linkColor
        self.lineSpacing = lineSpacing
        self.paragraphSpacing = paragraphSpacing
        self.indent = indent
    }
}

public func render(
    _ document: MarkdownDocument,
    style: ChatStyle,
    cropped: Bool = false
) -> AttributedString {
    let result = NSMutableAttributedString()
    append(document, style: style, cropped: cropped, to: result)
    return AttributedString(result)
}

public func render(
    _ markdown: String,
    style: ChatStyle,
    cropped: Bool = false
) -> AttributedString {
    render(parse(markdown), style: style, cropped: cropped)
}

public func render(spans: [Span], style: ChatStyle) -> AttributedString {
    let result = NSMutableAttributedString()
    append(spans, style: style, paragraphStyle: nil, to: result)
    return AttributedString(result)
}

private func append(
    _ document: MarkdownDocument,
    style: ChatStyle,
    cropped: Bool,
    to result: NSMutableAttributedString
) {
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
        append([Span(AgentMarkdown.croppedMarker)], style: style, paragraphStyle: nil, to: result)
    }
}

private func append(
    _ block: Block,
    style: ChatStyle,
    to result: NSMutableAttributedString
) {
    switch block {
    case let .paragraph(spans):
        append(spans, style: style, paragraphStyle: paragraphStyle(style), to: result)
    case let .heading(_, spans):
        let attributes: [NSAttributedString.Key: Any] = [
            .font: style.headingFont,
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
            .font: style.codeFont,
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
    style: ChatStyle,
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
            .foregroundColor: style.textColor,
            .paragraphStyle: listStyle,
        ]))
        append(spans, style: style, paragraphStyle: listStyle, to: result)
    }
}

private func appendTable(
    header: [[Span]],
    rows: [[[Span]]],
    style: ChatStyle,
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
            append(
                cell,
                style: style,
                baseAttributes: codeAttributes(style, paragraphStyle: tableStyle),
                to: result
            )

            let padding = widths[columnIndex] - cellText(cell).count
            if padding > 0 || columnIndex + 1 < columnCount {
                let gap = columnIndex + 1 < columnCount ? 2 : 0
                result.append(NSAttributedString(
                    string: String(repeating: " ", count: padding + gap),
                    attributes: codeAttributes(style, paragraphStyle: tableStyle)
                ))
            }
        }
    }
}

private func append(
    _ spans: [Span],
    style: ChatStyle,
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
    style: ChatStyle,
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
        }
        if span.style.contains(.code) {
            attributes[.foregroundColor] = style.codeColor
        }
        result.append(NSAttributedString(string: span.text, attributes: attributes))
    }
}

private func font(for spanStyle: SpanStyle, style: ChatStyle) -> UIFont? {
    if spanStyle.contains(.code) {
        return style.codeFont
    }
    if spanStyle.contains(.bold), spanStyle.contains(.italic) {
        let traits: UIFontDescriptor.SymbolicTraits = [.traitBold, .traitItalic]
        guard let descriptor = style.boldFont.fontDescriptor.withSymbolicTraits(traits) else {
            return style.boldFont
        }
        return UIFont(descriptor: descriptor, size: style.boldFont.pointSize)
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
    _ style: ChatStyle,
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

private func codeAttributes(
    _ style: ChatStyle,
    paragraphStyle: NSParagraphStyle
) -> [NSAttributedString.Key: Any] {
    [
        .font: style.codeFont,
        .foregroundColor: style.textColor,
        .paragraphStyle: paragraphStyle,
    ]
}

private func paragraphStyle(
    _ style: ChatStyle,
    spacingBefore: CGFloat = 0,
    firstLineHeadIndent: CGFloat = 0,
    headIndent: CGFloat = 0,
    tabStop: CGFloat? = nil
) -> NSParagraphStyle {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = style.lineSpacing
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
