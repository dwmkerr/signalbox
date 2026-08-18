// These cases mirror the spec's golden examples so changing either contract
// requires changing the other.
import XCTest
import AgentMarkdown

final class ParserTests: XCTestCase {
    func testG1Emphasis() {
        let actual = parse("Done - the **dashboard** now shows *per-post* traffic.")
        let expected = MarkdownDocument(blocks: [
            .paragraph([
                Span(text: "Done - the ", style: [], link: nil),
                Span(text: "dashboard", style: .bold, link: nil),
                Span(text: " now shows ", style: [], link: nil),
                Span(text: "per-post", style: .italic, link: nil),
                Span(text: " traffic.", style: [], link: nil)
            ])
        ])

        XCTAssertEqual(actual, expected)
    }

    func testG2InlineCode() {
        let actual = parse("Run `make build` first.")
        let expected = MarkdownDocument(blocks: [
            .paragraph([
                Span(text: "Run ", style: [], link: nil),
                Span(text: "make build", style: .code, link: nil),
                Span(text: " first.", style: [], link: nil)
            ])
        ])

        XCTAssertEqual(actual, expected)
    }

    func testG3Link() {
        let actual = parse("See [the spec](https://example.com/s) for detail.")
        let expected = MarkdownDocument(blocks: [
            .paragraph([
                Span(text: "See ", style: [], link: nil),
                Span(text: "the spec", style: [], link: "https://example.com/s"),
                Span(text: " for detail.", style: [], link: nil)
            ])
        ])

        XCTAssertEqual(actual, expected)
    }

    func testG4HeadingPlusParagraph() {
        let actual = parse("## Summary\n\nAll green.")
        let expected = MarkdownDocument(blocks: [
            .heading(level: 2, spans: [
                Span(text: "Summary", style: [], link: nil)
            ]),
            .paragraph([
                Span(text: "All green.", style: [], link: nil)
            ])
        ])

        XCTAssertEqual(actual, expected)
    }

    func testG5UnorderedList() {
        let actual = parse("- one\n- **two**")
        let expected = MarkdownDocument(blocks: [
            .bulletList([
                [Span(text: "one", style: [], link: nil)],
                [Span(text: "two", style: .bold, link: nil)]
            ])
        ])

        XCTAssertEqual(actual, expected)
    }

    func testG6OrderedList() {
        let actual = parse("3. third\n4. fourth")
        let expected = MarkdownDocument(blocks: [
            .orderedList(start: 3, items: [
                [Span(text: "third", style: [], link: nil)],
                [Span(text: "fourth", style: [], link: nil)]
            ])
        ])

        XCTAssertEqual(actual, expected)
    }

    func testG7FencedCode() {
        let actual = parse("```ts\nconst x = **1**;\n```")
        let expected = MarkdownDocument(blocks: [
            .codeBlock(language: "ts", code: "const x = **1**;")
        ])

        XCTAssertEqual(actual, expected)
    }

    func testG8Table() {
        let actual = parse("| Name | Status |\n|---|---|\n| Parser | ready |\n| Paint | next |")
        let expected = MarkdownDocument(blocks: [
            .table(
                header: [
                    [Span(text: "Name", style: [], link: nil)],
                    [Span(text: "Status", style: [], link: nil)]
                ],
                rows: [
                    [
                        [Span(text: "Parser", style: [], link: nil)],
                        [Span(text: "ready", style: [], link: nil)]
                    ],
                    [
                        [Span(text: "Paint", style: [], link: nil)],
                        [Span(text: "next", style: [], link: nil)]
                    ]
                ]
            )
        ])

        XCTAssertEqual(actual, expected)
    }

    func testTableRequiresMatchingHeaderAndDelimiterCellCounts() {
        let expected = MarkdownDocument(blocks: [
            .paragraph([
                Span(text: "| a | b |\n| --- |", style: [], link: nil)
            ])
        ])

        XCTAssertEqual(parse("| a | b |\n| --- |"), expected)
    }

    func testEscapedPipeStaysInsideTableCell() {
        let actual = parse("| Value | Status |\n| --- | --- |\n| a \\| b | ready |")
        let expected = MarkdownDocument(blocks: [
            .table(
                header: [
                    [Span(text: "Value", style: [], link: nil)],
                    [Span(text: "Status", style: [], link: nil)]
                ],
                rows: [
                    [
                        [Span(text: "a | b", style: [], link: nil)],
                        [Span(text: "ready", style: [], link: nil)]
                    ]
                ]
            )
        ])

        XCTAssertEqual(actual, expected)
    }

    func testATXHeadingStripsClosingHashes() {
        let expected = MarkdownDocument(blocks: [
            .heading(level: 2, spans: [
                Span(text: "Title", style: [], link: nil)
            ])
        ])

        XCTAssertEqual(parse("## Title ##"), expected)
    }

    func testLongFenceKeepsShorterBacktickLineAsCode() {
        let expected = MarkdownDocument(blocks: [
            .codeBlock(language: nil, code: "```")
        ])

        XCTAssertEqual(parse("````\n```\n````"), expected)
    }

    func testFourBacktickFenceClosesWithFourBackticks() {
        let expected = MarkdownDocument(blocks: [
            .codeBlock(language: "swift", code: "let value = 1")
        ])

        XCTAssertEqual(parse("````swift\nlet value = 1\n````"), expected)
    }

    func testEmptyInputIsAnEmptyDocument() {
        XCTAssertEqual(parse(""), MarkdownDocument(blocks: []))
    }

    func testUnclosedEmphasisIsLiteral() {
        let expected = MarkdownDocument(blocks: [
            .paragraph([Span(text: "a **b", style: [], link: nil)])
        ])

        XCTAssertEqual(parse("a **b"), expected)
    }

    func testUnterminatedFenceDoesNotSwallowTheDocument() {
        let actual = parse("```swift\nlet x = **1**;\n\n# Later")
        let expected = MarkdownDocument(blocks: [
            .paragraph([
                Span(text: "```swift\nlet x = **1**;", style: [], link: nil)
            ]),
            .heading(level: 1, spans: [
                Span(text: "Later", style: [], link: nil)
            ])
        ])

        XCTAssertEqual(actual, expected)
    }

    func testCodeSpanKeepsMarkers() {
        let expected = MarkdownDocument(blocks: [
            .paragraph([Span(text: "**not bold**", style: .code, link: nil)])
        ])

        XCTAssertEqual(parse("`**not bold**`"), expected)
    }

    func testAdjacentSpansOfTheSameStyleMerge() {
        let expected = MarkdownDocument(blocks: [
            .paragraph([Span(text: "onetwo", style: .bold, link: nil)])
        ])

        XCTAssertEqual(parse("**one****two**"), expected)
    }

    func testAdjacentSpansMergeOnlyWhenStyleAndLinkMatch() {
        let expected = MarkdownDocument(blocks: [
            .paragraph([
                Span(text: "onetwo", style: [], link: "same"),
                Span(text: "three", style: [], link: "different")
            ])
        ])

        XCTAssertEqual(parse("[one](same)[two](same)[three](different)"), expected)
    }

    func testEmptyTextSpansAreDropped() {
        XCTAssertEqual(
            parse("``"),
            MarkdownDocument(blocks: [.paragraph([])])
        )
    }

    func testIntrawordUnderscoresToggleItalic() {
        let expected = MarkdownDocument(blocks: [
            .paragraph([
                Span(text: "a", style: [], link: nil),
                Span(text: "b", style: .italic, link: nil),
                Span(text: "c", style: [], link: nil)
            ])
        ])

        XCTAssertEqual(parse("a_b_c"), expected)
    }

    func testBoldMarkersIgnoreSurroundingSpaces() {
        let expected = MarkdownDocument(blocks: [
            .paragraph([Span(text: " x ", style: .bold, link: nil)])
        ])

        XCTAssertEqual(parse("** x **"), expected)
    }

    func testThreeAsteriskEmphasisUsesLongestMarkerFirst() {
        let expected = MarkdownDocument(blocks: [
            .paragraph([
                Span(text: "x", style: [.bold, .italic], link: nil)
            ])
        ])

        XCTAssertEqual(parse("***x***"), expected)
    }

    func testIndentedUnorderedItemsFlattenIntoOneList() {
        let expected = MarkdownDocument(blocks: [
            .bulletList([
                [Span(text: "a", style: [], link: nil)],
                [Span(text: "b", style: [], link: nil)]
            ])
        ])

        XCTAssertEqual(parse("- a\n  - b"), expected)
    }

    func testTaskListCheckboxIsLiteralItemText() {
        let expected = MarkdownDocument(blocks: [
            .bulletList([
                [Span(text: "[ ] x", style: [], link: nil)]
            ])
        ])

        XCTAssertEqual(parse("- [ ] x"), expected)
    }

    func testParagraphSoftBreakIsPreservedAsNewline() {
        let expected = MarkdownDocument(blocks: [
            .paragraph([
                Span(text: "line one\nline two", style: [], link: nil)
            ])
        ])

        XCTAssertEqual(parse("line one\nline two"), expected)
    }
}
