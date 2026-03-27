import Testing
import Foundation
@testable import Oppi

// MARK: - Org Render Pipeline Correctness Tests
//
// These tests verify the FULL pipeline that optimization changes must preserve:
// 1. OrgParser.parse() → [OrgBlock]
// 2. buildOrgSectionTree() → [OrgSection]
// 3. OrgToMarkdownConverter.convert() → [MarkdownBlock]
// 4. MarkdownBlockSerializer.serialize() → String
// 5. parseCommonMark() → [MarkdownBlock] (roundtrip check)
//
// Coverage:
// [x] Heading markdown output — level, bullets, keywords, tags
// [x] Body content preservation — paragraphs, lists, code blocks
// [x] Table roundtrip — headers and rows survive serialization
// [x] Section tree → markdown reconstruction — full document
// [x] Markdown roundtrip fidelity — org → md string → CommonMark parse → same structure
// [x] Instance count — number of markdown groups per section type

@Suite("OrgRenderPipeline")
struct OrgRenderPipelineTests {

    let parser = OrgParser()

    // MARK: - Helpers

    /// Full pipeline: org text → section tree → per-section markdown strings.
    /// Returns a FLAT array of (heading markdown, [body markdown strings]) per section,
    /// recursing into children to match the actual MarkdownContentViewWrapper count.
    private func renderSections(_ input: String) -> [(heading: String?, bodies: [String])] {
        let blocks = parser.parse(input)
        let (sections, _) = buildOrgSectionTree(blocks)
        var result: [(heading: String?, bodies: [String])] = []
        flattenSections(sections, into: &result)
        return result
    }

    private func flattenSections(_ sections: [OrgSection], into result: inout [(heading: String?, bodies: [String])]) {
        for section in sections {
            let heading: String?
            if let h = section.heading {
                heading = serializeHeading(h, section: section)
            } else {
                heading = nil
            }
            let bodies = bodiesForSection(section)
            result.append((heading: heading, bodies: bodies))
            flattenSections(section.children, into: &result)
        }
    }

    /// Reproduce the heading markdown construction from OrgSectionView.headingMarkdown
    private func serializeHeading(_ heading: OrgBlock, section: OrgSection) -> String {
        guard case .heading(let level, let keyword, _, let title, let tags) = heading else {
            return ""
        }
        var inlines = [MarkdownInline]()

        // Use a stable bullet for testing (expanded state)
        let expandedBullets = ["◈", "•", "‣", "◦", "·", "·"]
        let idx = min(level - 1, expandedBullets.count - 1)
        inlines.append(.text("\(expandedBullets[idx]) "))

        if let kw = keyword {
            inlines.append(.strong([.text(kw)]))
            inlines.append(.text(" "))
        }
        inlines.append(contentsOf: title.map { OrgToMarkdownConverter.convertSingleInline($0) })
        if !tags.isEmpty {
            inlines.append(.text("  "))
            inlines.append(.code(":" + tags.joined(separator: ":") + ":"))
        }
        let mdBlocks: [MarkdownBlock] = [.heading(level: min(level, 6), inlines: inlines)]
        return MarkdownBlockSerializer.serialize(mdBlocks)
    }

    /// Get body markdown strings from pre-computed body groups.
    private func bodiesForSection(_ section: OrgSection) -> [String] {
        section.precomputedBodyGroups.compactMap {
            if case .markdown(let md) = $0 { return md }
            return nil
        }
    }

    // MARK: - Heading Markdown Output

    @Test("Level 1 heading produces H1 markdown")
    func level1HeadingMarkdown() {
        let rendered = renderSections("* Introduction")
        #expect(rendered.count == 1)
        let heading = rendered[0].heading!
        #expect(heading.hasPrefix("# "))
        #expect(heading.contains("Introduction"))
    }

    @Test("Level 3 heading produces H3 markdown")
    func level3HeadingMarkdown() {
        let rendered = renderSections("*** Deep Section")
        #expect(rendered.count == 1)
        let heading = rendered[0].heading!
        #expect(heading.hasPrefix("### "))
        #expect(heading.contains("Deep Section"))
    }

    @Test("Heading with TODO keyword includes bold keyword")
    func headingWithTodo() {
        let rendered = renderSections("* TODO Fix bug")
        let heading = rendered[0].heading!
        #expect(heading.contains("**TODO**"))
        #expect(heading.contains("Fix bug"))
    }

    @Test("Heading with tags includes code-formatted tags")
    func headingWithTags() {
        let rendered = renderSections("* Meeting :work:planning:")
        let heading = rendered[0].heading!
        #expect(heading.contains("`"))
        #expect(heading.contains("work"))
        #expect(heading.contains("planning"))
    }

    @Test("Heading level clamped at 6")
    func headingLevelClamped() {
        let rendered = renderSections("******* Deep")
        let heading = rendered[0].heading!
        #expect(heading.hasPrefix("###### "))
    }

    // MARK: - Body Content Preservation

    @Test("Paragraph body preserved through pipeline")
    func paragraphPreserved() {
        let rendered = renderSections("* Title\nHello world.")
        #expect(rendered[0].bodies.count == 1)
        #expect(rendered[0].bodies[0].contains("Hello world"))
    }

    @Test("Bold text preserved through pipeline")
    func boldPreserved() {
        let rendered = renderSections("* Title\nThis is *important* text.")
        let body = rendered[0].bodies[0]
        #expect(body.contains("**important**"))
    }

    @Test("Italic text preserved through pipeline")
    func italicPreserved() {
        let rendered = renderSections("* Title\nThis is /emphasized/ text.")
        let body = rendered[0].bodies[0]
        #expect(body.contains("*emphasized*"))
    }

    @Test("Code inline preserved through pipeline")
    func codePreserved() {
        let rendered = renderSections("* Title\nUse ~println~ function.")
        let body = rendered[0].bodies[0]
        #expect(body.contains("`println`"))
    }

    @Test("Link preserved through pipeline")
    func linkPreserved() {
        let rendered = renderSections("* Title\nVisit [[https://example.com][Example]].")
        let body = rendered[0].bodies[0]
        #expect(body.contains("[Example](https://example.com)"))
    }

    @Test("Code block preserved through pipeline")
    func codeBlockPreserved() {
        let input = """
        * Title
        #+begin_src python
        def hello():
            pass
        #+end_src
        """
        let rendered = renderSections(input)
        let body = rendered[0].bodies[0]
        #expect(body.contains("```python"))
        #expect(body.contains("def hello()"))
        #expect(body.contains("```"))
    }

    @Test("List preserved through pipeline")
    func listPreserved() {
        let input = """
        * Title
        - Item one
        - Item two
        """
        let rendered = renderSections(input)
        let body = rendered[0].bodies[0]
        #expect(body.contains("- Item one"))
        #expect(body.contains("- Item two"))
    }

    @Test("Ordered list preserved through pipeline")
    func orderedListPreserved() {
        let input = """
        * Title
        1. First
        2. Second
        """
        let rendered = renderSections(input)
        let body = rendered[0].bodies[0]
        #expect(body.contains("1. First"))
        #expect(body.contains("2. Second"))
    }

    @Test("Checkbox list preserved through pipeline")
    func checkboxListPreserved() {
        let input = """
        * Tasks
        - [X] Done
        - [ ] Pending
        """
        let rendered = renderSections(input)
        let body = rendered[0].bodies[0]
        #expect(body.contains("[x]"))
        #expect(body.contains("[ ]"))
    }

    @Test("Horizontal rule preserved")
    func horizontalRulePreserved() {
        let input = """
        * Title
        Before

        -----

        After
        """
        let rendered = renderSections(input)
        // Rule should be in body
        let body = rendered[0].bodies[0]
        #expect(body.contains("---"))
    }

    @Test("Quote block preserved")
    func quoteBlockPreserved() {
        let input = """
        * Title
        #+begin_quote
        Wise words.
        #+end_quote
        """
        let rendered = renderSections(input)
        let body = rendered[0].bodies[0]
        #expect(body.contains("> Wise words"))
    }

    @Test("Table preserved through pipeline")
    func tablePreserved() {
        let input = """
        * Data
        | Name | Age |
        |------+-----|
        | Alice | 30 |
        """
        let rendered = renderSections(input)
        let body = rendered[0].bodies[0]
        #expect(body.contains("| Name"))
        #expect(body.contains("| ---"))
        #expect(body.contains("Alice"))
    }

    // MARK: - Markdown Roundtrip Fidelity

    @Test("Simple paragraph survives CommonMark roundtrip")
    func paragraphRoundtrip() {
        let orgInput = "* Title\nA simple paragraph."
        let rendered = renderSections(orgInput)
        let md = rendered[0].bodies[0]

        // Parse through CommonMark and verify structure
        let blocks = parseCommonMark(md)
        #expect(blocks.count == 1)
        if case .paragraph(let inlines) = blocks[0] {
            let text = inlines.map { inline -> String in
                if case .text(let t) = inline { return t }
                return ""
            }.joined()
            #expect(text.contains("simple paragraph"))
        } else {
            Issue.record("Expected paragraph from CommonMark")
        }
    }

    @Test("Heading markdown survives CommonMark roundtrip")
    func headingRoundtrip() {
        let rendered = renderSections("* Chapter One")
        let headingMd = rendered[0].heading!

        let blocks = parseCommonMark(headingMd)
        #expect(blocks.count == 1)
        if case .heading(let level, _) = blocks[0] {
            #expect(level == 1)
        } else {
            Issue.record("Expected heading from CommonMark")
        }
    }

    @Test("Code block survives CommonMark roundtrip")
    func codeBlockRoundtrip() {
        let input = """
        * Title
        #+begin_src swift
        let x = 42
        #+end_src
        """
        let rendered = renderSections(input)
        let md = rendered[0].bodies[0]
        let blocks = parseCommonMark(md)

        let hasCodeBlock = blocks.contains {
            if case .codeBlock(let lang, let code) = $0 {
                return lang == "swift" && code.contains("let x = 42")
            }
            return false
        }
        #expect(hasCodeBlock)
    }

    // MARK: - Instance Count Verification

    @Test("Single section with paragraph — 1 heading + 1 body wrapper")
    func instanceCountSimple() {
        let rendered = renderSections("* Title\nBody text.")
        #expect(rendered[0].heading != nil)
        #expect(rendered[0].bodies.count == 1)
        // Total MarkdownContentViewWrapper instances: 2
    }

    @Test("Section with drawer — heading + N body groups")
    func instanceCountWithDrawer() {
        let input = """
        * Title
        Before drawer.
        :PROPERTIES:
        :ID: 123
        :END:
        After drawer.
        """
        let rendered = renderSections(input)
        // Drawers create separate groups (rendered natively, not as markdown)
        // So: heading=1, body groups = before + after = 2
        #expect(rendered[0].heading != nil)
        #expect(rendered[0].bodies.count == 2)
    }

    @Test("Full document instance count")
    func fullDocumentInstanceCount() {
        let input = """
        #+TITLE: Guide

        Introduction.

        * Chapter 1
        Chapter body.

        ** Section 1.1
        :PROPERTIES:
        :ID: sec11
        :END:
        Section body.

        ** Section 1.2
        Content.

        * Chapter 2
        - List item
        """
        let rendered = renderSections(input)

        // Count total MarkdownContentViewWrapper instances
        var headingCount = 0
        var bodyGroupCount = 0
        for r in rendered {
            if r.heading != nil { headingCount += 1 }
            bodyGroupCount += r.bodies.count
        }

        // Flat (recursive) section list:
        //   Zeroth: heading=nil, body=1 (TITLE keyword + intro paragraph converted to md)
        //   Chapter 1: heading=1, body=1
        //   Section 1.1: heading=1, body=1 (drawer excluded from md, just "Section body.")
        //   Section 1.2: heading=1, body=1
        //   Chapter 2: heading=1, body=1
        #expect(headingCount == 4) // 4 heading sections (zeroth has none)
        #expect(bodyGroupCount >= 5) // zeroth + 4 sections with body
    }

    // MARK: - Full Document Pipeline Test

    @Test("Full org document renders without data loss")
    func fullDocumentNoDataLoss() {
        let input = """
        #+TITLE: Test Document
        #+AUTHOR: Tester

        * Introduction

        Welcome to the *guide*. Visit [[https://example.com][our site]].

        ** Getting Started

        1. Install the tool
        2. Run the setup

        #+begin_src bash
        ./setup.sh
        #+end_src

        ** Configuration :config:

        Set ~debug = true~ in the config file.

        | Key | Value |
        |-----+-------|
        | debug | true |

        * FAQ

        #+begin_quote
        The only bad question is the one not asked.
        #+end_quote

        -----

        * Changelog

        - [X] v1.0 released
        - [ ] v2.0 pending
        """
        let rendered = renderSections(input)

        // Collect all output text (headings + bodies)
        let allHeadings = rendered.compactMap { $0.heading }
        let allBodies = rendered.flatMap { $0.bodies }
        let allText = (allHeadings + allBodies).joined(separator: "\n")

        // Verify key content survives the pipeline
        #expect(allText.contains("Welcome"))
        #expect(allText.contains("**guide**"))
        #expect(allText.contains("[our site](https://example.com)"))
        #expect(allText.contains("1. Install"))
        #expect(allText.contains("```bash"))
        #expect(allText.contains("./setup.sh"))
        #expect(allText.contains("`debug = true`"))
        #expect(allText.contains("| Key"))
        #expect(allText.contains("> The only bad question"))
        #expect(allText.contains("---"))
        #expect(allText.contains("[x]"))
        #expect(allText.contains("[ ]"))

        // Verify heading content
        let headingText = allHeadings.joined(separator: "\n")
        #expect(headingText.contains("Introduction"))
        #expect(headingText.contains("Getting Started"))
        #expect(headingText.contains("Configuration"))
        #expect(headingText.contains("FAQ"))
        #expect(headingText.contains("Changelog"))
    }

    // MARK: - Conversion Edge Cases

    @Test("STARTUP keyword is skipped in conversion")
    func startupSkipped() {
        let blocks = parser.parse("#+STARTUP: overview")
        let mdBlocks = OrgToMarkdownConverter.convert(blocks)
        #expect(mdBlocks.isEmpty)
    }

    @Test("OPTIONS keyword is skipped in conversion")
    func optionsSkipped() {
        let blocks = parser.parse("#+OPTIONS: toc:nil")
        let mdBlocks = OrgToMarkdownConverter.convert(blocks)
        #expect(mdBlocks.isEmpty)
    }

    @Test("Comments are skipped in conversion")
    func commentsSkipped() {
        let blocks = parser.parse("# A comment")
        let mdBlocks = OrgToMarkdownConverter.convert(blocks)
        #expect(mdBlocks.isEmpty)
    }

    @Test("Underline converts to emphasis (markdown has no underline)")
    func underlineToEmphasis() {
        let blocks = parser.parse("_underlined_ text")
        let mdBlocks = OrgToMarkdownConverter.convert(blocks)
        guard case .paragraph(let inlines) = mdBlocks[0] else {
            Issue.record("Expected paragraph"); return
        }
        guard case .emphasis = inlines[0] else {
            Issue.record("Expected emphasis for underline"); return
        }
    }

    @Test("Verbatim and code both map to code in markdown")
    func verbatimAndCodeToCode() {
        let blocks = parser.parse("Use =verbatim= and ~code~")
        let mdBlocks = OrgToMarkdownConverter.convert(blocks)
        guard case .paragraph(let inlines) = mdBlocks[0] else {
            Issue.record("Expected paragraph"); return
        }
        let codeCount = inlines.filter { if case .code = $0 { return true }; return false }.count
        #expect(codeCount == 2)
    }
}
