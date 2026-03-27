import Testing
@testable import Oppi

// MARK: - Section Tree Building Tests
//
// Coverage:
// [x] Flat document — all headings at same level
// [x] Nested headings — parent-child relationships
// [x] Deep nesting — 3+ heading levels
// [x] Mixed levels — non-monotonic heading levels
// [x] Zeroth section — body before first heading
// [x] Empty sections — headings with no body
// [x] Body block assignment — correct blocks per section
// [x] Child count — correct nesting at each level
// [x] Fold state — overview, content, showAll, nofold, default
// [x] groupBodyBlocks — drawer separation, markdown consolidation
// [x] Section identity — stable structure across calls

@Suite("OrgSectionTree")
struct OrgSectionTreeTests {

    let parser = OrgParser()

    // MARK: - Helpers

    private func sections(_ input: String) -> [OrgSection] {
        let blocks = parser.parse(input)
        return buildOrgSectionTree(blocks).sections
    }

    private func foldState(_ input: String) -> OrgFoldState {
        let blocks = parser.parse(input)
        return buildOrgSectionTree(blocks).foldState
    }

    // MARK: - Flat Documents

    @Test("Single heading, no body")
    func singleHeadingNoBody() {
        let result = sections("* Heading")
        #expect(result.count == 1)
        #expect(result[0].level == 1)
        #expect(result[0].bodyBlocks.isEmpty)
        #expect(result[0].children.isEmpty)
    }

    @Test("Single heading with body")
    func singleHeadingWithBody() {
        let result = sections("* Heading\nSome body text.")
        #expect(result.count == 1)
        #expect(result[0].level == 1)
        #expect(result[0].bodyBlocks.count == 1)
        if case .paragraph = result[0].bodyBlocks[0] { }
        else { Issue.record("Expected paragraph body") }
    }

    @Test("Three level-1 headings — flat list, no nesting")
    func flatLevel1() {
        let input = """
        * A
        * B
        * C
        """
        let result = sections(input)
        #expect(result.count == 3)
        for s in result {
            #expect(s.level == 1)
            #expect(s.children.isEmpty)
        }
    }

    @Test("Five level-2 headings — flat list at level 2")
    func flatLevel2() {
        // Without a level-1 parent, these are all root-level sections
        let input = """
        ** A
        ** B
        ** C
        ** D
        ** E
        """
        let result = sections(input)
        #expect(result.count == 5)
        for s in result {
            #expect(s.level == 2)
            #expect(s.children.isEmpty)
        }
    }

    // MARK: - Nested Headings

    @Test("Level 1 with level 2 children")
    func level1WithLevel2Children() {
        let input = """
        * Parent
        ** Child 1
        ** Child 2
        """
        let result = sections(input)
        #expect(result.count == 1)
        #expect(result[0].level == 1)
        #expect(result[0].children.count == 2)
        #expect(result[0].children[0].level == 2)
        #expect(result[0].children[1].level == 2)
    }

    @Test("Two parents with children")
    func twoParentsWithChildren() {
        let input = """
        * Parent A
        ** Child A1
        ** Child A2
        * Parent B
        ** Child B1
        """
        let result = sections(input)
        #expect(result.count == 2)
        #expect(result[0].children.count == 2)
        #expect(result[1].children.count == 1)
    }

    @Test("Deep nesting — 4 levels")
    func deepNesting4Levels() {
        let input = """
        * Level 1
        ** Level 2
        *** Level 3
        **** Level 4
        """
        let result = sections(input)
        #expect(result.count == 1)
        #expect(result[0].level == 1)
        #expect(result[0].children.count == 1)
        #expect(result[0].children[0].level == 2)
        #expect(result[0].children[0].children.count == 1)
        #expect(result[0].children[0].children[0].level == 3)
        #expect(result[0].children[0].children[0].children.count == 1)
        #expect(result[0].children[0].children[0].children[0].level == 4)
        #expect(result[0].children[0].children[0].children[0].children.isEmpty)
    }

    @Test("Non-monotonic heading levels — skip levels")
    func skipLevels() {
        // Level 1 then level 3 — level 3 is a child of level 1
        let input = """
        * Top
        *** Skipped to 3
        """
        let result = sections(input)
        #expect(result.count == 1)
        #expect(result[0].level == 1)
        #expect(result[0].children.count == 1)
        #expect(result[0].children[0].level == 3)
    }

    @Test("Sibling after deep nesting — back to parent level")
    func siblingAfterDeepNesting() {
        let input = """
        * A
        ** A1
        *** A1a
        * B
        """
        let result = sections(input)
        #expect(result.count == 2)
        #expect(result[0].children.count == 1) // A has A1
        #expect(result[0].children[0].children.count == 1) // A1 has A1a
        #expect(result[1].children.isEmpty) // B is flat
    }

    // MARK: - Zeroth Section

    @Test("Zeroth section — body before first heading")
    func zerothSection() {
        let input = """
        #+TITLE: My Doc
        Some preamble text.

        * First Heading
        """
        let result = sections(input)
        #expect(result.count == 2)
        #expect(result[0].heading == nil) // zeroth
        #expect(result[0].level == 0)
        #expect(!result[0].bodyBlocks.isEmpty)
        #expect(result[1].heading != nil) // first heading
    }

    @Test("Document with only body — no headings")
    func bodyOnly() {
        let input = """
        Just some paragraphs.

        And another one.
        """
        let result = sections(input)
        #expect(result.count == 1)
        #expect(result[0].heading == nil) // zeroth section
        #expect(result[0].level == 0)
    }

    @Test("Empty document")
    func emptyDocument() {
        let result = sections("")
        #expect(result.isEmpty)
    }

    // MARK: - Body Block Assignment

    @Test("Body blocks assigned to correct section")
    func bodyBlockAssignment() {
        let input = """
        * Section A
        Body for A.

        * Section B
        Body for B.

        More body for B.
        """
        let result = sections(input)
        #expect(result.count == 2)
        #expect(result[0].bodyBlocks.count == 1)  // "Body for A."
        #expect(result[1].bodyBlocks.count == 2)   // "Body for B." + "More body for B."
    }

    @Test("Section with code block in body")
    func sectionWithCodeBlock() {
        let input = """
        * Code Example

        #+begin_src python
        print("hello")
        #+end_src
        """
        let result = sections(input)
        #expect(result.count == 1)
        // Body should have the code block
        let hasCode = result[0].bodyBlocks.contains {
            if case .codeBlock = $0 { return true }; return false
        }
        #expect(hasCode)
    }

    @Test("Section with list in body")
    func sectionWithList() {
        let input = """
        * Tasks
        - Item 1
        - Item 2
        - Item 3
        """
        let result = sections(input)
        #expect(result.count == 1)
        let hasList = result[0].bodyBlocks.contains {
            if case .list = $0 { return true }; return false
        }
        #expect(hasList)
    }

    @Test("Section with drawer in body")
    func sectionWithDrawer() {
        let input = """
        * Task
        :PROPERTIES:
        :ID: abc123
        :END:
        Some body text.
        """
        let result = sections(input)
        #expect(result.count == 1)
        let hasDrawer = result[0].bodyBlocks.contains {
            if case .drawer = $0 { return true }; return false
        }
        #expect(hasDrawer)
    }

    @Test("Section with mixed body — paragraphs, lists, code, drawers")
    func mixedBody() {
        let input = """
        * Mixed
        :PROPERTIES:
        :ID: 123
        :END:
        A paragraph.

        - List item

        #+begin_src
        code
        #+end_src
        """
        let result = sections(input)
        #expect(result.count == 1)
        // Should have: drawer, paragraph, list, code block
        #expect(result[0].bodyBlocks.count == 4)
    }

    @Test("Empty section — heading only, no body or children")
    func emptySection() {
        let input = """
        * Empty Section A
        * Empty Section B
        """
        let result = sections(input)
        #expect(result.count == 2)
        #expect(result[0].bodyBlocks.isEmpty)
        #expect(result[0].children.isEmpty)
        #expect(result[1].bodyBlocks.isEmpty)
        #expect(result[1].children.isEmpty)
    }

    @Test("hasContent is false for empty section")
    func hasContentFalseForEmpty() {
        let result = sections("* Empty")
        #expect(!result[0].hasContent)
    }

    @Test("hasContent is true with body")
    func hasContentTrueWithBody() {
        let result = sections("* Title\nBody text.")
        #expect(result[0].hasContent)
    }

    @Test("hasContent is true with children only")
    func hasContentTrueWithChildren() {
        let result = sections("* Parent\n** Child")
        #expect(result[0].hasContent)
    }

    // MARK: - Fold State

    @Test("Default fold state is showAll")
    func defaultFoldState() {
        #expect(foldState("* Heading") == .showAll)
    }

    @Test("STARTUP overview sets fold state")
    func startupOverview() {
        #expect(foldState("#+STARTUP: overview\n* Heading") == .overview)
    }

    @Test("STARTUP content sets fold state")
    func startupContent() {
        #expect(foldState("#+STARTUP: content\n* Heading") == .content)
    }

    @Test("STARTUP showall sets fold state")
    func startupShowAll() {
        #expect(foldState("#+STARTUP: showall\n* Heading") == .showAll)
    }

    @Test("STARTUP nofold sets fold state")
    func startupNofold() {
        #expect(foldState("#+STARTUP: nofold\n* Heading") == .showAll)
    }

    @Test("STARTUP is case insensitive")
    func startupCaseInsensitive() {
        #expect(foldState("#+startup: overview\n* Heading") == .overview)
    }

    // MARK: - Realistic Document Structure

    @Test("Typical user-guide structure — 35 headings, 3 levels")
    func typicalUserGuide() {
        var lines: [String] = []
        lines.append("#+TITLE: User Guide")
        lines.append("#+AUTHOR: Test")
        lines.append("")
        lines.append("Introduction paragraph.")
        lines.append("")

        for i in 1...5 {
            lines.append("* Chapter \(i)")
            lines.append("Chapter \(i) intro.")
            lines.append("")
            for j in 1...3 {
                lines.append("** Section \(i).\(j)")
                lines.append("Content for section \(i).\(j).")
                lines.append("")
                for k in 1...2 {
                    lines.append("*** Subsection \(i).\(j).\(k)")
                    lines.append("Detail for \(i).\(j).\(k).")
                    lines.append("")
                }
            }
        }

        let input = lines.joined(separator: "\n")
        let result = sections(input)

        // Zeroth section + 5 chapters
        #expect(result.count == 6)
        #expect(result[0].heading == nil) // zeroth

        // Each chapter has 3 sections
        for i in 1...5 {
            let chapter = result[i]
            #expect(chapter.level == 1)
            #expect(chapter.children.count == 3)

            // Each section has 2 subsections
            for sec in chapter.children {
                #expect(sec.level == 2)
                #expect(sec.children.count == 2)
                for sub in sec.children {
                    #expect(sub.level == 3)
                    #expect(sub.children.isEmpty)
                }
            }
        }

        // Total heading count: 5 + 15 + 30 = 50
        func countHeadings(_ secs: [OrgSection]) -> Int {
            secs.reduce(0) { acc, s in
                acc + (s.heading != nil ? 1 : 0) + countHeadings(s.children)
            }
        }
        #expect(countHeadings(result) == 50)
    }

    @Test("Section tree structure is deterministic")
    func deterministicStructure() {
        let input = """
        * A
        Body A
        ** A1
        * B
        """
        let result1 = sections(input)
        let result2 = sections(input)

        // Same count and structure (UUIDs will differ but shape is identical)
        #expect(result1.count == result2.count)
        #expect(result1[0].children.count == result2[0].children.count)
        #expect(result1[0].level == result2[0].level)
        #expect(result1[0].bodyBlocks == result2[0].bodyBlocks)
    }
}

// MARK: - groupBodyBlocks Tests

@Suite("OrgGroupBodyBlocks")
struct OrgGroupBodyBlocksTests {

    let parser = OrgParser()

    /// Helper: parse input, get first heading section's pre-computed body groups.
    /// Uses the same groups that OrgSectionView renders from.
    private func bodyMarkdownStrings(_ input: String) -> [String] {
        let blocks = parser.parse(input)
        let (sections, _) = buildOrgSectionTree(blocks)
        guard let section = sections.first(where: { $0.heading != nil }) else { return [] }

        return section.precomputedBodyGroups.map { group in
            switch group {
            case .drawer: return "[DRAWER]"
            case .markdown(let md): return md
            }
        }
    }

    @Test("No body — empty groups")
    func noBody() {
        let groups = bodyMarkdownStrings("* Empty")
        #expect(groups.isEmpty)
    }

    @Test("Paragraph body — single markdown group")
    func paragraphBody() {
        let groups = bodyMarkdownStrings("* Heading\nSome text.")
        #expect(groups.count == 1)
        #expect(groups[0].contains("Some text"))
    }

    @Test("Drawer splits body into groups")
    func drawerSplitsBody() {
        let input = """
        * Heading
        Before drawer.
        :PROPERTIES:
        :ID: 123
        :END:
        After drawer.
        """
        let groups = bodyMarkdownStrings(input)
        // Should be: [markdown, DRAWER, markdown]
        #expect(groups.count == 3)
        #expect(groups[0].contains("Before drawer"))
        #expect(groups[1] == "[DRAWER]")
        #expect(groups[2].contains("After drawer"))
    }

    @Test("Drawer at start of body")
    func drawerAtStart() {
        let input = """
        * Heading
        :PROPERTIES:
        :ID: 123
        :END:
        Body text.
        """
        let groups = bodyMarkdownStrings(input)
        // Should be: [DRAWER, markdown]
        #expect(groups.count == 2)
        #expect(groups[0] == "[DRAWER]")
        #expect(groups[1].contains("Body text"))
    }

    @Test("Multiple drawers")
    func multipleDrawers() {
        let input = """
        * Heading
        :PROPERTIES:
        :ID: 123
        :END:
        Middle text.
        :LOGBOOK:
        :NOTE: something
        :END:
        End text.
        """
        let groups = bodyMarkdownStrings(input)
        // [DRAWER, markdown, DRAWER, markdown]
        #expect(groups.count == 4)
        #expect(groups[0] == "[DRAWER]")
        #expect(groups[1].contains("Middle text"))
        #expect(groups[2] == "[DRAWER]")
        #expect(groups[3].contains("End text"))
    }

    @Test("No drawers — all content in single group")
    func noDrawers() {
        let input = """
        * Heading
        Paragraph one.

        - List item

        #+begin_src
        code
        #+end_src
        """
        let groups = bodyMarkdownStrings(input)
        // All non-drawer content consolidates into one markdown group
        #expect(groups.count == 1)
        #expect(groups[0].contains("Paragraph one"))
        #expect(groups[0].contains("List item"))
    }
}
