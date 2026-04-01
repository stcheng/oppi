import Testing
@testable import Oppi

// SPEC: https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/docs/syntax/sequenceDiagram.md
//
// Tests for sequence diagram features not yet covered.
// Each test references the spec section it validates.
//
// COVERAGE (new):
// [ ] Notes: right of, left of, over single, over two actors
// [ ] Loops: loop...end
// [ ] Alt/else/opt: alt...else...end, opt...end
// [ ] Parallel: par...and...end
// [ ] Critical: critical...option...end
// [ ] Break: break...end
// [ ] Activations: activate/deactivate keywords
// [ ] Activation shorthand: ->>+ and -->>-
// [ ] Async arrows: -) and --)
// [ ] Autonumber directive
// [ ] Boxes/grouping: box...end
// [ ] Rect background highlighting: rect...end
// [ ] Comments in sequence diagrams

@Suite("Sequence Diagram Conformance — Missing Features")
struct MermaidSequenceConformanceTests {
    let parser = MermaidParser()

    // MARK: - Notes

    /// SPEC: ## Notes — `Note right of John: Text in note`
    @Test func noteRightOf() {
        let result = parser.parse("""
        sequenceDiagram
            participant John
            Note right of John: Text in note
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.participants.count == 1)
        // The note should be in the diagram's elements.
        // Notes are not messages — they should be a separate AST node.
        #expect(!d.notes.isEmpty, "Should have parsed the note")
        let note = d.notes.first
        #expect(note?.text == "Text in note")
        #expect(note?.position == .rightOf)
        #expect(note?.actors == ["John"])
    }

    /// SPEC: ## Notes — `Note left of Alice: text`
    @Test func noteLeftOf() {
        let result = parser.parse("""
        sequenceDiagram
            participant Alice
            Note left of Alice: This is a left note
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        let note = d.notes.first
        #expect(note?.text == "This is a left note")
        #expect(note?.position == .leftOf)
        #expect(note?.actors == ["Alice"])
    }

    /// SPEC: ## Notes — `Note over Alice,John: A typical interaction`
    @Test func noteOverTwoActors() {
        let result = parser.parse("""
        sequenceDiagram
            Alice->John: Hello John, how are you?
            Note over Alice,John: A typical interaction
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        let note = d.notes.first
        #expect(note?.text == "A typical interaction")
        #expect(note?.position == .over)
        #expect(note?.actors == ["Alice", "John"])
    }

    /// SPEC: ## Notes — Note over single actor
    @Test func noteOverSingleActor() {
        let result = parser.parse("""
        sequenceDiagram
            participant Alice
            Note over Alice: Self note
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        let note = d.notes.first
        #expect(note?.position == .over)
        #expect(note?.actors == ["Alice"])
    }

    // MARK: - Loops

    /// SPEC: ## Loops
    /// ```
    /// loop Loop text
    ///     ...statements...
    /// end
    /// ```
    @Test func loopBlock() {
        let result = parser.parse("""
        sequenceDiagram
            Alice->John: Hello John, how are you?
            loop Every minute
                John-->Alice: Great!
            end
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        // Should have 2 messages: the greeting + the loop body message.
        #expect(d.messages.count == 2)
        #expect(d.messages[1].text == "Great!")
        // Should have a loop block in the AST.
        #expect(!d.blocks.isEmpty, "Should have parsed the loop block")
        let block = d.blocks.first
        #expect(block?.kind == .loop)
        #expect(block?.label == "Every minute")
    }

    // MARK: - Alt / Else / Opt

    /// SPEC: ## Alt — alt...else...end
    @Test func altElseBlock() {
        let result = parser.parse("""
        sequenceDiagram
            Alice->>Bob: Hello Bob, how are you?
            alt is sick
                Bob->>Alice: Not so good :(
            else is well
                Bob->>Alice: Feeling fresh like a daisy
            end
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.messages.count == 3)
        let block = d.blocks.first { $0.kind == .alt }
        #expect(block != nil, "Should have an alt block")
        #expect(block?.label == "is sick")
        #expect(block?.elseBlocks?.first?.label == "is well")
    }

    /// SPEC: ## Alt — opt...end (optional block)
    @Test func optBlock() {
        let result = parser.parse("""
        sequenceDiagram
            Alice->>Bob: Hello
            opt Extra response
                Bob->>Alice: Thanks for asking
            end
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        let block = d.blocks.first { $0.kind == .opt }
        #expect(block != nil, "Should have an opt block")
        #expect(block?.label == "Extra response")
    }

    // MARK: - Parallel

    /// SPEC: ## Parallel — par...and...end
    @Test func parallelBlock() {
        let result = parser.parse("""
        sequenceDiagram
            par Alice to Bob
                Alice->>Bob: Hello guys!
            and Alice to John
                Alice->>John: Hello guys!
            end
            Bob-->>Alice: Hi Alice!
            John-->>Alice: Hi Alice!
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.messages.count == 4)
        let block = d.blocks.first { $0.kind == .par }
        #expect(block != nil, "Should have a par block")
        #expect(block?.label == "Alice to Bob")
    }

    // MARK: - Critical

    /// SPEC: ## Critical Region — critical...option...end
    @Test func criticalBlock() {
        let result = parser.parse("""
        sequenceDiagram
            critical Establish a connection to the DB
                Service-->DB: connect
            option Network timeout
                Service-->Service: Log error
            option Credentials rejected
                Service-->Service: Log different error
            end
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        let block = d.blocks.first { $0.kind == .critical }
        #expect(block != nil, "Should have a critical block")
        #expect(block?.label == "Establish a connection to the DB")
    }

    // MARK: - Break

    /// SPEC: ## Break — break...end
    @Test func breakBlock() {
        let result = parser.parse("""
        sequenceDiagram
            Consumer-->API: Book something
            API-->BookingService: Start booking process
            break when the booking process fails
                API-->Consumer: show failure
            end
            API-->BillingService: Start billing process
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        let block = d.blocks.first { $0.kind == .break }
        #expect(block != nil, "Should have a break block")
        #expect(block?.label == "when the booking process fails")
        // Messages inside and outside the break should all be parsed.
        #expect(d.messages.count == 4)
    }

    // MARK: - Activations

    /// SPEC: ## Activations — activate/deactivate keywords
    @Test func activationKeywords() {
        let result = parser.parse("""
        sequenceDiagram
            Alice->>John: Hello John, how are you?
            activate John
            John-->>Alice: Great!
            deactivate John
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.messages.count == 2)
        // Activations should be tracked — at minimum not cause parse errors.
        // The activation state is rendering metadata, but the keywords
        // must not be misinterpreted as participant names or messages.
        #expect(d.participants.count == 2)
        #expect(!d.participants.contains { $0.id == "activate" })
        #expect(!d.participants.contains { $0.id == "deactivate" })
    }

    /// SPEC: ## Activations — shorthand +/- suffix on arrows
    /// `Alice->>+John: Hello` / `John-->>-Alice: Great!`
    @Test func activationShorthand() {
        let result = parser.parse("""
        sequenceDiagram
            Alice->>+John: Hello John, how are you?
            John-->>-Alice: Great!
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.messages.count == 2)
        #expect(d.messages[0].from == "Alice")
        #expect(d.messages[0].to == "John")
        #expect(d.messages[0].activationModifier == .activate)
        #expect(d.messages[1].activationModifier == .deactivate)
    }

    // MARK: - Async arrows

    /// SPEC: Supported Arrow Types — `-)` solid line with open arrow (async)
    @Test func asyncSolidArrow() {
        let result = parser.parse("""
        sequenceDiagram
            Alice-)John: Hello
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.messages.first?.arrowStyle == .solidAsync)
    }

    /// SPEC: Supported Arrow Types — `--)` dotted line with open arrow (async)
    @Test func asyncDashedArrow() {
        let result = parser.parse("""
        sequenceDiagram
            Alice--)John: Hello
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.messages.first?.arrowStyle == .dashedAsync)
    }

    // MARK: - Autonumber

    /// SPEC: ## sequenceNumbers — `autonumber` directive
    @Test func autonumberDirective() {
        let result = parser.parse("""
        sequenceDiagram
            autonumber
            Alice->>John: Hello John, how are you?
            John-->>Alice: Great!
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.autonumber == true)
        // Messages should still parse normally.
        #expect(d.messages.count == 2)
        // "autonumber" should not be treated as a participant.
        #expect(!d.participants.contains { $0.id == "autonumber" })
    }

    // MARK: - Boxes / Grouping

    /// SPEC: ### Grouping / Box — `box...end`
    @Test func boxGrouping() {
        let result = parser.parse("""
        sequenceDiagram
            box Purple Group Description
                participant Alice
                participant John
            end
            Alice->>John: Hello
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.participants.count == 2)
        #expect(d.messages.count == 1)
        // Box should not confuse participant parsing.
        #expect(!d.participants.contains { $0.id == "box" })
        #expect(!d.participants.contains { $0.id == "end" })
    }

    // MARK: - Rect (background highlighting)

    /// SPEC: ## Background Highlighting — `rect rgb(...)...end`
    @Test func rectBackgroundHighlighting() {
        let result = parser.parse("""
        sequenceDiagram
            participant Alice
            participant John
            rect rgb(191, 223, 255)
                Alice->>+John: Hello John
                John-->>-Alice: Great!
            end
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        // rect/end should not break message parsing.
        #expect(d.messages.count == 2)
        #expect(d.participants.count == 2)
        // "rect" should not be misinterpreted as a participant.
        #expect(!d.participants.contains { $0.id == "rect" })
    }

    // MARK: - Comments

    /// SPEC: ## Comments — `%% comment text`
    @Test func commentsInSequenceDiagram() {
        let result = parser.parse("""
        sequenceDiagram
            %% This is a comment
            Alice->>John: Hello
            %% Another comment
            John-->>Alice: Hi
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.messages.count == 2)
        // Comments should be stripped, not treated as messages or participants.
        #expect(!d.participants.contains { $0.id.contains("%%") })
    }

    // MARK: - Combined spec example

    /// Larger diagram from the autonumber spec example.
    @Test func fullSpecExample() {
        let result = parser.parse("""
        sequenceDiagram
            autonumber
            Alice->>John: Hello John, how are you?
            loop HealthCheck
                John->>John: Fight against hypochondria
            end
            Note right of John: Rational thoughts!
            John-->>Alice: Great!
            John->>Bob: How about you?
            Bob-->>John: Jolly good!
        """)
        guard case .sequence(let d) = result else {
            Issue.record("Expected sequence")
            return
        }
        #expect(d.autonumber == true)
        #expect(d.participants.count == 3)
        #expect(d.messages.count == 5)
        #expect(!d.notes.isEmpty)
        #expect(!d.blocks.isEmpty)
    }
}
