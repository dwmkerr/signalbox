public func parse(
    _ markdown: String,
    dialect: Dialect = .common
) -> MarkdownDocument {
    guard !markdown.isEmpty else {
        return MarkdownDocument(blocks: [])
    }

    let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false).map {
        var line = String($0)
        if line.last == "\r" {
            line.removeLast()
        }
        return line
    }
    var blocks: [Block] = []
    var index = 0

    while index < lines.count {
        if isBlank(lines[index]) {
            index += 1
            continue
        }

        if let fence = fenceMatch(lines[index]) {
            if let closeIndex = closingFenceIndex(
                in: lines,
                after: index,
                minimumLength: fence.length
            ) {
                let codeLines = lines[(index + 1)..<closeIndex]
                // Fence contents stay raw so examples of markdown survive intact.
                blocks.append(.codeBlock(
                    language: fence.language,
                    code: codeLines.joined(separator: "\n")
                ))
                index = closeIndex + 1
                continue
            }

            var literalLines = [lines[index]]
            index += 1
            while index < lines.count
                && !isBlank(lines[index])
                && !isBlockStart(lines: lines, at: index) {
                literalLines.append(lines[index])
                index += 1
            }
            // An opener without a closer stays literal so later blocks remain visible.
            blocks.append(.paragraph([Span(literalLines.joined(separator: "\n"))]))
            continue
        }

        if let heading = headingMatch(lines[index]) {
            blocks.append(.heading(level: heading.level, spans: parseSpans(heading.text)))
            index += 1
            continue
        }

        if let item = unorderedItem(lines[index]) {
            var items = [[Span]]()
            var current: String? = item
            while let text = current {
                items.append(parseSpans(text))
                index += 1
                current = index < lines.count ? unorderedItem(lines[index]) : nil
            }
            blocks.append(.bulletList(items))
            continue
        }

        if let firstItem = orderedItem(lines[index]) {
            var items = [[Span]]()
            var current: OrderedItem? = firstItem
            while let item = current {
                items.append(parseSpans(item.text))
                index += 1
                current = index < lines.count ? orderedItem(lines[index]) : nil
            }
            blocks.append(.orderedList(start: firstItem.number, items: items))
            continue
        }

        if isTableStart(lines: lines, at: index) {
            let header = tableCells(lines[index]).map(parseSpans)
            index += 2
            var rows = [[[Span]]]()
            while index < lines.count && !isBlank(lines[index]) && lines[index].contains("|") {
                rows.append(tableCells(lines[index]).map(parseSpans))
                index += 1
            }
            blocks.append(.table(header: header, rows: rows))
            continue
        }

        var paragraphLines = [lines[index]]
        index += 1
        while index < lines.count
            && !isBlank(lines[index])
            && !isBlockStart(lines: lines, at: index) {
            paragraphLines.append(lines[index])
            index += 1
        }
        // Newlines remain in the IR because only a one-line preview collapses them.
        blocks.append(.paragraph(parseSpans(paragraphLines.joined(separator: "\n"))))
    }

    return MarkdownDocument(blocks: blocks)
}

private struct OrderedItem {
    let number: Int
    let text: String
}

private struct Fence {
    let length: Int
    let language: String?
}

private func isBlank(_ line: String) -> Bool {
    line.allSatisfy(\.isWhitespace)
}

private func trimWhitespace(_ text: String) -> String {
    var start = text.startIndex
    var end = text.endIndex
    while start < end && text[start].isWhitespace {
        start = text.index(after: start)
    }
    while start < end {
        let previous = text.index(before: end)
        guard text[previous].isWhitespace else {
            break
        }
        end = previous
    }
    return String(text[start..<end])
}

private func fenceMatch(_ line: String) -> Fence? {
    let candidate = trimWhitespace(line)
    var cursor = candidate.startIndex
    while cursor < candidate.endIndex && candidate[cursor] == "`" {
        cursor = candidate.index(after: cursor)
    }
    let length = candidate.distance(from: candidate.startIndex, to: cursor)
    guard length >= 3 else {
        return nil
    }
    let language = trimWhitespace(String(candidate[cursor...]))
    return Fence(length: length, language: language.isEmpty ? nil : language)
}

private func isFenceClose(_ line: String, minimumLength: Int) -> Bool {
    let candidate = trimWhitespace(line)
    return candidate.count >= minimumLength && candidate.allSatisfy { $0 == "`" }
}

private func closingFenceIndex(
    in lines: [String],
    after openingIndex: Int,
    minimumLength: Int
) -> Int? {
    var index = openingIndex + 1
    while index < lines.count {
        if isFenceClose(lines[index], minimumLength: minimumLength) {
            return index
        }
        index += 1
    }
    return nil
}

private func headingMatch(_ line: String) -> (level: Int, text: String)? {
    var cursor = line.startIndex
    var level = 0
    while cursor < line.endIndex && line[cursor] == "#" {
        level += 1
        cursor = line.index(after: cursor)
    }
    guard (1...6).contains(level), cursor < line.endIndex, line[cursor].isWhitespace else {
        return nil
    }
    while cursor < line.endIndex && line[cursor].isWhitespace {
        cursor = line.index(after: cursor)
    }
    return (level, headingText(in: line, from: cursor))
}

private func headingText(in line: String, from contentStart: String.Index) -> String {
    var markerEnd = line.endIndex
    while markerEnd > contentStart {
        let previous = line.index(before: markerEnd)
        guard line[previous].isWhitespace else {
            break
        }
        markerEnd = previous
    }

    var markerStart = markerEnd
    while markerStart > contentStart {
        let previous = line.index(before: markerStart)
        guard line[previous] == "#" else {
            break
        }
        markerStart = previous
    }

    guard markerStart < markerEnd else {
        return String(line[contentStart...])
    }
    if markerStart > contentStart {
        let separator = line.index(before: markerStart)
        guard line[separator].isWhitespace else {
            return String(line[contentStart...])
        }
    }

    var contentEnd = markerStart
    while contentEnd > contentStart {
        let previous = line.index(before: contentEnd)
        guard line[previous].isWhitespace else {
            break
        }
        contentEnd = previous
    }
    return String(line[contentStart..<contentEnd])
}

private func unorderedItem(_ line: String) -> String? {
    var cursor = line.startIndex
    while cursor < line.endIndex && line[cursor].isWhitespace {
        cursor = line.index(after: cursor)
    }
    guard cursor < line.endIndex, "-*+".contains(line[cursor]) else {
        return nil
    }
    cursor = line.index(after: cursor)
    guard cursor < line.endIndex, line[cursor].isWhitespace else {
        return nil
    }
    while cursor < line.endIndex && line[cursor].isWhitespace {
        cursor = line.index(after: cursor)
    }
    return String(line[cursor...])
}

private func orderedItem(_ line: String) -> OrderedItem? {
    var cursor = line.startIndex
    while cursor < line.endIndex && line[cursor].isWhitespace {
        cursor = line.index(after: cursor)
    }
    let numberStart = cursor
    while cursor < line.endIndex && line[cursor].isNumber {
        cursor = line.index(after: cursor)
    }
    guard numberStart < cursor,
          let number = Int(line[numberStart..<cursor]),
          cursor < line.endIndex,
          line[cursor] == "." || line[cursor] == ")" else {
        return nil
    }
    cursor = line.index(after: cursor)
    guard cursor < line.endIndex, line[cursor].isWhitespace else {
        return nil
    }
    while cursor < line.endIndex && line[cursor].isWhitespace {
        cursor = line.index(after: cursor)
    }
    return OrderedItem(number: number, text: String(line[cursor...]))
}

private func isTableStart(lines: [String], at index: Int) -> Bool {
    guard index + 1 < lines.count, lines[index].contains("|") else {
        return false
    }
    let header = tableCells(lines[index])
    let delimiters = tableCells(lines[index + 1])
    return !delimiters.isEmpty
        && header.count == delimiters.count
        && delimiters.allSatisfy(isTableDelimiter)
}

private func tableCells(_ line: String) -> [String] {
    var body = trimWhitespace(line)
    if body.first == "|" {
        body.removeFirst()
    }
    if body.last == "|" && !body.hasSuffix("\\|") {
        body.removeLast()
    }

    guard !body.isEmpty else {
        return []
    }

    var cells = [""]
    var cursor = body.startIndex
    while cursor < body.endIndex {
        if body[cursor] == "\\" {
            let next = body.index(after: cursor)
            if next < body.endIndex && body[next] == "|" {
                cells[cells.count - 1].append("|")
                cursor = body.index(after: next)
                continue
            }
        }
        if body[cursor] == "|" {
            cells.append("")
        } else {
            cells[cells.count - 1].append(body[cursor])
        }
        cursor = body.index(after: cursor)
    }
    return cells.map(trimWhitespace)
}

private func isTableDelimiter(_ cell: String) -> Bool {
    var delimiter = trimWhitespace(cell)
    if delimiter.first == ":" {
        delimiter.removeFirst()
    }
    if delimiter.last == ":" {
        delimiter.removeLast()
    }
    return delimiter.count >= 3 && delimiter.allSatisfy { $0 == "-" }
}

private func isBlockStart(lines: [String], at index: Int) -> Bool {
    fenceMatch(lines[index]) != nil
        || headingMatch(lines[index]) != nil
        || unorderedItem(lines[index]) != nil
        || orderedItem(lines[index]) != nil
        || isTableStart(lines: lines, at: index)
}

private func parseSpans(_ text: String) -> [Span] {
    var spans = [Span]()
    var buffer = ""
    var style: SpanStyle = []
    var cursor = text.startIndex

    func flush() {
        appendSpan(Span(text: buffer, style: style, link: nil), to: &spans)
        buffer.removeAll(keepingCapacity: true)
    }

    while cursor < text.endIndex {
        if text[cursor] == "`" {
            let contentStart = text.index(after: cursor)
            if let close = nextOccurrence(of: "`", in: text, from: contentStart) {
                flush()
                let codeStyle = style.union(.code)
                appendSpan(
                    Span(text: String(text[contentStart..<close]), style: codeStyle, link: nil),
                    to: &spans
                )
                cursor = text.index(after: close)
                continue
            }
        }

        if text[cursor] == "[", let link = linkMatch(in: text, at: cursor) {
            flush()
            // Labels keep emphasis because a link is metadata rather than a style.
            for labelSpan in parseSpans(link.label) {
                appendSpan(
                    Span(
                        text: labelSpan.text,
                        style: labelSpan.style.union(style),
                        link: link.url
                    ),
                    to: &spans
                )
            }
            cursor = link.end
            continue
        }

        if let marker = emphasisMarker(in: text, at: cursor) {
            let markerEnd = text.index(cursor, offsetBy: marker.text.count)
            if style.contains(marker.style) {
                flush()
                style.remove(marker.style)
                cursor = markerEnd
                continue
            }
            if nextOccurrence(of: marker.text, in: text, from: markerEnd) != nil {
                flush()
                style.insert(marker.style)
                cursor = markerEnd
                continue
            }
            // A missing closer stays visible instead of consuming the remaining text.
            buffer.append(contentsOf: marker.text)
            cursor = markerEnd
            continue
        }

        buffer.append(text[cursor])
        cursor = text.index(after: cursor)
    }

    flush()
    return spans
}

private func emphasisMarker(
    in text: String,
    at index: String.Index
) -> (text: String, style: SpanStyle)? {
    let suffix = text[index...]
    if suffix.hasPrefix("**") {
        return ("**", .bold)
    }
    if suffix.hasPrefix("__") {
        return ("__", .bold)
    }
    if text[index] == "*" || text[index] == "_" {
        return (String(text[index]), .italic)
    }
    return nil
}

private func nextOccurrence(
    of token: String,
    in text: String,
    from start: String.Index
) -> String.Index? {
    var cursor = start
    while cursor < text.endIndex {
        if text[cursor...].hasPrefix(token) {
            return cursor
        }
        cursor = text.index(after: cursor)
    }
    return nil
}

private func linkMatch(
    in text: String,
    at open: String.Index
) -> (label: String, url: String, end: String.Index)? {
    let labelStart = text.index(after: open)
    guard let labelEnd = nextOccurrence(of: "]", in: text, from: labelStart) else {
        return nil
    }
    let openParenthesis = text.index(after: labelEnd)
    guard openParenthesis < text.endIndex, text[openParenthesis] == "(" else {
        return nil
    }
    let urlStart = text.index(after: openParenthesis)
    guard let urlEnd = nextOccurrence(of: ")", in: text, from: urlStart) else {
        return nil
    }
    return (
        String(text[labelStart..<labelEnd]),
        String(text[urlStart..<urlEnd]),
        text.index(after: urlEnd)
    )
}

private func appendSpan(_ span: Span, to spans: inout [Span]) {
    guard !span.text.isEmpty else {
        return
    }
    if let last = spans.last, last.style == span.style, last.link == span.link {
        spans[spans.count - 1].text += span.text
    } else {
        spans.append(span)
    }
}
