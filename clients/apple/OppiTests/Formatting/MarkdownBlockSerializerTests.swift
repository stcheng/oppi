import Testing
@testable import Oppi

@Suite("MarkdownBlockSerializer")
struct MarkdownBlockSerializerTests {

    @Test func serializesAllBlockVariants() {
        let blocks: [MarkdownBlock] = [
            .heading(level: 2, inlines: [.text("Heading")]),
            .paragraph([.text("Paragraph")]),
            .blockQuote([
                .paragraph([.text("Quoted")]),
            ]),
            .codeBlock(language: "swift", code: "let value = 1\n"),
            .unorderedList([
                [.paragraph([.text("one")])],
                [.paragraph([.text("two")])],
            ]),
            .orderedList(start: 3, [
                [.paragraph([.text("third")])],
                [.paragraph([.text("fourth")])],
            ]),
            .taskList([
                .init(checked: true, content: [.paragraph([.text("done")])]),
                .init(checked: false, content: [.paragraph([.text("todo")])]),
            ]),
            .thematicBreak,
            .table(
                headers: [[.text("Name")], [.text("Age")]],
                rows: [
                    [[.text("Alice")], [.text("30")]],
                    [[.text("Bob")], [.text("25")]],
                ]
            ),
            .htmlBlock("<details>raw</details>"),
        ]

        let markdown = MarkdownBlockSerializer.serialize(blocks)

        #expect(markdown.contains("## Heading"))
        #expect(markdown.contains("Paragraph"))
        #expect(markdown.contains("> Quoted"))
        #expect(markdown.contains("```swift\nlet value = 1\n```")) // trailing newline trimmed
        #expect(markdown.contains("- one"))
        #expect(markdown.contains("3. third"))
        #expect(markdown.contains("- [x] done"))
        #expect(markdown.contains("- [ ] todo"))
        #expect(markdown.contains("---"))
        #expect(markdown.contains("| Name | Age |"))
        #expect(markdown.contains("<details>raw</details>"))
    }

    @Test func serializesInlineVariantsIncludingEdgeCases() {
        let inlines: [MarkdownInline] = [
            .text("text"),
            .emphasis([.text("em")]),
            .strong([.text("strong")]),
            .code("plain"),
            .code("tick`inside"),
            .link(children: [.text("site")], destination: "https://example.com"),
            .link(children: [.text("fallback")], destination: nil),
            .image(alt: "logo", source: nil),
            .softBreak,
            .hardBreak,
            .html("<span>raw</span>"),
            .strikethrough([.text("gone")]),
        ]

        let serialized = MarkdownBlockSerializer.serializeInlines(inlines)

        #expect(serialized.contains("*em*"))
        #expect(serialized.contains("**strong**"))
        #expect(serialized.contains("`plain`"))
        #expect(serialized.contains("`` tick`inside ``"))
        #expect(serialized.contains("[site](https://example.com)"))
        #expect(serialized.contains("fallback"))
        #expect(serialized.contains("![logo]()"))
        #expect(serialized.contains("\n  \n"))
        #expect(serialized.contains("<span>raw</span>"))
        #expect(serialized.contains("~~gone~~"))
    }

    @Test func emptyTableHeadersSerializeToEmptyString() {
        let markdown = MarkdownBlockSerializer.serialize([
            .table(headers: [], rows: []),
        ])
        #expect(markdown.isEmpty)
    }
}
