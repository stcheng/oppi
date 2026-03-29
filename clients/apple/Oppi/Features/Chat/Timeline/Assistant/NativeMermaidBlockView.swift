import UIKit

/// Inline mermaid diagram renderer for the chat timeline.
///
/// Shows a rendered diagram when the code fence is closed, or falls back
/// to a syntax-highlighted code block while the fence is still open during
/// streaming. Parses and rasterizes via `DocumentRenderPipeline` +
/// `MermaidFlowchartRenderer` on a background thread, then displays the
/// resulting image on the main thread.
///
/// Tap opens a fullscreen image of the rendered diagram.
@MainActor
final class NativeMermaidBlockView: UIView {

    // MARK: - Subviews

    /// Code block shown while the fence is open (streaming) or on parse failure.
    private let codeBlockView = NativeCodeBlockView()

    /// Rendered diagram container, shown when the fence is closed and parse succeeds.
    private let diagramContainer = UIView()

    /// Rasterized diagram image view.
    private let diagramImageView: UIImageView = {
        let iv = UIImageView()
        iv.contentMode = .scaleAspectFit
        iv.clipsToBounds = true
        return iv
    }()

    /// Height constraint for the diagram container, updated after layout.
    private var diagramHeightConstraint: NSLayoutConstraint?

    /// Cap diagram height in the timeline to keep cells reasonable.
    private static let maxInlineHeight: CGFloat = 400

    // MARK: - State

    private var currentCode: String?
    private var isShowingDiagram = false
    private var renderTask: Task<Void, Never>?
    /// Cached rendered image for fullscreen tap.
    private var cachedImage: UIImage?

    // MARK: - Init

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupViews()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    private func setupViews() {
        translatesAutoresizingMaskIntoConstraints = false

        codeBlockView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(codeBlockView)

        diagramContainer.translatesAutoresizingMaskIntoConstraints = false
        diagramContainer.clipsToBounds = true
        diagramContainer.layer.cornerRadius = 8
        diagramContainer.isHidden = true
        addSubview(diagramContainer)

        diagramImageView.translatesAutoresizingMaskIntoConstraints = false
        diagramContainer.addSubview(diagramImageView)

        let heightConstraint = diagramContainer.heightAnchor.constraint(equalToConstant: 200)
        diagramHeightConstraint = heightConstraint

        let tapGesture = UITapGestureRecognizer(target: self, action: #selector(handleTap))
        diagramContainer.addGestureRecognizer(tapGesture)
        diagramContainer.isUserInteractionEnabled = true

        NSLayoutConstraint.activate([
            // Code block fills self
            codeBlockView.topAnchor.constraint(equalTo: topAnchor),
            codeBlockView.leadingAnchor.constraint(equalTo: leadingAnchor),
            codeBlockView.trailingAnchor.constraint(equalTo: trailingAnchor),
            codeBlockView.bottomAnchor.constraint(equalTo: bottomAnchor),

            // Diagram container fills self
            diagramContainer.topAnchor.constraint(equalTo: topAnchor),
            diagramContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
            diagramContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
            diagramContainer.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightConstraint,

            // Image view fills diagram container
            diagramImageView.topAnchor.constraint(equalTo: diagramContainer.topAnchor),
            diagramImageView.leadingAnchor.constraint(equalTo: diagramContainer.leadingAnchor),
            diagramImageView.trailingAnchor.constraint(equalTo: diagramContainer.trailingAnchor),
            diagramImageView.bottomAnchor.constraint(equalTo: diagramContainer.bottomAnchor),
        ])
    }

    // MARK: - Public API

    /// Show as a code block (streaming / fence still open).
    func applyAsCode(language: String?, code: String, palette: ThemePalette, isOpen: Bool) {
        renderTask?.cancel()
        renderTask = nil
        cachedImage = nil

        codeBlockView.isHidden = false
        diagramContainer.isHidden = true
        isShowingDiagram = false

        codeBlockView.apply(language: language, code: code, palette: palette, isOpen: isOpen)
        currentCode = code
    }

    /// Render as a diagram (fence closed, not streaming).
    func applyAsDiagram(code: String, palette: ThemePalette) {
        // Skip redundant renders.
        guard code != currentCode || !isShowingDiagram else { return }
        currentCode = code

        renderTask?.cancel()
        renderTask = Task { [weak self] in
            guard let self else { return }

            let theme = ThemeRuntimeState.currentRenderTheme()
            // Compute available width from current bounds, falling back to screen width.
            let availableWidth = self.bounds.width > 0
                ? self.bounds.width
                : (self.window?.windowScene?.screen.bounds.width ?? 360)

            // Run parse + layout off the main thread. The result contains a
            // non-Sendable draw closure, so we render to a UIImage on the
            // detached task and also capture size for the main-thread display.
            let result: (image: UIImage, size: CGSize)? = await Task.detached(priority: .userInitiated) {
                let layout = DocumentRenderPipeline.layoutGraphical(
                    parser: MermaidParser(),
                    renderer: MermaidFlowchartRenderer(),
                    text: code,
                    config: RenderConfiguration(
                        fontSize: 13,
                        maxWidth: availableWidth,
                        theme: theme,
                        displayMode: .inline
                    )
                )
                guard layout.size.width > 0, layout.size.height > 0 else { return nil }

                // Rasterize on this thread while we have the draw closure.
                let format = UIGraphicsImageRendererFormat()
                format.scale = 2.0 // Retina quality
                let renderer = UIGraphicsImageRenderer(size: layout.size, format: format)
                let image = renderer.image { ctx in
                    layout.draw(ctx.cgContext, .zero)
                }
                return (image: image, size: layout.size)
            }.value

            guard !Task.isCancelled else { return }

            guard let result else {
                self.showAsCodeFallback(code: code, palette: palette)
                return
            }

            self.showDiagram(image: result.image, naturalSize: result.size, palette: palette)
        }
    }

    /// Configure selected-text Pi action forwarding on the inner code block.
    func configureSelectedTextPi(
        router: SelectedTextPiActionRouter?,
        sourceContext: SelectedTextSourceContext?
    ) {
        codeBlockView.configureSelectedTextPi(router: router, sourceContext: sourceContext)
    }

    /// Apply syntax highlighting to the inner code block (when showing as code).
    func applyHighlightedCode(_ attributed: NSAttributedString) {
        codeBlockView.applyHighlightedCode(attributed)
    }

    // MARK: - Private

    private func showDiagram(image: UIImage, naturalSize: CGSize, palette: ThemePalette) {
        cachedImage = image

        // Scale to fit available width.
        let availableWidth = bounds.width > 0
            ? bounds.width
            : (window?.windowScene?.screen.bounds.width ?? 360)
        let scale = min(1.0, availableWidth / naturalSize.width)
        let displayHeight = min(naturalSize.height * scale, Self.maxInlineHeight)

        diagramContainer.backgroundColor = UIColor(palette.bgHighlight)
        diagramHeightConstraint?.constant = displayHeight

        // Use the image view approach — simpler and avoids Sendable issues.
        diagramImageView.image = image
        diagramImageView.frame = CGRect(
            x: 0, y: 0,
            width: naturalSize.width * scale,
            height: naturalSize.height * scale
        )

        codeBlockView.isHidden = true
        diagramContainer.isHidden = false
        isShowingDiagram = true

        invalidateIntrinsicContentSize()
        setNeedsLayout()
        superview?.setNeedsLayout()
    }

    private func showAsCodeFallback(code: String, palette: ThemePalette) {
        codeBlockView.isHidden = false
        diagramContainer.isHidden = true
        isShowingDiagram = false
        codeBlockView.apply(language: "mermaid", code: code, palette: palette, isOpen: false)
    }

    @objc private func handleTap() {
        guard let image = cachedImage else { return }
        FullScreenImageViewController.present(image: image)
    }
}
