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
///
/// **Connection lifecycle:** The WebSocket is opened once during `prewarm` and kept alive
/// for the duration of the chat session. Individual mic taps map to `dictation_start` /
/// `dictation_stop` cycles on the same connection — no TCP or WS handshake cost per tap.
/// `invalidateCache()` closes the connection (called on credentials change or session end).
@MainActor
final class OppiDictationProvider: VoiceTranscriptionProvider {
    nonisolated let id: VoiceProviderID = .oppiServer
    nonisolated let engine: VoiceInputManager.TranscriptionEngine = .serverDictation

    /// WebSocket kept alive for the duration of the chat session.
    /// One connection per server credential set; multiple recordings per connection.
    private var sessionWS: DictationWebSocket?
    /// Per-recording message stream. Created in `prepareSession`, consumed by the session.
    private var activeRecordingMessages: AsyncThrowingStream<DictationServerMessage, Error>?
    /// Background task that sends `dictation_start` and awaits `dictation_ready`.
    /// Passed to `OppiDictationSession` so audio draining can block on readiness.
    private var activeReadinessTask: Task<DictationProviderInfo?, Error>?
    private var preparationTask: Task<Void, Never>?

    func invalidateCache() {
        activeReadinessTask?.cancel()
        activeReadinessTask = nil
        activeRecordingMessages = nil
        sessionWS?.disconnect()
        sessionWS = nil
    }

    func cancelPreparation() {
        preparationTask?.cancel()
        preparationTask = nil
        activeReadinessTask?.cancel()
        activeReadinessTask = nil
        activeRecordingMessages = nil
        // Don't disconnect sessionWS — it persists for the session lifetime
    }

    func prewarm(context: VoiceProviderContext) async throws {
        guard let credentials = context.serverCredentials else { return }
        // Connect the WS eagerly at session-open time so the first mic tap
        // pays no TCP or WS handshake cost.
        guard sessionWS == nil || sessionWS?.state == .disconnected else { return }
        let ws = DictationWebSocket()
        sessionWS = ws
        try ws.connect(credentials: credentials)
        logger.info("Dictation WS pre-connected (host=\(credentials.host, privacy: .public))")
    }

    func prepareSession(context: VoiceProviderContext) async throws -> VoiceProviderPreparation {
        guard let credentials = context.serverCredentials else {
            throw VoiceInputError.serverNotConnected
        }

        // Reuse the session WS if open; reconnect if dropped (e.g. network hiccup).
        let ws: DictationWebSocket
        if let existing = sessionWS,
           existing.state == .connected || existing.state == .connecting
        {
            // Re-arm the ready mechanism for a new recording on the existing connection.
            // Resets state to .connecting so waitForReady blocks until the server
            // responds with dictation_ready for this recording cycle.
            existing.resetForNewRecording()
            ws = existing
            logger.info("Reusing persistent dictation WS for new recording")
        } else {
            // Not connected — connect now (first tap if prewarm missed, or after network drop).
            let newWS = DictationWebSocket()
            sessionWS = newWS
            try newWS.connect(credentials: credentials)
            ws = newWS
            logger.info("Reconnecting dictation WS (host=\(credentials.host, privacy: .public))")
        }

        // Fresh per-recording message stream for this tap.
        let recordingMessages = ws.startRecordingMessages()
        self.activeRecordingMessages = recordingMessages

        // Fire readiness in the background. The session awaits this task before
        // flushing buffered audio, so the UI transitions to .recording immediately
        // while the server-side ASR setup completes (~one RTT on existing connection).
        //
        // No language hint — Qwen3-ASR handles multilingual natively.
        let readinessTask: Task<DictationProviderInfo?, Error> = Task {
            try await ws.send(.start)
            try await ws.waitForReady(timeout: .seconds(10))
            let info = ws.lastProviderInfo
            logger.info(
                "Dictation recording ready (stt=\(info?.sttProvider ?? "unknown", privacy: .public), model=\(info?.sttModel ?? "unknown", privacy: .public))"
            )
            return info
        }
        self.activeReadinessTask = readinessTask

        return VoiceProviderPreparation(
            audioFormat: nil,
            pathTag: "dictation_ws",
            setupMetricTags: Self.metricTags(host: credentials.host, serverInfo: nil)
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
        guard let ws = sessionWS else {
            throw VoiceInputError.internalError("Dictation WebSocket not connected")
        }
        guard let readinessTask = activeReadinessTask else {
            throw VoiceInputError.internalError("Dictation readiness task not prepared")
        }
        guard let recordingMessages = activeRecordingMessages else {
            throw VoiceInputError.internalError("Dictation recording messages not prepared")
        }
        // Clear per-recording state — session now owns these.
        // sessionWS is NOT cleared — it persists for the session lifetime.
        activeReadinessTask = nil
        activeRecordingMessages = nil
        return OppiDictationSession(ws: ws, readinessTask: readinessTask, messages: recordingMessages)
    }
}
