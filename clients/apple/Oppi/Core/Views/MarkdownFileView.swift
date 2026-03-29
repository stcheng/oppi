import SwiftUI

// MARK: - MarkdownFileView

/// Rendered markdown with source toggle and full-screen reader mode.
///
/// All chrome (header, source toggle, expand, copy, context menu) is handled by
/// ``RenderableDocumentView``. This file only provides the configuration and
/// the rendered content view factory.
struct MarkdownFileView: View {
    let content: String
    let filePath: String?
    let presentation: FileContentPresentation

    var body: some View {
        RenderableDocumentWrapper(
            config: .markdown,
            content: content,
            filePath: filePath,
            presentation: presentation,
            fullScreenContent: .markdown(content: content, filePath: filePath),
            renderedViewFactory: { [content, filePath] in
                let view = AssistantMarkdownContentView()
                view.backgroundColor = .clear
                view.apply(configuration: .init(
                    content: content,
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
