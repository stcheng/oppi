import SwiftUI
import UIKit

// MARK: - FileSharePresenter

/// Presents `UIActivityViewController` from SwiftUI contexts.
///
/// Bridges the gap between SwiftUI views and UIKit's share sheet.
/// Finds the topmost presented view controller and presents from there.
@MainActor
enum FileSharePresenter {

    /// Share content using the smart default format (PDF for rendered types).
    static func shareDefault(_ content: FileShareService.ShareableContent) async {
        let format = FileShareService.defaultFormat(for: content)
        await share(content, format: format)
    }

    /// Share content in a specific format.
    static func share(
        _ content: FileShareService.ShareableContent,
        format: FileShareService.ExportFormat
    ) async {
        let item = await FileShareService.render(content, as: format)
        presentActivityController(item: item)
    }

    private static func presentActivityController(item: FileShareService.ShareItem) {
        guard let topVC = topViewController() else { return }

        let ac = UIActivityViewController(
            activityItems: item.activityItems,
            applicationActivities: nil
        )
        ac.completionWithItemsHandler = { _, _, _, _ in
            FileShareService.cleanupTempFiles()
        }
        if let popover = ac.popoverPresentationController {
            popover.sourceView = topVC.view
            popover.sourceRect = CGRect(
                x: topVC.view.bounds.midX,
                y: 44,
                width: 0,
                height: 0
            )
        }
        topVC.present(ac, animated: true)
    }

    private static func topViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
              let rootVC = scene.keyWindow?.rootViewController else {
            return nil
        }

        var topVC = rootVC
        while let presented = topVC.presentedViewController {
            topVC = presented
        }
        return topVC
    }
}

// MARK: - FileShareButton

/// Reusable share button for document-mode file views.
///
/// Single-format content: tap exports directly (no picker needed).
/// Multi-format content: tap opens format picker menu.
struct FileShareButton: View {
    let content: FileShareService.ShareableContent
    let style: ButtonStyle

    enum ButtonStyle {
        /// Floating capsule with material background (for overlays).
        case capsule
        /// Plain icon button (for toolbars, headers).
        case icon
    }

    @State private var isExporting = false

    init(content: FileShareService.ShareableContent, style: ButtonStyle = .capsule) {
        self.content = content
        self.style = style
    }

    var body: some View {
        let formats = FileShareService.availableFormats(for: content)

        if formats.count <= 1 {
            // Single format — tap exports directly, no picker
            Button {
                Task { await exportDefault() }
            } label: {
                shareLabel
            }
            .disabled(isExporting)
        } else {
            // Multiple formats — tap opens format picker
            Menu {
                ForEach(formats, id: \.self) { format in
                    Button {
                        Task { await export(format: format) }
                    } label: {
                        Label(formatLabel(format), systemImage: formatIcon(format))
                    }
                }
            } label: {
                shareLabel
            }
            .disabled(isExporting)
        }
    }

    @ViewBuilder
    private var shareLabel: some View {
        Group {
            switch style {
            case .capsule:
                Label("Share", systemImage: "square.and.arrow.up")
                    .font(.caption2.bold())
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.ultraThinMaterial)
                    .clipShape(Capsule())
            case .icon:
                Image(systemName: "square.and.arrow.up")
                    .font(.caption2)
            }
        }
        .opacity(isExporting ? 0.5 : 1)
    }

    private func exportDefault() async {
        guard !isExporting else { return }
        isExporting = true
        defer { isExporting = false }
        await FileSharePresenter.shareDefault(content)
    }

    private func export(format: FileShareService.ExportFormat) async {
        guard !isExporting else { return }
        isExporting = true
        defer { isExporting = false }
        await FileSharePresenter.share(content, format: format)
    }

    private func formatLabel(_ format: FileShareService.ExportFormat) -> String {
        FileShareService.formatDisplayInfo(format, for: content).label
    }

    private func formatIcon(_ format: FileShareService.ExportFormat) -> String {
        FileShareService.formatDisplayInfo(format, for: content).icon
    }
}

