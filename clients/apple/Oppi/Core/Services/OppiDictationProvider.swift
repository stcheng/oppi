@preconcurrency import AVFoundation
import Foundation
import OSLog

private let logger = Logger(subsystem: AppIdentifiers.subsystem, category: "DictationProvider")

/// Voice transcription provider that streams audio to the Oppi server's `/dictation` WebSocket.
///
/// Opens a dedicated WebSocket to the connected Oppi server. The server accumulates
/// audio and retranscribes at intervals, returning full transcript replacements.
/// STT backend selection (Whisper, Qwen-ASR, etc.) is handled server-side via `SttProvider`.
///
/// Availability depends on having active `ServerCredentials` in the `VoiceProviderContext`.
/// No separate endpoint configuration needed — the server address is derived from the
/// same credentials used for the main `/stream` connection.
@MainActor
final class OppiDictationProvider: VoiceTranscriptionProvider {
    nonisolated let id: VoiceProviderID = .oppiServer
    nonisolated let engine: VoiceInputManager.TranscriptionEngine = .serverDictation

    /// Active WebSocket prepared during `prepareSession`.
    private var activeWS: DictationWebSocket?
    private var preparationTask: Task<Void, Never>?

    func invalidateCache() {
        activeWS?.disconnect()
        activeWS = nil
    }

    func cancelPreparation() {
        preparationTask?.cancel()
        preparationTask = nil
        activeWS?.disconnect()
        activeWS = nil
    }

    func prewarm(context: VoiceProviderContext) async throws {
        // Nothing to prewarm — connection is opened in prepareSession
    }

    func prepareSession(context: VoiceProviderContext) async throws -> VoiceProviderPreparation {
        guard let credentials = context.serverCredentials else {
            throw VoiceInputError.serverNotConnected
        }

        // Open WebSocket and wait for dictation_ready
        let ws = DictationWebSocket()
        self.activeWS = ws

        try ws.connect(credentials: credentials)

        // Send dictation_start — no language hint for remote ASR.
        // Qwen3-ASR handles multilingual natively; forcing a locale biases
        // against code-switching. The mic-button label stays cosmetic-only.
        try await ws.send(.start(language: nil))

        // Wait for dictation_ready (timeout handled inside)
        try await ws.waitForReady(timeout: .seconds(10))

        let serverInfo = ws.lastProviderInfo
        logger.info(
            "Dictation session prepared (stt=\(serverInfo?.sttProvider ?? "unknown", privacy: .public), model=\(serverInfo?.sttModel ?? "unknown", privacy: .public))"
        )

        return VoiceProviderPreparation(
            audioFormat: nil,
            pathTag: "dictation_ws",
            setupMetricTags: Self.metricTags(
                host: credentials.host,
                serverInfo: serverInfo
            )
        )
    }

    // MARK: - Metric Tags

    private static func metricTags(
        host: String,
        serverInfo: DictationProviderInfo?
    ) -> [String: String] {
        [
            "dictation_mode": "server",
            "host": host,
            "provider_id": "oppi_server_dictation",
            "provider_kind": "local_server",
            "stt_backend": serverInfo?.sttProvider ?? "unknown",
            "model": serverInfo?.sttModel ?? "unknown",
            "transport": "ws",
            "live_preview": "1",
            "llm_correction": serverInfo?.llmCorrectionEnabled == true ? "1" : "0",
        ]
    }

    func makeSession(
        context: VoiceProviderContext,
        preparation: VoiceProviderPreparation
    ) throws -> any VoiceTranscriptionSession {
        guard let ws = activeWS else {
            throw VoiceInputError.internalError("Dictation WebSocket not prepared")
        }
        // Transfer ownership — the session now owns the WS
        activeWS = nil
        return OppiDictationSession(ws: ws)
    }
}
