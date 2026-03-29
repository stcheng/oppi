import SwiftUI

/// Rendered Mermaid diagram with source toggle, matching `MarkdownFileView` pattern.
struct MermaidFileView: View {
    let content: String
    let filePath: String?
    let presentation: FileContentPresentation

    @Environment(\.allowsFullScreenExpansion) private var allowsFullScreenExpansion
    @Environment(\.selectedTextPiActionRouter) private var piRouter
    @State private var showRaw = false
    @State private var showFullScreen = false

    private var lineCount: Int {
        content.split(separator: "\n", omittingEmptySubsequences: false).count
    }

    var body: some View {
        Group {
            if presentation.usesInlineChrome {
                inlineBody
            } else {
                documentBody
            }
        }
        .fullScreenViewer(
            isPresented: $showFullScreen,
            content: .mermaid(content: content, filePath: filePath),
            piRouter: piRouter
        )
    }

    // MARK: - Inline Body

    private var inlineBody: some View {
        let hasFullScreenAffordance = presentation.allowsExpansionAffordance && allowsFullScreenExpansion

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "chart.dots.scatter")
                    .font(.caption)
                    .foregroundStyle(.themePurple)
                Text("Mermaid")
                    .font(.caption2.bold())
                    .foregroundStyle(.themeFgDim)
                Text("\(lineCount) lines")
                    .font(.caption2)
                    .foregroundStyle(.themeComment)

                Spacer()

                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { showRaw.toggle() }
                } label: {
                    Text(showRaw ? "Rendered" : "Source")
                        .font(.caption2)
                        .foregroundStyle(.themeBlue)
                }
                .buttonStyle(.plain)

                if hasFullScreenAffordance {
                    Button {
                        showFullScreen = true
                    } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.caption2)
                            .foregroundStyle(.themeFgDim)
                    }
                    .buttonStyle(.plain)
                }

                CopyButton(content: content)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.themeBgHighlight)

            if showRaw {
                ScrollView([.horizontal, .vertical]) {
                    Text(content)
                        .font(.appCaptionMono)
                        .foregroundStyle(.themeFg)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: presentation.viewportMaxHeight)
            } else {
                MermaidRenderedView(content: content)
                    .padding(10)
                    .frame(maxHeight: presentation.viewportMaxHeight)
            }
        }
        .codeBlockChrome()
        .contextMenu {
            if hasFullScreenAffordance {
                Button("Open Full Screen", systemImage: "arrow.up.left.and.arrow.down.right") {
                    showFullScreen = true
                }
            }
            Button("Copy", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = content
            }
        }
    }

    // MARK: - Document Body

    private var documentBody: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if showRaw {
                    NativeCodeBodyView(
                        content: content,
                        language: SyntaxLanguage.mermaid.displayName,
                        startLine: 1,
                        selectedTextSourceContext: piRouter != nil
                            ? fileContentSourceContext(filePath: filePath, language: SyntaxLanguage.mermaid.displayName)
                            : nil
                    )
                } else {
                    MermaidRenderedView(content: content)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                }
            }

            // Floating source toggle
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { showRaw.toggle() }
            } label: {
                Label(
                    showRaw ? "Rendered" : "Source",
                    systemImage: showRaw ? "chart.dots.scatter" : "curlybraces"
                )
                .font(.caption2.bold())
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.ultraThinMaterial)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .padding(.trailing, 12)
            .padding(.top, 8)
        }
    }
}

// MARK: - Rendered Content

private struct MermaidRenderedView: View {
    let content: String

    var body: some View {
        let startNs = ChatTimelinePerf.timestampNs()
        let layout = DocumentRenderPipeline.layoutGraphical(
            parser: MermaidParser(),
            renderer: MermaidFlowchartRenderer(),
            text: content,
            config: RenderConfiguration(
                fontSize: 14,
                maxWidth: 600,
                theme: ThemeRuntimeState.currentRenderTheme(),
                displayMode: .document
            )
        )
        let durationMs = ChatTimelinePerf.elapsedMs(since: startNs)
        let _ = {
            if durationMs >= 1 {
                ChatTimelinePerf.recordRenderStrategy(
                    mode: "mermaid_fullscreen",
                    durationMs: durationMs,
                    inputBytes: content.utf8.count
                )
            }
        }()
        ZoomableGraphicalSwiftUIView(size: layout.size, drawBlock: layout.draw)
            .frame(maxWidth: .infinity, minHeight: min(layout.size.height, 400), maxHeight: max(layout.size.height, 400))
    }
}
