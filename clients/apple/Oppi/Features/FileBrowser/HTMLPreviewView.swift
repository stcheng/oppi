import SwiftUI
import WebKit

// MARK: - HTMLContentTracker

/// Tracks whether an HTML web view needs to reload its content.
///
/// Detects two reload scenarios:
/// 1. Content changed (hash mismatch)
/// 2. WKWebView content process was terminated (blank screen recovery)
final class HTMLContentTracker {
    private var loadedContentHash: Int?
    private var processTerminated = false

    /// Returns true if the web view should reload for the given content.
    /// Call before `loadHTMLString`.
    func needsReload(for content: String) -> Bool {
        let hash = content.hashValue
        if processTerminated {
            loadedContentHash = hash
            return true
        }
        if hash != loadedContentHash {
            loadedContentHash = hash
            return true
        }
        return false
    }

    /// Call after a successful `loadHTMLString` to clear the reload flag.
    func markLoaded() {
        processTerminated = false
    }

    /// Call from `webViewWebContentProcessDidTerminate` to force
    /// the next `needsReload` to return true — even for same content.
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

    init(htmlString: String, piActionHandler: ((String, PiQuickAction) -> Void)? = nil) {
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

        load(htmlString)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    // MARK: - Content updates

    /// Load new HTML content if it differs from what's currently loaded.
    func load(_ htmlString: String) {
        if contentTracker.needsReload(for: htmlString) {
            webView.loadHTMLString(htmlString, baseURL: nil)
            contentTracker.markLoaded()
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
        // Force tracker to reload on next load() call.
        // WKWebView is blank at this point — trigger SwiftUI update cycle.
        webView.loadHTMLString("", baseURL: nil)
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
