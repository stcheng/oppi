import Foundation

// MARK: - Org → Markdown AST Converter

/// Converts parsed org mode blocks to the markdown AST used by the existing
/// rendering pipeline. This ensures org mode files render identically to
/// markdown: same fonts, colors, spacing, code blocks, and theme integration.
///
/// The conversion is lossy — org-specific features like TODO keywords, priority
/// cookies, and tags are folded into text. The goal is visual parity with
/// markdown, not round-trip fidelity.
enum OrgToMarkdownConverter {

    /// Convert org blocks to markdown blocks.
    static func convert(_ orgBlocks: [OrgBlock]) -> [MarkdownBlock] {
        var result: [MarkdownBlock] = []
        result.reserveCapacity(orgBlocks.count)

        for block in orgBlocks {
            switch block {
            case .heading(let level, let keyword, let priority, let title, let tags):
                var inlines = [MarkdownInline]()

                // Prefix keyword (TODO/DONE) as bold text.
                if let keyword {
                    inlines.append(.strong([.text(keyword)]))
                    inlines.append(.text(" "))
                }

                // Priority cookie.
                if let priority {
                    inlines.append(.code("[#\(priority)]"))
                    inlines.append(.text(" "))
                }

                // Title content.
                inlines.append(contentsOf: convertInlines(title))

                // Tags as dim suffix.
                if !tags.isEmpty {
                    let tagStr = "  :" + tags.joined(separator: ":") + ":"
                    inlines.append(.code(tagStr))
                }

                result.append(.heading(level: min(level, 6), inlines: inlines))

            case .paragraph(let orgInlines):
                result.append(.paragraph(convertInlines(orgInlines)))

            case .list(let kind, let items):
                switch kind {
                case .unordered:
                    // Check if any item has a checkbox → task list.
                    if items.contains(where: { $0.checkbox != nil }) {
                        let taskItems = items.map { item -> MarkdownBlock.TaskItem in
                            let checked = item.checkbox == .checked
                            let content: [MarkdownBlock] = [.paragraph(convertInlines(item.content))]
                            return MarkdownBlock.TaskItem(checked: checked, content: content)
                        }
                        result.append(.taskList(taskItems))
                    } else {
                        let mdItems = items.map { item -> [MarkdownBlock] in
                            [.paragraph(convertInlines(item.content))]
                        }
                        result.append(.unorderedList(mdItems))
                    }
                case .ordered:
                    let mdItems = items.map { item -> [MarkdownBlock] in
                        [.paragraph(convertInlines(item.content))]
                    }
                    result.append(.orderedList(start: 1, mdItems))
                }

            case .codeBlock(let language, let code):
                result.append(.codeBlock(language: language, code: code))

            case .quote(let children):
                let converted = convert(children)
                result.append(.blockQuote(converted))

            case .keyword(let key, let value):
                let upper = key.uppercased()
                if upper == "TITLE" {
                    // Render title as a level-1 heading.
                    result.append(.heading(level: 1, inlines: [.text(value)]))
                } else if upper == "STARTUP" || upper == "OPTIONS" {
                    // Skip directives that control rendering behavior.
                    break
                } else if upper == "AUTHOR" || upper == "DATE" || upper == "EMAIL" {
                    // Render metadata as dim paragraph.
                    result.append(.paragraph([.emphasis([.text("\(key): \(value)")])]))
                } else {
                    // Other keywords as inline code.
                    let text = "#+\(key): \(value)"
                    result.append(.paragraph([.code(text)]))
                }

            case .horizontalRule:
                result.append(.thematicBreak)

            case .table(let headers, let rows):
                // Convert to markdown table with MarkdownInline cells.
                let mdHeaders = headers.map { convertInlines($0) }
                let mdRows = rows.map { row in row.map { convertInlines($0) } }
                result.append(.table(headers: mdHeaders, rows: mdRows))

            case .drawer(let name, let properties):
                // Render drawers as a code block showing key-value pairs.
                if !properties.isEmpty {
                    let lines = properties.map { ":\($0.key): \($0.value)" }
                    let content = lines.joined(separator: "\n")
                    result.append(.codeBlock(language: name.lowercased(), code: content))
                }

            case .comment:
                // Skip comments in rendered output.
                break
            }
        }

        return result
    }

    // MARK: - Direct Serialization (single pass, no intermediate [MarkdownBlock])

    /// Convert org blocks directly to markdown text in a single pass.
    /// Avoids intermediate [MarkdownBlock] array allocation.
    static func serializeDirectly(_ orgBlocks: [OrgBlock]) -> String {
        var parts: [String] = []
        parts.reserveCapacity(orgBlocks.count)

        for block in orgBlocks {
            switch block {
            case .heading(let level, let keyword, let priority, let title, let tags):
                let prefix = String(repeating: "#", count: min(level, 6))
                var line = "\(prefix) "
                if let keyword {
                    line += "**\(keyword)** "
                }
                if let priority {
                    line += "`[#\(priority)]` "
                }
                line += serializeOrgInlines(title)
                if !tags.isEmpty {
                    line += "  `:" + tags.joined(separator: ":") + ":`"
                }
                parts.append(line)

            case .paragraph(let orgInlines):
                parts.append(serializeOrgInlines(orgInlines))

            case .list(let kind, let items):
                switch kind {
                case .unordered:
                    if items.contains(where: { $0.checkbox != nil }) {
                        let lines = items.map { item in
                            let check = item.checkbox == .checked ? "[x]" : "[ ]"
                            return "- \(check) \(serializeOrgInlines(item.content))"
                        }
                        parts.append(lines.joined(separator: "\n"))
                    } else {
                        let lines = items.map { "- \(serializeOrgInlines($0.content))" }
                        parts.append(lines.joined(separator: "\n"))
                    }
                case .ordered:
                    let lines = items.enumerated().map { i, item in
                        "\(i + 1). \(serializeOrgInlines(item.content))"
                    }
                    parts.append(lines.joined(separator: "\n"))
                }

            case .codeBlock(let language, let code):
                let lang = language ?? ""
                let trimmed = code.hasSuffix("\n") ? String(code.dropLast()) : code
                parts.append("```\(lang)\n\(trimmed)\n```")

            case .quote(let children):
                let inner = serializeDirectly(children)
                let quoted = inner.split(separator: "\n", omittingEmptySubsequences: false)
                    .map { "> \($0)" }
                    .joined(separator: "\n")
                parts.append(quoted)

            case .keyword(let key, let value):
                let upper = key.uppercased()
                if upper == "TITLE" {
                    parts.append("# \(value)")
                } else if upper == "STARTUP" || upper == "OPTIONS" {
                    continue
                } else if upper == "AUTHOR" || upper == "DATE" || upper == "EMAIL" {
                    parts.append("*\(key): \(value)*")
                } else {
                    parts.append("`#+\(key): \(value)`")
                }

            case .horizontalRule:
                parts.append("---")

            case .table(let headers, let rows):
                guard !headers.isEmpty else { continue }
                let headerRow = "| " + headers.map { serializeOrgInlines($0) }.joined(separator: " | ") + " |"
                let separator = "| " + headers.map { _ in "---" }.joined(separator: " | ") + " |"
                let dataRows = rows.map { row in
                    "| " + row.map { serializeOrgInlines($0) }.joined(separator: " | ") + " |"
                }
                parts.append(([headerRow, separator] + dataRows).joined(separator: "\n"))

            case .drawer:
                continue // Drawers handled separately in rendering

            case .comment:
                continue
            }
        }

        return parts.joined(separator: "\n\n")
    }

    /// Serialize org inlines directly to markdown text (no intermediate MarkdownInline).
    private static func serializeOrgInlines(_ inlines: [OrgInline]) -> String {
        inlines.map(serializeOrgInline).joined()
    }

    private static func serializeOrgInline(_ inline: OrgInline) -> String {
        switch inline {
        case .text(let s): return s
        case .bold(let c): return "**\(serializeOrgInlines(c))**"
        case .italic(let c): return "*\(serializeOrgInlines(c))*"
        case .underline(let c): return "*\(serializeOrgInlines(c))*" // md has no underline
        case .verbatim(let s): return s.contains("`") ? "`` \(s) ``" : "`\(s)`"
        case .code(let s): return s.contains("`") ? "`` \(s) ``" : "`\(s)`"
        case .strikethrough(let c): return "~~\(serializeOrgInlines(c))~~"
        case .link(let url, let desc):
            if let desc {
                return "[\(serializeOrgInlines(desc))](\(url))"
            }
            return "[\(url)](\(url))"
        }
    }

    // MARK: - Inline conversion

    /// Convert org inlines to markdown text. Public for use by heading rendering.
    static func serializeInlines(_ orgInlines: [OrgInline]) -> String {
        let mdInlines = convertInlines(orgInlines)
        return MarkdownBlockSerializer.serializeInlines(mdInlines)
    }

    private static func convertInlines(_ orgInlines: [OrgInline]) -> [MarkdownInline] {
        orgInlines.map(convertInline)
    }

    /// Convert a single org inline to a markdown inline. Public for heading rendering.
    static func convertSingleInline(_ orgInline: OrgInline) -> MarkdownInline {
        convertInline(orgInline)
    }

    private static func convertInline(_ orgInline: OrgInline) -> MarkdownInline {
        switch orgInline {
        case .text(let string):
            return .text(string)
        case .bold(let children):
            return .strong(convertInlines(children))
        case .italic(let children):
            return .emphasis(convertInlines(children))
        case .underline(let children):
            // Markdown has no underline — render as emphasis.
            return .emphasis(convertInlines(children))
        case .verbatim(let string):
            return .code(string)
        case .code(let string):
            return .code(string)
        case .strikethrough(let children):
            return .strikethrough(convertInlines(children))
        case .link(let url, let description):
            if let description {
                return .link(children: convertInlines(description), destination: url)
            } else {
                return .link(children: [.text(url)], destination: url)
            }
        }
    }
}
