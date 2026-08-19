// These cases mirror the spec's golden examples so changing either contract
// requires changing the other.
import XCTest
import AgentMarkdown

final class PreviewTests: XCTestCase {
    func testP1FirstParagraph() {
        let actual = previewLine("# Title\n\nThe body **here**.")
        let expected = [
            Span(text: "The body ", style: [], link: nil),
            Span(text: "here", style: .bold, link: nil),
            Span(text: ".", style: [], link: nil)
        ]

        XCTAssertEqual(actual, expected)
    }

    func testP2ListFallback() {
        let actual = previewLine("- only a list\n- second")
        let expected = [
            Span(text: "only a list", style: [], link: nil)
        ]

        XCTAssertEqual(actual, expected)
    }

    func testP3WhitespaceCollapse() {
        let actual = previewLine("line one\nline two")
        let expected = [
            Span(text: "line one line two", style: [], link: nil)
        ]

        XCTAssertEqual(actual, expected)
    }

    func testP4CroppedMarker() {
        let actual = previewLine("Done.", cropped: true)
        let expected = [
            Span(text: "Done.", style: [], link: nil),
            Span(text: AgentMarkdown.croppedMarker, style: [], link: nil)
        ]

        XCTAssertEqual(actual, expected)
    }
}
