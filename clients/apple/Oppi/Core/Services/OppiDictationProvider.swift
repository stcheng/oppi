@preconcurrency import AVFoundation
import Foundation
import OSLog

private let logger = Logger(subsystem: AppIdentifiers.subsystem, category: "DictationProvider")

/// Voice transcription provider that streams audio to the Oppi server's `/dictation` endpoint.
///
/// Replaces `RemoteASRVoiceProvider` — instead of chunked HTTP requests to a separate STT server,
/// this opens a dedicated WebSocket to the already-connected Oppi server. The server accumulates
/// audio and retranscribes at intervals, returning full transcript replacements.
///
/// Availability depends on having active `ServerCredentials` in the `VoiceProviderContext`.
/// No separate endpoint configuration needed — the server address is derived from the
/// same credentials used for the main `/stream` connection.
@MainActor
final class OppiDictationProvider: VoiceTranscriptionProvider {
    nonisolated let id: VoiceProviderID = .remoteASR
    nonisolated let engine: VoiceInputManager.TranscriptionEngine = .remoteASR

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
            throw VoiceInputError.remoteEndpointNotConfigured
        }

        // Open WebSocket and wait for dictation_ready
        let ws = DictationWebSocket()
        self.activeWS = ws

        try ws.connect(credentials: credentials)

        // Send dictation_start
        let languageHint = context.locale.language.languageCode?.identifier
        try await ws.send(.start(language: languageHint))

        // Wait for dictation_ready (timeout handled inside)
        try await ws.waitForReady(timeout: .seconds(10))

        logger.info("Dictation session prepared (server ready)")

        return VoiceProviderPreparation(
            audioFormat: nil,
            pathTag: "dictation_ws",
            setupMetricTags: [
                "dictation_mode": "server",
                "host": credentials.host,
            ]
        )
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
