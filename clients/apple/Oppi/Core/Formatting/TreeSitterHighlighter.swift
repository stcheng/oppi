import SwiftTreeSitter
import TreeSitterBash
import TreeSitter

// MARK: - TreeSitterHighlighter

/// Syntax highlighter backed by tree-sitter grammars.
///
/// Parses source code into a full AST and maps node types to our
/// `SyntaxHighlighter.TokenKind` values. Correctly handles multi-line
/// strings, nested expansions, heredocs, and all bash quoting contexts
/// that the hand-written scanner struggles with.
///
/// Thread safety: each call creates a fresh `Parser` instance.
/// Tree-sitter parsing is fast (~0.5ms for typical bash commands)
/// so this is cheaper than synchronization overhead.
enum TreeSitterHighlighter {

    // MARK: - Language Registry

    /// Supported tree-sitter languages. Add entries as grammars are integrated.
    private enum TSLang {
        case bash

        var language: Language {
            switch self {
            case .bash:
                return Language(language: tree_sitter_bash())
            }
        }

        /// Map from SyntaxLanguage. Returns nil for unsupported languages.
        static func from(_ lang: SyntaxLanguage) -> TSLang? {
            switch lang {
            case .shell: return .bash
            // TODO: tree-sitter grammars to add (all have SPM Package.swift):
            //   .swift        → alex-pinkus/tree-sitter-swift
            //   .typescript   → tree-sitter/tree-sitter-typescript
            //   .javascript   → tree-sitter/tree-sitter-javascript
            //   .python       → tree-sitter/tree-sitter-python
            //   .go           → tree-sitter/tree-sitter-go
            //   .rust         → tree-sitter/tree-sitter-rust
            //   .ruby         → tree-sitter/tree-sitter-ruby
            //   .html         → tree-sitter/tree-sitter-html
            //   .css          → tree-sitter/tree-sitter-css
            //   .json         → tree-sitter/tree-sitter-json
            //   .c            → tree-sitter/tree-sitter-c
            //   .cpp          → tree-sitter/tree-sitter-cpp
            //   .java         → tree-sitter/tree-sitter-java
            //
            // Grammars needing SPM wrappers or non-official repos:
            //   .yaml         → tree-sitter-grammars/tree-sitter-yaml
            //   .toml         → tree-sitter-grammars/tree-sitter-toml
            //   .kotlin       → tree-sitter-grammars/tree-sitter-kotlin
            //   .xml          → tree-sitter-grammars/tree-sitter-xml
            //
            // No known tree-sitter grammar (keep hand-written scanner):
            //   .sql, .zig, .protobuf, .graphql, .diff, .latex,
            //   .orgMode, .mermaid, .dot
            default: return nil
            }
        }
    }

    // MARK: - Public API

    /// Check if a language has tree-sitter support.
    static func supports(_ language: SyntaxLanguage) -> Bool {
        TSLang.from(language) != nil
    }

    /// Scan source code using tree-sitter and return token ranges.
    ///
    /// Returns nil if the language isn't supported, signaling the caller
    /// to fall back to the hand-written scanner.
    ///
    /// Token locations are UTF-16 code unit offsets (matching NSRange).
    /// For ASCII text (99%+ of source code), these equal character offsets.
    static func scanTokenRanges(
        _ code: String,
        language: SyntaxLanguage
    ) -> [SyntaxHighlighter.TokenRange]? {
        guard let tsLang = TSLang.from(language) else {
            return nil
        }

        let parser = Parser()
        do {
            try parser.setLanguage(tsLang.language)
        } catch {
            return nil
        }

        guard let tree = parser.parse(code) else {
            return nil
        }

        guard let root = tree.rootNode else {
            return nil
        }

        var ranges: [SyntaxHighlighter.TokenRange] = []
        ranges.reserveCapacity(code.utf16.count / 6)

        collectTokens(node: root, ranges: &ranges)

        // Sort by location for consistent application order.
        // Parent tokens come after children, so more-specific tokens
        // (emitted first) get overridden by broader ones. We want the
        // opposite: apply broad tokens first, then override with specific.
        // Actually, for addAttribute on NSMutableAttributedString, last
        // write wins. So we want: broad (string) first, specific (variable)
        // second. Our walk emits children first, then parents — which means
        // parent (broad) tokens appear AFTER child (specific) tokens.
        // That's wrong for last-write-wins. Reverse so parents come first.
        //
        // But actually we handle this differently: string nodes emit for
        // their full range, and variable_name inside strings also emit.
        // Since variable_name is emitted before string (child-first walk),
        // and NSAttributedString last-write-wins, the string color would
        // override the variable. So we need children AFTER parents.
        //
        // Sort by location ascending, then by length descending (broader first).
        ranges.sort { a, b in
            if a.location != b.location {
                return a.location < b.location
            }
            return a.length > b.length
        }

        return ranges
    }

    // MARK: - Token Collection

    /// Walk the AST depth-first and emit tokens.
    ///
    /// Strategy: emit tokens for both parent and leaf nodes.
    /// Parent tokens (like `string`) cover the full range including
    /// delimiters. Child tokens (like `variable_name` inside a string)
    /// are emitted after and override in last-write-wins ordering.
    private static func collectTokens(
        node: Node,
        ranges: inout [SyntaxHighlighter.TokenRange]
    ) {
        // Emit token for this node first (parent before children)
        emitToken(for: node, ranges: &ranges)

        // Then recurse into children (which override parent tokens)
        let count = node.childCount
        for i in 0..<count {
            guard let child = node.child(at: i) else { continue }
            collectTokens(node: child, ranges: &ranges)
        }
    }

    /// Emit a token range for a node if it maps to a highlight kind.
    private static func emitToken(
        for node: Node,
        ranges: inout [SyntaxHighlighter.TokenRange]
    ) {
        guard let nodeType = node.nodeType else { return }

        let byteRange = node.byteRange
        // tree-sitter byte offsets are UTF-16LE (2 bytes per code unit)
        let location = Int(byteRange.lowerBound) / 2
        let length = Int(byteRange.upperBound - byteRange.lowerBound) / 2

        guard length > 0 else { return }

        let kind: SyntaxHighlighter.TokenKind?

        if node.isNamed {
            kind = namedNodeKind(nodeType, node: node)
        } else {
            kind = anonymousNodeKind(nodeType)
        }

        if let kind {
            ranges.append(.init(location: location, length: length, kind: kind))
        }
    }

    // MARK: - Named Node Mapping

    /// Map named AST node types to token kinds.
    ///
    /// Based on tree-sitter-bash/queries/highlights.scm with adjustments
    /// for our token kind vocabulary.
    private static func namedNodeKind(
        _ type: String,
        node: Node
    ) -> SyntaxHighlighter.TokenKind? {
        switch type {
        // Comments
        case "comment":
            return .comment

        // Strings — the whole node including delimiters
        case "string", "raw_string", "ansi_c_string", "translated_string":
            return .string

        // Heredoc
        case "heredoc_body", "heredoc_start", "heredoc_end", "heredoc_content":
            return .string

        // String content inside quotes (redundant with parent, but ensures
        // content is colored even if parent highlight is overridden)
        case "string_content":
            return .string

        // Variables
        case "variable_name", "special_variable_name":
            return .type

        // Numbers
        case "number":
            return .number

        // File descriptors (2>&1, etc.)
        case "file_descriptor":
            return .number

        // Command name — the command being executed
        case "command_name":
            return .function

        // Function definition name
        case "function_definition":
            // Only highlight the name part, not the whole definition.
            // We'll handle this via the child "word" node.
            return nil

        // Test operators: -f, -d, -z, -n, etc.
        case "test_operator":
            return .keyword

        // Regex in [[ =~ ]]
        case "regex":
            return .string

        // Variable assignment: FOO=bar
        case "variable_assignment":
            // Don't highlight the whole assignment — children handle it.
            // The variable_name child gets .type, the value stays default.
            return nil

        // Expansion nodes ($VAR, ${VAR}, $(cmd))
        case "simple_expansion", "expansion", "command_substitution",
             "process_substitution", "arithmetic_expansion":
            // Don't highlight the container — children handle variable_name,
            // command_name, etc. The $ and ${ operators are anonymous children.
            return nil

        default:
            return nil
        }
    }

    // MARK: - Anonymous Node Mapping

    /// Map anonymous (literal/keyword) node types to token kinds.
    ///
    /// Anonymous nodes include keywords (`if`, `then`), operators (`&&`, `|`),
    /// and punctuation. They appear as literal strings in the AST.
    private static func anonymousNodeKind(
        _ type: String
    ) -> SyntaxHighlighter.TokenKind? {
        switch type {
        // Shell keywords (from highlights.scm)
        case "if", "then", "else", "elif", "fi",
             "for", "in", "do", "done",
             "while", "until",
             "case", "esac",
             "function", "select",
             "export", "unset",
             "declare", "typeset", "readonly", "local":
            return .keyword

        // Operators: shell + arithmetic (consolidated to avoid duplicates)
        case "&&", "||",
             "|", "|&",
             ">", ">>", "<", "<<", "<<<", ">|", "&>", "&>>",
             "$",
             ";;", ";&", ";;&",
             "!",
             "+", "-", "*", "/", "%",
             "**", "++", "--",
             "==", "!=", "<=", ">=",
             "+=", "-=", "*=", "/=", "%=", "**=",
             "&", "^", "~",
             "&=", "^=", "|=":
            return .operator

        default:
            return nil
        }
    }
}
