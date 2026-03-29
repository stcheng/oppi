import SwiftUI

// MARK: - MarkdownFileView

/// Rendered markdown with source toggle and full-screen reader mode.
///
/// All chrome (header, source toggle, expand, copy, context menu) is handled by
/// ``RenderableDocumentView``. This file only provides the configuration and
/// the rendered content view factory.
///
/// Workspace context (`workspaceID`, `serverBaseURL`, `fetchWorkspaceFile`) is passed
/// as explicit parameters — not via `@Environment` — because environment values are
/// unreliable across `UIViewControllerRepresentable` bridges. The file browser hit
/// this exact bug: `@Environment(\.apiClient)` was nil when evaluated across the
/// SwiftUI→UIKit boundary, silently breaking image loading.
struct MarkdownFileView: View {
    let content: String
    let filePath: String?
    let presentation: FileContentPresentation
    var workspaceID: String?
    var serverBaseURL: URL?
    var fetchWorkspaceFile: ((_ workspaceID: String, _ path: String) async throws -> Data)?

    /// Workspace context for fullscreen expansion. When the user taps expand,
    /// the fullscreen viewer needs the same workspace context to render images.
    private var fullScreenWorkspaceContext: FullScreenCodeContent.WorkspaceContext? {
        guard let workspaceID, let serverBaseURL, let fetchWorkspaceFile else { return nil }
        return .init(
            workspaceID: workspaceID,
            serverBaseURL: serverBaseURL,
            fetchWorkspaceFile: fetchWorkspaceFile
        )
    }

    var body: some View {
        RenderableDocumentWrapper(
            config: .markdown,
            content: content,
            filePath: filePath,
            presentation: presentation,
            fullScreenContent: .markdown(
                content: content,
                filePath: filePath,
                workspaceContext: fullScreenWorkspaceContext
            ),
            renderedViewFactory: { [content, filePath, workspaceID, serverBaseURL, fetchWorkspaceFile] in
                let view = AssistantMarkdownContentView()
                view.backgroundColor = .clear
                view.fetchWorkspaceFile = fetchWorkspaceFile
                view.apply(configuration: .init(
                    content: content,
                    isStreaming: false,
                    themeID: ThemeRuntimeState.currentThemeID(),
                    textSelectionEnabled: true,
                    plainTextFallbackThreshold: presentation == .document ? nil : AssistantMarkdownContentView.Configuration.defaultPlainTextFallbackThreshold,
                    workspaceID: workspaceID,
                    serverBaseURL: serverBaseURL,
                    sourceFilePath: filePath
                ))
                return view
            }
        )
    }
}
