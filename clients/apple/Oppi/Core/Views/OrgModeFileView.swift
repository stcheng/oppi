import SwiftUI

/// Rendered org mode with source toggle.
///
/// Uses the markdown rendering pipeline for visual output. Org AST is converted
/// to markdown via `OrgToMarkdownConverter`, then rendered through
/// `AssistantMarkdownContentView`. All chrome handled by ``RenderableDocumentView``.
struct OrgModeFileView: View {
    let content: String
    let filePath: String?
    let presentation: FileContentPresentation

    var body: some View {
        RenderableDocumentWrapper(
            config: .orgMode,
            content: content,
            filePath: filePath,
            presentation: presentation,
            fullScreenContent: .orgMode(content: content, filePath: filePath),
            renderedViewFactory: { [content] in
                let markdownContent = DocumentRenderPipeline.orgToMarkdown(content)
                let view = AssistantMarkdownContentView()
                view.backgroundColor = .clear
                view.apply(configuration: .make(
                    content: markdownContent,
                    isStreaming: false,
                    themeID: ThemeRuntimeState.currentThemeID(),
                    textSelectionEnabled: true,
                    plainTextFallbackThreshold: presentation == .document ? nil : AssistantMarkdownContentView.Configuration.defaultPlainTextFallbackThreshold
                ))
                return view
            }
        )
    }
}
