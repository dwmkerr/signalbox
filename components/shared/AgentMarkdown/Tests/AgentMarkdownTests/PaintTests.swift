#if canImport(AppKit)
import AppKit
import XCTest
import AgentMarkdown

final class PaintTests: XCTestCase {
    func testCroppedMarkerStaysOnFinalLineForSpanBlocks() {
        XCTAssertEqual(
            render(
                MarkdownDocument(blocks: [.paragraph([Span("body")])]),
                style: style,
                cropped: true
            ).string,
            "body\(AgentMarkdown.croppedMarker)"
        )
        XCTAssertEqual(
            render(
                MarkdownDocument(blocks: [.heading(level: 1, spans: [Span("heading")])]),
                style: style,
                cropped: true
            ).string,
            "heading\(AgentMarkdown.croppedMarker)"
        )
        XCTAssertEqual(
            render(
                MarkdownDocument(blocks: [
                    .bulletList([
                        [Span("one")],
                        [Span("two")]
                    ])
                ]),
                style: style,
                cropped: true
            ).string,
            "•\tone\n•\ttwo\(AgentMarkdown.croppedMarker)"
        )
        XCTAssertEqual(
            render(
                MarkdownDocument(blocks: [
                    .orderedList(start: 3, items: [
                        [Span("three")],
                        [Span("four")]
                    ])
                ]),
                style: style,
                cropped: true
            ).string,
            "3.\tthree\n4.\tfour\(AgentMarkdown.croppedMarker)"
        )
    }

    func testCroppedMarkerUsesOwnTrailingLineForSpanlessBlocks() {
        XCTAssertEqual(
            render(
                MarkdownDocument(blocks: [.codeBlock(language: nil, code: "code")]),
                style: style,
                cropped: true
            ).string,
            "code\n\(AgentMarkdown.croppedMarker)"
        )
        XCTAssertEqual(
            render(
                MarkdownDocument(blocks: [
                    .table(
                        header: [[Span("Header")]],
                        rows: [[[Span("value")]]]
                    )
                ]),
                style: style,
                cropped: true
            ).string,
            "Header\nvalue \n\(AgentMarkdown.croppedMarker)"
        )
    }

    private var style: TerminalStyle {
        let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        return TerminalStyle(
            font: font,
            boldFont: NSFont.monospacedSystemFont(ofSize: 12, weight: .bold),
            italicFont: font,
            textColor: .textColor,
            codeColor: .textColor,
            headingColor: .textColor,
            linkColor: .linkColor,
            markerColor: .textColor,
            lineHeight: 14,
            paragraphSpacing: 0,
            indent: 16
        )
    }
}
#endif
