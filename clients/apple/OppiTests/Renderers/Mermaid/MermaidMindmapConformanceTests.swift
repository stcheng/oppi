import Testing
@testable import Oppi

// SPEC: https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/docs/syntax/mindmap.md
//
// Tests for mindmap features not yet covered.
//
// COVERAGE (new):
// [ ] Markdown strings: "`text with **bold** and _italic_`"
// [ ] Multiline markdown strings (real newlines inside backtick-quoted labels)
// [ ] Icons: ::icon(fa fa-book) — should be parsed and stripped from label
// [ ] id prefix before shape: `idname[label text]` vs `[label text]`

@Suite("Mindmap Conformance — Missing Features")
struct MermaidMindmapConformanceTests {
    let parser = MermaidParser()

    // MARK: - Markdown strings

    /// SPEC: ## Markdown Strings
    /// Labels wrapped in "`..`" support markdown formatting and auto-wrap.
    /// We don't need to render markdown, but we must extract the label text.
    @Test func markdownStringLabel() {
        let result = parser.parse("""
        mindmap
            id1["`**Root** with a label`"]
        """)
        guard case .mindmap(let d) = result else {
            Issue.record("Expected mindmap")
            return
        }
        // The markdown delimiters should be stripped; raw markdown text preserved.
        // We don't render bold/italic, but the text content should be correct.
        #expect(d.root.label == "**Root** with a label")
        #expect(d.root.shape == .square)
    }

    /// Markdown strings with real newlines inside backtick quotes.
    @Test func markdownStringMultiline() {
        // In the Mermaid spec, real newlines inside "`...`" become line breaks.
        let result = parser.parse("mindmap\n    id1[\"`Line one\nLine two`\"]")
        guard case .mindmap(let d) = result else {
            Issue.record("Expected mindmap")
            return
        }
        #expect(d.root.label.contains("Line one"))
        #expect(d.root.label.contains("Line two"))
    }

    // MARK: - Icons

    /// SPEC: ## Icons — `::icon(fa fa-book)`
    /// Icon annotations should be parsed without corrupting the label.
    @Test func iconAnnotation() {
        let result = parser.parse("""
        mindmap
            Root
                A[Label text]
                    ::icon(fa fa-book)
        """)
        guard case .mindmap(let d) = result else {
            Issue.record("Expected mindmap")
            return
        }
        // The icon line should not become a child node or corrupt the tree.
        // "A" should still have its label and no spurious children named "::icon(...)".
        let nodeA = d.root.children.first { $0.label == "Label text" }
        #expect(nodeA != nil, "Node A should exist with correct label")
        // Icon line should not create a child.
        let hasIconChild = d.root.children.contains { $0.label.contains("::icon") }
            || d.root.children.flatMap(\.children).contains { $0.label.contains("::icon") }
        #expect(!hasIconChild, "::icon should not become a child node")
    }

    // MARK: - ID prefix

    /// Nodes with an id prefix before the shape: `idname[label]`.
    /// The id is discarded in mindmaps — only the label matters.
    @Test func idPrefixBeforeShape() {
        let result = parser.parse("""
        mindmap
            root((Central))
                branch1[Branch One]
                branch2(Branch Two)
        """)
        guard case .mindmap(let d) = result else {
            Issue.record("Expected mindmap")
            return
        }
        #expect(d.root.label == "Central")
        #expect(d.root.shape == .circle)
        #expect(d.root.children.count == 2)
        #expect(d.root.children[0].label == "Branch One")
        #expect(d.root.children[0].shape == .square)
        #expect(d.root.children[1].label == "Branch Two")
        #expect(d.root.children[1].shape == .rounded)
    }

    // MARK: - Combined example from spec

    /// Full spec example with mixed shapes and id prefixes.
    @Test func fullSpecExample() {
        let result = parser.parse("""
        mindmap
            root((mindmap))
                Origins
                    Long history
                    ::icon(fa fa-book)
                    Popularisation
                        British popular psychology author Tony Buzan
                Research
                    On effectiveness<br/>and features
                    On Automatic creation
                        Uses
                            Creative techniques
                            Strategic planning
                            Argument mapping
                Tools
                    Pen and paper
                    Mermaid
        """)
        guard case .mindmap(let d) = result else {
            Issue.record("Expected mindmap")
            return
        }
        #expect(d.root.label == "mindmap")
        #expect(d.root.shape == .circle)
        // Should have 3 top-level branches: Origins, Research, Tools.
        #expect(d.root.children.count == 3)
        // "On effectiveness<br/>and features" should have normalized <br/>.
        let research = d.root.children.first { $0.label == "Research" }
        let effectiveness = research?.children.first { $0.label.contains("effectiveness") }
        #expect(effectiveness?.label == "On effectiveness\nand features")
    }
}
