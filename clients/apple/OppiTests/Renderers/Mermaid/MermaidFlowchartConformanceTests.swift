import Testing
@testable import Oppi

// SPEC: https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/docs/syntax/flowchart.md
//
// Tests for flowchart features not yet covered by MermaidParserConformanceTests.
// Each test references the spec section it validates.
//
// COVERAGE (new):
// [ ] Parallelogram shape: [/text/]
// [ ] Parallelogram alt shape: [\text\]
// [ ] Trapezoid shape: [/text\]
// [ ] Trapezoid alt shape: [\text/]
// [ ] Double circle shape: (((text)))
// [ ] Circle edge: --o
// [ ] Cross edge: --x
// [ ] Bidirectional arrow: <-->
// [ ] Bidirectional circle: o--o
// [ ] Bidirectional cross: x--x
// [ ] Quoted node labels: A["text with (special) chars"]
// [ ] Entity codes in labels: A["A double quote:#quot;"]

@Suite("Flowchart Conformance — Missing Shapes and Edges")
struct MermaidFlowchartConformanceTests {
    let parser = MermaidParser()

    // MARK: - Missing node shapes

    /// SPEC: ### Parallelogram
    /// `id1[/This is the text in the box/]`
    @Test func parallelogramShape() {
        let result = parser.parse("""
        flowchart TD
            id1[/This is the text in the box/]
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        let node = d.nodes.first { $0.id == "id1" }
        #expect(node != nil, "Node id1 should exist")
        #expect(node?.label == "This is the text in the box")
        #expect(node?.shape == .parallelogram)
    }

    /// SPEC: ### Parallelogram alt
    /// `id1[\This is the text in the box\]`
    @Test func parallelogramAltShape() {
        let result = parser.parse("""
        flowchart TD
            id1[\\This is the text in the box\\]
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        let node = d.nodes.first { $0.id == "id1" }
        #expect(node != nil, "Node id1 should exist")
        #expect(node?.label == "This is the text in the box")
        #expect(node?.shape == .parallelogramAlt)
    }

    /// SPEC: ### Trapezoid
    /// `A[/Christmas\]`
    @Test func trapezoidShape() {
        let result = parser.parse("""
        flowchart TD
            A[/Christmas\\]
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        let node = d.nodes.first { $0.id == "A" }
        #expect(node != nil, "Node A should exist")
        #expect(node?.label == "Christmas")
        #expect(node?.shape == .trapezoid)
    }

    /// SPEC: ### Trapezoid alt
    /// `B[\Go shopping/]`
    @Test func trapezoidAltShape() {
        let result = parser.parse("""
        flowchart TD
            B[\\Go shopping/]
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        let node = d.nodes.first { $0.id == "B" }
        #expect(node != nil, "Node B should exist")
        #expect(node?.label == "Go shopping")
        #expect(node?.shape == .trapezoidAlt)
    }

    /// SPEC: ### Double circle
    /// `id1(((This is the text in the circle)))`
    @Test func doubleCircleShape() {
        let result = parser.parse("""
        flowchart TD
            id1(((This is the text in the circle)))
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        let node = d.nodes.first { $0.id == "id1" }
        #expect(node != nil, "Node id1 should exist")
        #expect(node?.label == "This is the text in the circle")
        #expect(node?.shape == .doubleCircle)
    }

    // MARK: - Missing edge types

    /// SPEC: ### Circle edge example
    /// `A --o B`
    @Test func circleEdge() {
        let result = parser.parse("""
        flowchart LR
            A --o B
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        #expect(d.edges.count == 1)
        #expect(d.edges.first?.from == "A")
        #expect(d.edges.first?.to == "B")
        #expect(d.edges.first?.style == .circle)
    }

    /// SPEC: ### Cross edge example
    /// `A --x B`
    @Test func crossEdge() {
        let result = parser.parse("""
        flowchart LR
            A --x B
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        #expect(d.edges.count == 1)
        #expect(d.edges.first?.from == "A")
        #expect(d.edges.first?.to == "B")
        #expect(d.edges.first?.style == .cross)
    }

    /// SPEC: ## Multi directional arrows — `B <--> C`
    @Test func bidirectionalArrow() {
        let result = parser.parse("""
        flowchart LR
            B <--> C
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        #expect(d.edges.count == 1)
        #expect(d.edges.first?.from == "B")
        #expect(d.edges.first?.to == "C")
        #expect(d.edges.first?.style == .biArrow)
    }

    /// SPEC: ## Multi directional arrows — `A o--o B`
    @Test func bidirectionalCircle() {
        let result = parser.parse("""
        flowchart LR
            A o--o B
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        #expect(d.edges.count == 1)
        #expect(d.edges.first?.from == "A")
        #expect(d.edges.first?.to == "B")
        #expect(d.edges.first?.style == .biCircle)
    }

    /// SPEC: ## Multi directional arrows — `C x--x D`
    @Test func bidirectionalCross() {
        let result = parser.parse("""
        flowchart LR
            C x--x D
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        #expect(d.edges.count == 1)
        #expect(d.edges.first?.from == "C")
        #expect(d.edges.first?.to == "D")
        #expect(d.edges.first?.style == .biCross)
    }

    // MARK: - Circle/cross edges with labels

    /// Circle edge with pipe label: `A --o|text| B`
    @Test func circleEdgeWithLabel() {
        let result = parser.parse("""
        flowchart LR
            A --o|label text| B
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        #expect(d.edges.first?.style == .circle)
        #expect(d.edges.first?.label == "label text")
    }

    /// Cross edge with pipe label: `A --x|text| B`
    @Test func crossEdgeWithLabel() {
        let result = parser.parse("""
        flowchart LR
            A --x|label text| B
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        #expect(d.edges.first?.style == .cross)
        #expect(d.edges.first?.label == "label text")
    }

    // MARK: - Combined spec example

    /// SPEC: Multi directional arrows example
    /// ```
    /// flowchart LR
    ///     A o--o B
    ///     B <--> C
    ///     C x--x D
    /// ```
    @Test func multiDirectionalArrowsExample() {
        let result = parser.parse("""
        flowchart LR
            A o--o B
            B <--> C
            C x--x D
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        #expect(d.edges.count == 3)
        #expect(d.edges[0].style == .biCircle)
        #expect(d.edges[1].style == .biArrow)
        #expect(d.edges[2].style == .biCross)
    }

    // MARK: - All shapes in one diagram

    /// Verify all original + new shapes parse in a single diagram.
    @Test func allShapesInOneDiagram() {
        let result = parser.parse("""
        flowchart TD
            A[rectangle]
            B(rounded)
            C([stadium])
            D{diamond}
            E{{hexagon}}
            F((circle))
            G[(cylindrical)]
            H[[subroutine]]
            I>asymmetric]
            J(((double circle)))
            K[/parallelogram/]
            L[\\parallelogram alt\\]
            M[/trapezoid\\]
            N[\\trapezoid alt/]
        """)
        guard case .flowchart(let d) = result else {
            Issue.record("Expected flowchart")
            return
        }
        #expect(d.nodes.count == 14)

        let shapes: [String: FlowNodeShape] = [
            "A": .rectangle, "B": .rounded, "C": .stadium,
            "D": .diamond, "E": .hexagon, "F": .circle,
            "G": .cylindrical, "H": .subroutine, "I": .asymmetric,
            "J": .doubleCircle, "K": .parallelogram,
            "L": .parallelogramAlt, "M": .trapezoid, "N": .trapezoidAlt,
        ]

        for (id, expectedShape) in shapes {
            let node = d.nodes.first { $0.id == id }
            #expect(node?.shape == expectedShape, "Node \(id) should be \(expectedShape), got \(String(describing: node?.shape))")
        }
    }
}
