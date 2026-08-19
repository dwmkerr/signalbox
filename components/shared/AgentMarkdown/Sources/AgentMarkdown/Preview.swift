// The one-line row rule (specs/agent-markdown.md): the first text paragraph,
// inline styles only, block constructs skipped, whitespace collapsed. Returns
// spans rather than a String so a row can still bold a word.
public func previewLine(
    _ markdown: String,
    cropped: Bool = false,
    dialect: Dialect = .common
) -> [Span] {
    previewLine(parse(markdown, dialect: dialect), cropped: cropped)
}

// The same rule applied to an already-parsed document, so a caller that needs
// both the full render and the row does not parse twice.
public func previewLine(
    _ document: MarkdownDocument,
    cropped: Bool = false
) -> [Span] {
    let source = previewSource(document)
    var result = collapseWhitespace(source)
    if cropped {
        // The marker remains separate because callers may style the affordance.
        result.append(Span(AgentMarkdown.croppedMarker))
    }
    return result
}

private func previewSource(_ document: MarkdownDocument) -> [Span] {
    for block in document.blocks {
        if case let .paragraph(spans) = block {
            return spans
        }
    }

    guard let first = document.blocks.first else {
        return []
    }
    switch first {
    case let .paragraph(spans), let .heading(_, spans):
        return spans
    case let .bulletList(items):
        return items.first ?? []
    case let .orderedList(_, items):
        return items.first ?? []
    case let .codeBlock(_, code):
        let firstLine = code.split(separator: "\n", omittingEmptySubsequences: false).first
            .map(String.init) ?? ""
        return [Span(firstLine, .code)]
    case let .table(header, _):
        return header.first ?? []
    }
}

private func collapseWhitespace(_ spans: [Span]) -> [Span] {
    var result = [Span]()
    var previousWasWhitespace = false

    for span in spans {
        for character in span.text {
            if character.isWhitespace {
                guard !previousWasWhitespace else {
                    continue
                }
                appendPreviewText(" ", style: span.style, link: span.link, to: &result)
                previousWasWhitespace = true
            } else {
                appendPreviewText(String(character), style: span.style, link: span.link, to: &result)
                previousWasWhitespace = false
            }
        }
    }
    return result
}

private func appendPreviewText(
    _ text: String,
    style: SpanStyle,
    link: String?,
    to spans: inout [Span]
) {
    if let last = spans.last, last.style == style, last.link == link {
        spans[spans.count - 1].text += text
    } else {
        spans.append(Span(text: text, style: style, link: link))
    }
}
