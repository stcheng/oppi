import SwiftUI
import WebKit

// MARK: - HTMLContentTracker

/// Decides when a WKWebView should actually call `loadHTMLString`.
///
/// Solves two problems:
/// 1. **Deferred first load.** WKWebView silently renders blank when
///    `loadHTMLString` is called before the view has a window. Content
///    is queued until `attach()` signals the view is in a window.
/// 2. **Redundant reload suppression.** Same content is not reloaded
///    unless the web content process was terminated.
final class HTMLContentTracker {
    private var loadedContentHash: Int?
    private var processTerminated = false
    private var attached = false
    private var pendingContent: String?

    /// Request a load. Returns the HTML to load now, or nil if deferred/unchanged.
    ///
    /// Before `attach()` is called, content is queued as pending.
    /// After `attach()`, returns content only if it differs from last load
    /// or the process was terminated.
    func contentToLoad(for html: String) -> String? {
        let hash = html.hashValue

        guard attached else {
            pendingContent = html
            return nil
        }

        if processTerminated || hash != loadedContentHash {
            loadedContentHash = hash
            processTerminated = false
            pendingContent = nil
            return html
        }

        return nil
    }

    /// Called when the view enters a window. Returns pending content to load, or nil.
    func attach() -> String? {
        attached = true
        guard let content = pendingContent else { return nil }
        let hash = content.hashValue
        loadedContentHash = hash
        processTerminated = false
        pendingContent = nil
        return content
    }

    /// Called when the view leaves its window.
    func detach() {
        attached = false
    }

    /// Call from `webViewWebContentProcessDidTerminate` to force
    /// the next `contentToLoad` to return content — even for same hash.
    func markProcessTerminated() {
        processTerminated = true
    }
}

// MARK: - HTMLRenderView

/// Single canonical UIView for rendering HTML strings via WKWebView.
///
/// Used directly by UIKit callers (FullScreenCodeViewController) and wrapped
/// by ``HTMLWebView`` for SwiftUI embedding. All WKWebView configuration,
/// navigation blocking, popup blocking, and process termination recovery
/// live here — no duplication.
///
/// Security posture:
/// - Ephemeral data store (no cookies/cache persisted)
/// - No media auto-play
/// - Navigation blocked (links open in Safari)
/// - Popup windows blocked (open in Safari)
/// - Content process crash recovery (automatic reload)
/// - Inspector disabled
final class HTMLRenderView: UIView, WKNavigationDelegate {
    private let webView: PiWKWebView
    private let contentTracker = HTMLContentTracker()
    private var currentHTML: String

    init(htmlString: String, piActionHandler: ((String, PiQuickAction) -> Void)? = nil) {
        self.currentHTML = htmlString

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = .all

        let wv = PiWKWebView(frame: .zero, configuration: config)
        wv.isInspectable = false
        wv.allowsBackForwardNavigationGestures = false
        wv.scrollView.contentInsetAdjustmentBehavior = .always
        wv.isOpaque = false
        wv.backgroundColor = .clear
        wv.scrollView.backgroundColor = .clear
        wv.piActionHandler = piActionHandler
        self.webView = wv

        super.init(frame: .zero)

        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(webView)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        // Queue initial content — will load when didMoveToWindow fires
        _ = contentTracker.contentToLoad(for: htmlString)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    // MARK: - Window lifecycle

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            if let html = contentTracker.attach() {
                webView.loadHTMLString(html, baseURL: nil)
            }
        } else {
            contentTracker.detach()
        }
    }

    // MARK: - Content updates

    /// Load new HTML content. Defers until the view has a window.
    func load(_ htmlString: String) {
        currentHTML = htmlString
        if let html = contentTracker.contentToLoad(for: htmlString) {
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    /// Update the pi action handler (e.g., when SwiftUI re-renders).
    func updatePiActionHandler(_ handler: ((String, PiQuickAction) -> Void)?) {
        webView.piActionHandler = handler
    }

    // MARK: - WKNavigationDelegate

    /// Block all navigation except the initial load. External links open in Safari.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.navigationType == .other {
            decisionHandler(.allow)
            return
        }
        if let url = navigationAction.request.url,
           url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    /// Block popup windows — open in Safari instead.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url,
           url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url)
        }
        return nil
    }

    /// Recover from navigation failures.
    // swiftlint:disable:next no_force_unwrap_production
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        contentTracker.markProcessTerminated()
    }

    /// Recover from content process crashes — reload immediately.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        contentTracker.markProcessTerminated()
        // Reload with current content — the view is still in a window
        webView.loadHTMLString(currentHTML, baseURL: nil)
    }
}

// MARK: - HTMLWebView (SwiftUI wrapper)

/// SwiftUI wrapper around ``HTMLRenderView``.
///
/// Thin UIViewRepresentable — all WKWebView logic lives in HTMLRenderView.
struct HTMLWebView: UIViewRepresentable {
    let htmlString: String
    let baseFileName: String
    var piActionHandler: ((String, PiQuickAction) -> Void)?

    func makeUIView(context: Context) -> HTMLRenderView {
        HTMLRenderView(htmlString: htmlString, piActionHandler: piActionHandler)
    }

    func updateUIView(_ view: HTMLRenderView, context: Context) {
        view.updatePiActionHandler(piActionHandler)
        view.load(htmlString)
    }
}
