import Testing
@testable import Oppi

// MARK: - Test Helpers

/// Extract tokens of a specific kind from Swift scan results.
private func tokens(
    _ kind: SyntaxHighlighter.TokenKind,
    in code: String
) -> [(text: String, kind: SyntaxHighlighter.TokenKind)] {
    let ranges = TreeSitterHighlighter.scanTokenRanges(code, language: .swift) ?? []
    let utf16 = Array(code.utf16)
    return ranges.compactMap { range in
        let start = range.location
        let end = start + range.length
        guard start >= 0, end <= utf16.count else { return nil }
        guard range.kind == kind else { return nil }
        let slice = Array(utf16[start..<end])
        return (String(utf16CodeUnits: slice, count: slice.count), range.kind)
    }
}

/// Check that a substring is highlighted as expected kind (last-write-wins).
private func expectToken(
    _ substring: String,
    is expectedKind: SyntaxHighlighter.TokenKind,
    in code: String,
    sourceLocation: SourceLocation = #_sourceLocation
) {
    let ranges = TreeSitterHighlighter.scanTokenRanges(code, language: .swift) ?? []
    let utf16 = Array(code.utf16)
    let targetUTF16 = Array(substring.utf16)

    guard let substringRange = findUTF16Range(targetUTF16, in: utf16) else {
        Issue.record("Substring '\(substring)' not found in code", sourceLocation: sourceLocation)
        return
    }

    let covering = ranges.filter { range in
        let tokenStart = range.location
        let tokenEnd = tokenStart + range.length
        return tokenStart <= substringRange.lowerBound && tokenEnd >= substringRange.upperBound
    }

    guard let winner = covering.last else {
        Issue.record("No token covers '\(substring)' — expected \(expectedKind)", sourceLocation: sourceLocation)
        return
    }

    #expect(winner.kind == expectedKind,
            "Expected '\(substring)' to be \(expectedKind), got \(winner.kind)",
            sourceLocation: sourceLocation)
}

private func findUTF16Range(_ needle: [UInt16], in haystack: [UInt16]) -> Range<Int>? {
    guard !needle.isEmpty, needle.count <= haystack.count else { return nil }
    outer: for i in 0...(haystack.count - needle.count) {
        for j in 0..<needle.count {
            if haystack[i + j] != needle[j] { continue outer }
        }
        return i..<(i + needle.count)
    }
    return nil
}

// MARK: - Keywords

@Suite("TreeSitter Swift — Keywords")
struct TreeSitterSwiftKeywordTests {

    @Test func basicKeywords() {
        let code = "let x = 42"
        expectToken("let", is: .keyword, in: code)
    }

    @Test func varKeyword() {
        let code = "var name = \"hello\""
        expectToken("var", is: .keyword, in: code)
    }

    @Test func funcKeyword() {
        let code = "func greet() { }"
        expectToken("func", is: .keyword, in: code)
    }

    @Test func controlFlow() {
        let code = """
        if condition {
            return true
        } else {
            return false
        }
        """
        expectToken("if", is: .keyword, in: code)
        expectToken("return", is: .keyword, in: code)
        expectToken("else", is: .keyword, in: code)
    }

    @Test func structClassEnum() {
        let code = "struct Foo { }\nclass Bar { }\nenum Baz { }"
        expectToken("struct", is: .keyword, in: code)
        expectToken("class", is: .keyword, in: code)
        expectToken("enum", is: .keyword, in: code)
    }

    @Test func guardStatement() {
        let code = "guard let x = optional else { return }"
        expectToken("guard", is: .keyword, in: code)
    }

    @Test func forLoop() {
        let code = "for item in items { }"
        expectToken("for", is: .keyword, in: code)
    }

    @Test func asyncAwait() {
        let code = "func run() async throws { }"
        expectToken("async", is: .keyword, in: code)
    }

    @Test func importKeyword() {
        let code = "import Foundation"
        expectToken("import", is: .keyword, in: code)
    }

    @Test func tryCatchThrow() {
        let code = """
        do {
            try riskyCall()
        } catch {
            throw error
        }
        """
        expectToken("do", is: .keyword, in: code)
        expectToken("catch", is: .keyword, in: code)
    }
}

// MARK: - Types

@Suite("TreeSitter Swift — Types")
struct TreeSitterSwiftTypeTests {

    @Test func typeIdentifier() {
        let code = "let x: String = \"\""
        expectToken("String", is: .type, in: code)
    }

    @Test func genericType() {
        let code = "let items: Array<Int> = []"
        expectToken("Array", is: .type, in: code)
        expectToken("Int", is: .type, in: code)
    }

    @Test func protocolConformance() {
        let code = "struct Foo: Codable { }"
        expectToken("Codable", is: .type, in: code)
    }
}

// MARK: - Strings

@Suite("TreeSitter Swift — Strings")
struct TreeSitterSwiftStringTests {

    @Test func stringLiteral() {
        let code = #"let s = "hello world""#
        expectToken("hello world", is: .string, in: code)
    }

    @Test func multiLineString() {
        let code = """
        let s = \"\"\"
        first line
        second line
        \"\"\"
        """
        let strings = tokens(.string, in: code)
        let multiLine = strings.first { $0.text.contains("first line") }
        #expect(multiLine != nil, "Multi-line string content should be .string")
    }

    @Test func stringInterpolationDelimiters() {
        // The \( and ) delimiters are @punctuation.special
        let code = #"let s = "hello \(name)""#
        // The string content should still be .string
        expectToken("hello ", is: .string, in: code)
    }
}

// MARK: - Functions

@Suite("TreeSitter Swift — Functions")
struct TreeSitterSwiftFunctionTests {

    @Test func functionDeclaration() {
        let code = "func greet(name: String) -> String { }"
        expectToken("greet", is: .function, in: code)
    }

    @Test func functionCall() {
        let code = "print(\"hello\")"
        expectToken("print", is: .function, in: code)
    }

    @Test func methodCall() {
        let code = "array.append(item)"
        expectToken("append", is: .function, in: code)
    }
}

// MARK: - Comments

@Suite("TreeSitter Swift — Comments")
struct TreeSitterSwiftCommentTests {

    @Test func lineComment() {
        let code = "let x = 1 // comment"
        expectToken("// comment", is: .comment, in: code)
    }

    @Test func blockComment() {
        let code = "let x = /* inline */ 1"
        expectToken("/* inline */", is: .comment, in: code)
    }

    @Test func docComment() {
        let code = "/// Documentation\nfunc foo() { }"
        expectToken("/// Documentation", is: .comment, in: code)
    }
}

// MARK: - Numbers

@Suite("TreeSitter Swift — Numbers")
struct TreeSitterSwiftNumberTests {

    @Test func integerLiteral() {
        let code = "let x = 42"
        expectToken("42", is: .number, in: code)
    }

    @Test func floatLiteral() {
        let code = "let pi = 3.14"
        expectToken("3.14", is: .number, in: code)
    }

    @Test func hexLiteral() {
        let code = "let mask = 0xFF"
        expectToken("0xFF", is: .number, in: code)
    }

    @Test func booleanLiteral() {
        let code = "let flag = true"
        expectToken("true", is: .keyword, in: code)
    }

    @Test func nilLiteral() {
        let code = "let x: Int? = nil"
        expectToken("nil", is: .number, in: code)
    }
}

// MARK: - Operators

@Suite("TreeSitter Swift — Operators")
struct TreeSitterSwiftOperatorTests {

    @Test func arithmeticOperators() {
        let code = "let sum = a + b"
        expectToken("+", is: .operator, in: code)
    }

    @Test func comparisonOperators() {
        let code = "if a == b { }"
        expectToken("==", is: .operator, in: code)
    }

    @Test func rangeOperator() {
        let code = "for i in 0..<10 { }"
        expectToken("..<", is: .operator, in: code)
    }
}

// MARK: - Attributes

@Suite("TreeSitter Swift — Attributes")
struct TreeSitterSwiftAttributeTests {

    @Test func attribute() {
        let code = "@Observable class Store { }"
        expectToken("Observable", is: .type, in: code)
    }

    @Test func mainActorAttribute() {
        let code = "@MainActor func update() { }"
        expectToken("MainActor", is: .type, in: code)
    }
}

// MARK: - Real-World Patterns

@Suite("TreeSitter Swift — Real World")
struct TreeSitterSwiftRealWorldTests {

    @Test func observableClass() {
        let code = """
        @Observable
        final class SessionStore {
            var sessions: [Session] = []
            
            func load() async throws {
                sessions = try await api.fetchSessions()
            }
        }
        """
        expectToken("Observable", is: .type, in: code)
        expectToken("class", is: .keyword, in: code)
        expectToken("SessionStore", is: .type, in: code)
        expectToken("var", is: .keyword, in: code)
        expectToken("func", is: .keyword, in: code)
        expectToken("load", is: .function, in: code)
        expectToken("async", is: .keyword, in: code)
    }

    @Test func guardLetPattern() {
        let code = """
        guard let url = URL(string: urlString) else {
            return nil
        }
        """
        expectToken("guard", is: .keyword, in: code)
        expectToken("let", is: .keyword, in: code)
        // tree-sitter: URL(string:) is a call expression, so URL is @function.call
        expectToken("URL", is: .function, in: code)
        expectToken("return", is: .keyword, in: code)
        expectToken("nil", is: .number, in: code)
    }

    @Test func closureWithCapture() {
        let code = """
        Task { [weak self] in
            guard let self else { return }
            self.refresh()
        }
        """
        // tree-sitter: Task { } is a call expression, so Task is @function.call
        expectToken("Task", is: .function, in: code)
        expectToken("weak", is: .keyword, in: code)
        expectToken("guard", is: .keyword, in: code)
        expectToken("return", is: .keyword, in: code)
    }

    @Test func switchStatement() {
        let code = """
        switch value {
        case .success(let data):
            process(data)
        case .failure(let error):
            log(error)
        }
        """
        expectToken("switch", is: .keyword, in: code)
        expectToken("case", is: .keyword, in: code)
        expectToken("process", is: .function, in: code)
    }

    @Test func protocolWithAssociatedType() {
        let code = """
        protocol Renderer {
            associatedtype Content
            func render(_ content: Content) -> NSAttributedString
        }
        """
        expectToken("protocol", is: .keyword, in: code)
        expectToken("Renderer", is: .type, in: code)
        expectToken("func", is: .keyword, in: code)
        expectToken("render", is: .function, in: code)
        expectToken("NSAttributedString", is: .type, in: code)
    }
}

// MARK: - Integration

@Suite("TreeSitter Swift — Integration")
struct TreeSitterSwiftIntegrationTests {

    @Test func treeSitterSupportsSwift() {
        #expect(TreeSitterHighlighter.supports(.swift))
    }

    @Test func highlightPreservesText() {
        let code = "let x: Int = 42"
        let result = SyntaxHighlighter.highlight(code, language: .swift)
        #expect(result.string == code)
    }

    @Test func scanTokenRangesProducesResults() {
        let code = "func hello() -> String { return \"world\" }"
        let ranges = SyntaxHighlighter.scanTokenRanges(code, language: .swift)
        #expect(!ranges.isEmpty)
        let functions = ranges.filter { $0.kind == .function }
        #expect(!functions.isEmpty, "Should detect function name")
    }
}
