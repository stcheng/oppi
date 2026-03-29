import Testing
@testable import Oppi

@Suite("SessionGridRenderer")
struct SessionGridRendererTests {

    @Test("grid size is 8")
    func gridSize() {
        #expect(SessionGridRenderer.gridSize == 8)
    }

    @Test("generates cells for a session ID")
    func generatesCells() {
        let cells = SessionGridRenderer.generateCells(sessionId: "test-session-123")
        #expect(!cells.isEmpty)
        #expect(cells.count > 10) // pi shape + growth + scatter
        #expect(cells.count < 64) // not all cells filled
    }

    @Test("deterministic — same ID produces same cells")
    func deterministic() {
        let a = SessionGridRenderer.generateCells(sessionId: "abc")
        let b = SessionGridRenderer.generateCells(sessionId: "abc")
        #expect(a.count == b.count)
        for (ca, cb) in zip(a, b) {
            #expect(ca.row == cb.row)
            #expect(ca.col == cb.col)
            #expect(ca.role == cb.role)
            #expect(ca.opacity == cb.opacity)
        }
    }

    @Test("different IDs produce different cells")
    func differentIds() {
        let a = SessionGridRenderer.generateCells(sessionId: "session-one")
        let b = SessionGridRenderer.generateCells(sessionId: "session-two")
        // At least some cells should differ
        let aPositions = Set(a.map { "\($0.row),\($0.col)" })
        let bPositions = Set(b.map { "\($0.row),\($0.col)" })
        #expect(aPositions != bPositions)
    }

    @Test("contains spark cells")
    func hasSparks() {
        let cells = SessionGridRenderer.generateCells(sessionId: "spark-test")
        let sparks = cells.filter { $0.role == .spark }
        #expect(sparks.count >= 1)
        #expect(sparks.count <= 3)
    }

    @Test("contains almost-spark cells")
    func hasAlmostSparks() {
        let cells = SessionGridRenderer.generateCells(sessionId: "almost-test")
        let almosts = cells.filter { $0.role == .almostSpark }
        #expect(almosts.count >= 2)
    }

    @Test("interior gap between legs is never filled")
    func interiorGapProtected() {
        // Test multiple seeds to ensure the gap is always clear
        for seed in ["a", "b", "c", "d", "e", "test", "42", "session-xyz"] {
            let cells = SessionGridRenderer.generateCells(sessionId: seed)
            let positions = Set(cells.map { $0.row * 8 + $0.col })
            // Interior gap: rows 2-6, cols 3-4
            for r in 2...6 {
                for c in 3...4 {
                    #expect(!positions.contains(r * 8 + c),
                            "Interior gap cell (\(r),\(c)) should never be filled for seed '\(seed)'")
                }
            }
        }
    }

    @Test("opacity ranges are valid")
    func opacityRanges() {
        let cells = SessionGridRenderer.generateCells(sessionId: "opacity-check")
        for cell in cells {
            #expect(cell.opacity > 0)
            #expect(cell.opacity <= 1.0)
        }
    }

    @Test("all cells within grid bounds")
    func cellsInBounds() {
        let cells = SessionGridRenderer.generateCells(sessionId: "bounds-check")
        for cell in cells {
            #expect(cell.row >= 0 && cell.row < 8)
            #expect(cell.col >= 0 && cell.col < 8)
        }
    }

    @Test("density grading — core cells have higher opacity than exposed")
    func densityGrading() {
        let cells = SessionGridRenderer.generateCells(sessionId: "density-test-42")
        let exposed = cells.filter { $0.role == .piExposed }
        let edge = cells.filter { $0.role == .piEdge }
        let core = cells.filter { $0.role == .piCore }

        if let maxExposed = exposed.map(\.opacity).max(),
           let minEdge = edge.map(\.opacity).min() {
            // Exposed max should generally be less than edge min
            // (with some overlap due to randomness, so check averages)
            let avgExposed = exposed.map { Float($0.opacity) }.reduce(0, +) / max(1, Float(exposed.count))
            let avgEdge = edge.map { Float($0.opacity) }.reduce(0, +) / max(1, Float(edge.count))
            if !exposed.isEmpty && !edge.isEmpty {
                #expect(avgExposed < avgEdge, "Exposed cells should be dimmer on average than edge cells")
            }
        }

        if !edge.isEmpty, !core.isEmpty {
            let avgEdge = edge.map { Float($0.opacity) }.reduce(0, +) / Float(edge.count)
            let avgCore = core.map { Float($0.opacity) }.reduce(0, +) / Float(core.count)
            #expect(avgEdge < avgCore, "Edge cells should be dimmer on average than core cells")
        }
    }
}

@Suite("SplitMix64")
struct SplitMix64Tests {

    @Test("deterministic output")
    func deterministic() {
        var a = SplitMix64(seed: 42)
        var b = SplitMix64(seed: 42)
        for _ in 0..<100 {
            #expect(a.next() == b.next())
        }
    }

    @Test("different seeds produce different sequences")
    func differentSeeds() {
        var a = SplitMix64(seed: 1)
        var b = SplitMix64(seed: 2)
        // First values should differ
        #expect(a.next() != b.next())
    }

    @Test("nextDouble in 0..<1 range")
    func doubleRange() {
        var rng = SplitMix64(seed: 123)
        for _ in 0..<1000 {
            let d = rng.nextDouble()
            #expect(d >= 0.0)
            #expect(d < 1.0)
        }
    }
}
