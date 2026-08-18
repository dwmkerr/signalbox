signalbox specifications: [jumplist](https://dwmkerr.github.io/signalbox/specs/hub-jumplist.html) | [settings](https://dwmkerr.github.io/signalbox/specs/settings.html) | [menu bar](https://dwmkerr.github.io/signalbox/specs/menubar.html) | [ios](https://dwmkerr.github.io/signalbox/specs/ios.html) | [architecture](https://dwmkerr.github.io/signalbox/specs/architecture.html) | [cli](cli.md) | [data model](events.md) | [agent integrations](adapters.md) | agent markdown

# Specification: agent markdown

## 1. What this is

Agents reply in markdown, and the hub carries it raw (see the [data model](events.md)). Both apps render it through one shared Swift package, `components/shared/AgentMarkdown`, so a heading looks like a heading on the Mac and on the phone. The package parses markdown into a platform-neutral intermediate representation and paints that IR per platform. The IR is the contract this spec pins down; the paint is styling and may differ: the Mac renders terminal-style in a mono font, while iOS renders softer proportional chat bubbles.

## 2. The IR

The parser produces these exact types, and the tests assert them:

```swift
public struct MarkdownDocument: Equatable, Sendable { public var blocks: [Block] }

public enum Block: Equatable, Sendable {
    case paragraph([Span])
    case heading(level: Int, spans: [Span])        // level 1...6
    case bulletList([[Span]])                      // one [Span] per item
    case orderedList(start: Int, items: [[Span]])
    case codeBlock(language: String?, code: String)
    case table(header: [[Span]], rows: [[[Span]]])
}

public struct Span: Equatable, Sendable {
    public var text: String
    public var style: SpanStyle
    public var link: String?
}

public struct SpanStyle: OptionSet, Sendable {
    public static let bold: SpanStyle
    public static let italic: SpanStyle
    public static let code: SpanStyle
}
```

Every span array is canonical. The parser drops spans whose `text` is empty and merges adjacent spans when both `style` and `link` are identical. The exact span counts in the golden examples rely on this canonicalization.

## 3. Recognized grammar (v1)

| Construct | Markdown | IR | Terminal styling (Mac) |
|---|---|---|---|
| bold | `**text**` or `__text__` | `Span(style: .bold)` | bold mono |
| italic | `*text*` or `_text_` | `Span(style: .italic)` | italic mono |
| inline code | `` `text` `` | `Span(style: .code)` | tinted mono |
| link | `[label](url)` | `Span(text: "label", link: "url")` | accent colour, underlined |
| heading | `# text` .. `###### text` | `.heading(level:spans:)` | bold mono, one blank line above |
| unordered list | `- item` / `* item` / `+ item` | `.bulletList` | `•` bullet, hanging indent |
| ordered list | `1. item` | `.orderedList(start:items:)` | `N.` marker, hanging indent |
| fenced code block | 3+ backticks with an optional language word and a matching-or-longer close | `.codeBlock(language:code:)` | tinted mono block, no inline parsing inside |
| table | GFM pipe table with matching header and delimiter cell counts; escaped pipes (\|) stay in cells | `.table(header:rows:)` | mono, columns padded to the widest cell (best effort) |

Consecutive nonblank lines in the same paragraph are joined with exactly one newline character (U+000A) in the span text. The parser never collapses whitespace. Only `previewLine` performs whitespace collapse.

List indentation has no nesting semantics in v1. An indented list marker line joins the same flat list, and items remain in source order. For example, `- a` followed by `  - b` produces one bullet list with two items. Task-list checkboxes have no special semantics: `[ ] ` and `[x] ` after a list marker remain literal item text, so `- [ ] x` produces an item whose text is `[ ] x`.

Emphasis uses a simple left-to-right toggle scan, deliberately not CommonMark flanking. At each position, longer markers win: `**` and `__` are checked before `*` and `_`. A recognized marker toggles its style regardless of surrounding characters, so `a_b_c` italicizes `b` and `** x **` produces one bold span containing ` x `. An opener with no matching marker later in the text remains literal. With the longer-marker rule, `***x***` produces exactly one span, `Span(text: "x", style: [.bold, .italic], link: nil)`.

The deliberate exclusions for v1 are blockquotes, horizontal rules, images, nested list structure, task-list semantics, HTML, reference links, setext headings, and autolinks. Unsupported standalone constructs are rendered as plain paragraph text. Indented list markers and checkbox-looking item prefixes follow the flat list rules above. Inline markers inside a code span or a fenced block are never interpreted. Unclosed emphasis and an unterminated fence degrade to literal text rather than swallowing the rest of the document.

## 4. The one-line preview rule

List rows on both platforms use `previewLine`. Take the first paragraph block. If the document has no paragraph, take the first block's spans: a heading's spans, a list's first item, a code block's first line as a single `.code` span, or a table's first header cell. Apply inline styles only; block constructs contribute no markers. Collapse every whitespace run, including newlines preserved from paragraph soft breaks, to one space character (U+0020). This collapse happens only in the preview and does not change the parsed IR. The result is a `[Span]`, never a `String`, so a row can still bold a word.

## 5. Cropped

The cropped marker never enters the parsed IR. When the source event carries `cropped: true`, `previewLine` appends `…` (U+2026, a single character) as a separate unstyled span. A painter appends the same marker after painting the document. If the last block is a paragraph, heading, bullet list, or ordered list, the marker follows the content on that block's final line. If the last block is a code block or table, the painter emits the marker on its own trailing line. For an empty document, the marker is the entire painted output. The marker is exposed as `AgentMarkdown.croppedMarker` so there is exactly one definition.

## 6. Paint

The platform painters expose `render(_:style:cropped:)` for a parsed `MarkdownDocument` or raw markdown, plus `render(spans:style:)` for previews. macOS uses `TerminalStyle` to return an `NSAttributedString`; iOS uses `ChatStyle` to return an `AttributedString`. Bold and italic styles compose into a bold-italic face, while code uses the code font and colour in preference to either emphasis style. The caller owns the palette so each app keeps control of its theme. Tests pin contract-level text placement, while platform-specific pixels remain outside the unit-test contract.

## 7. Golden examples

The package's tests mirror these examples one for one, so the spec and the tests cannot drift.

1. **G1 emphasis**

   Input:

   ```markdown
   Done - the **dashboard** now shows *per-post* traffic.
   ```

   Expected IR, with the paragraph split into exactly five spans:

   ```swift
   MarkdownDocument(blocks: [
       .paragraph([
           Span(text: "Done - the ", style: [], link: nil),
           Span(text: "dashboard", style: .bold, link: nil),
           Span(text: " now shows ", style: [], link: nil),
           Span(text: "per-post", style: .italic, link: nil),
           Span(text: " traffic.", style: [], link: nil)
       ])
   ])
   ```

2. **G2 inline code**

   Input:

   ```markdown
   Run `make build` first.
   ```

   Expected IR:

   ```swift
   MarkdownDocument(blocks: [
       .paragraph([
           Span(text: "Run ", style: [], link: nil),
           Span(text: "make build", style: .code, link: nil),
           Span(text: " first.", style: [], link: nil)
       ])
   ])
   ```

3. **G3 link**

   Input:

   ```markdown
   See [the spec](https://example.com/s) for detail.
   ```

   Expected IR:

   ```swift
   MarkdownDocument(blocks: [
       .paragraph([
           Span(text: "See ", style: [], link: nil),
           Span(text: "the spec", style: [], link: "https://example.com/s"),
           Span(text: " for detail.", style: [], link: nil)
       ])
   ])
   ```

4. **G4 heading plus paragraph**

   Input:

   ```markdown
   ## Summary

   All green.
   ```

   Expected IR:

   ```swift
   MarkdownDocument(blocks: [
       .heading(level: 2, spans: [
           Span(text: "Summary", style: [], link: nil)
       ]),
       .paragraph([
           Span(text: "All green.", style: [], link: nil)
       ])
   ])
   ```

5. **G5 unordered list**

   Input:

   ```markdown
   - one
   - **two**
   ```

   Expected IR:

   ```swift
   MarkdownDocument(blocks: [
       .bulletList([
           [Span(text: "one", style: [], link: nil)],
           [Span(text: "two", style: .bold, link: nil)]
       ])
   ])
   ```

6. **G6 ordered list**

   Input:

   ```markdown
   3. third
   4. fourth
   ```

   Expected IR:

   ```swift
   MarkdownDocument(blocks: [
       .orderedList(start: 3, items: [
           [Span(text: "third", style: [], link: nil)],
           [Span(text: "fourth", style: [], link: nil)]
       ])
   ])
   ```

7. **G7 fenced code**

   Input:

   ````markdown
   ```ts
   const x = **1**;
   ```
   ````

   Expected IR, proving that inline markers are not parsed inside a fence:

   ```swift
   MarkdownDocument(blocks: [
       .codeBlock(language: "ts", code: "const x = **1**;")
   ])
   ```

8. **G8 table**

   Input:

   ```markdown
   | Name | Status |
   |---|---|
   | Parser | ready |
   | Paint | next |
   ```

   Expected IR, with the exact spans for every cell:

   ```swift
   MarkdownDocument(blocks: [
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
   ```

The preview goldens apply the same contract to `previewLine`:

1. **P1 first paragraph**

   Input:

   ```markdown
   # Title

   The body **here**.
   ```

   Expected IR, using the body paragraph rather than the heading:

   ```swift
   [
       Span(text: "The body ", style: [], link: nil),
       Span(text: "here", style: .bold, link: nil),
       Span(text: ".", style: [], link: nil)
   ]
   ```

2. **P2 list fallback**

   Input:

   ```markdown
   - only a list
   - second
   ```

   Expected IR:

   ```swift
   [
       Span(text: "only a list", style: [], link: nil)
   ]
   ```

3. **P3 whitespace collapse**

   Input:

   ```markdown
   line one
   line two
   ```

   Expected IR:

   ```swift
   [
       Span(text: "line one line two", style: [], link: nil)
   ]
   ```

4. **P4 cropped marker**

   Input with `cropped: true`:

   ```markdown
   Done.
   ```

   Expected IR:

   ```swift
   [
       Span(text: "Done.", style: [], link: nil),
       Span(text: AgentMarkdown.croppedMarker, style: [], link: nil)
   ]
   ```

## 8. Growing this

The parser takes a `dialect` parameter that defaults to `.common`, so a future per-agent dialect, such as an agent that emits its own conventions, is added as a case without changing any call site.
