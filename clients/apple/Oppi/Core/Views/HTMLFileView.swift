import SwiftUI
import WebKit

/// Rendered HTML with source toggle and full-screen support.
///
/// All chrome handled by ``RenderableDocumentView``.
/// Uses `PiWKWebView` for rendered content so the pi quick-action menu
/// appears on text selection (both inline and document modes).
struct HTMLFileView: View {
    let content: String
    let filePath: String?
    let presentation: FileContentPresentation

    @Environment(\.selectedTextPiActionRouter) private var piRouter
    @Environment(\.piQuickActionStore) private var piQuickActionStore

    var body: some View {
        RenderableDocumentWrapper(
            config: .html,
            content: content,
            filePath: filePath,
            presentation: presentation,
            fullScreenContent: .html(content: content, filePath: filePath),
            renderedViewFactory: { [content, filePath, piRouter, piQuickActionStore] in
                let config = WKWebViewConfiguration()
                config.websiteDataStore = .nonPersistent()
                let webView = PiWKWebView(frame: .zero, configuration: config)
                webView.isOpaque = false
                webView.backgroundColor = .clear
                webView.scrollView.backgroundColor = .clear

                // Wire pi quick actions for text selection
                let sourceContext = SelectedTextSourceContext(
                    sessionId: "",
                    surface: .fullScreenSource,
                    filePath: filePath
                )
                webView.configurePiRouter(piRouter, sourceContext: sourceContext, actionStore: piQuickActionStore)

                webView.loadHTMLString(content, baseURL: URL(string: "about:blank")?.deletingLastPathComponent())
                return webView
            }
        )
    }
}
