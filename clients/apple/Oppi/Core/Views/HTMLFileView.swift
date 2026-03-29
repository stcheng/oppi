import SwiftUI
import WebKit

/// Rendered HTML with source toggle and full-screen support.
///
/// All chrome handled by ``RenderableDocumentView``.
/// Uses WKWebView for rendered content (both inline and document modes).
struct HTMLFileView: View {
    let content: String
    let filePath: String?
    let presentation: FileContentPresentation

    var body: some View {
        RenderableDocumentWrapper(
            config: .html,
            content: content,
            filePath: filePath,
            presentation: presentation,
            fullScreenContent: .html(content: content, filePath: filePath),
            renderedViewFactory: { [content, filePath] in
                let config = WKWebViewConfiguration()
                config.websiteDataStore = .nonPersistent()
                let webView = WKWebView(frame: .zero, configuration: config)
                webView.isOpaque = false
                webView.backgroundColor = .clear
                webView.scrollView.backgroundColor = .clear
                let baseFileName = filePath ?? "preview.html"
                webView.loadHTMLString(content, baseURL: URL(string: "about:blank")?.deletingLastPathComponent())
                return webView
            }
        )
    }
}
