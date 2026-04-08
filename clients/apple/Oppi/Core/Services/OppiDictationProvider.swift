@preconcurrency import AVFoundation
import Foundation
import OSLog

private let logger = Logger(subsystem: AppIdentifiers.subsystem, category: "DictationProvider")

/// Voice transcription provider that streams audio to the Oppi server via the main `/stream` WebSocket.
///
/// Audio travels as binary WebSocket frames on the same `/stream` connection used for
/// session events. Dictation control messages (`dictation_start/stop/cancel`) and results
/// (`dictation_ready/result/final/error`) are regular `ServerMessage`/`ClientMessage` text frames.
///
/// Availability depends on having active `ServerCredentials` in the `VoiceProviderContext`.
/// No separate connection needed — everything multiplexes over the existing `/stream` WS.
@MainActor
final class OppiDictationProvider: VoiceTranscriptionProvider {
    nonisolated let id: VoiceProviderID = .oppiServer
    nonisolated let engine: VoiceInputManager.TranscriptionEngine = .serverDictation

    /// Per-recording message stream. Created in `prepareSession`, consumed by the session.
    private var activeRecordingMessages: AsyncStream<ServerMessage>?
    /// Continuation for feeding dictation messages from the /stream WS into the recording stream.
    private var activeRecordingContinuation: AsyncStream<ServerMessage>.Continuation?
    /// Background task that sends `dictation_start` and awaits `dictation_ready`.
    private var activeReadinessTask: Task<DictationProviderInfo?, Error>?
    private var preparationTask: Task<Void, Never>?
    /// Task consuming the dictation subscription from ServerConnection.
    private var dictationRouteTask: Task<Void, Never>?

    func invalidateCache() {
        activeReadinessTask?.cancel()
        activeReadinessTask = nil
        stopDictationRouting()
    }

    func cancelPreparation() {
        preparationTask?.cancel()
        preparationTask = nil
        activeReadinessTask?.cancel()
        activeReadinessTask = nil
        stopDictationRouting()
    }

    func prewarm(context: VoiceProviderContext) async throws {
        // No separate connection to pre-warm — the /stream WS is already open.
        // This is a no-op for the server dictation provider.
    }

    func prepareSession(context: VoiceProviderContext) async throws -> VoiceProviderPreparation {
        guard let credentials = context.serverCredentials else {
            throw VoiceInputError.serverNotConnected
        }
        guard let connection = context.serverConnection else {
            throw VoiceInputError.serverNotConnected
        }

        // Subscribe to dictation messages from the /stream WS.
        // Must happen BEFORE creating the recording stream, because
        // startDictationRouting calls stopDictationRouting which clears
        // any existing recording stream.
        startDictationRouting(connection: connection)

        // Create a fresh per-recording message stream.
        let (recordingStream, recordingContinuation) = AsyncStream.makeStream(of: ServerMessage.self)
        self.activeRecordingMessages = recordingStream
        self.activeRecordingContinuation = recordingContinuation

        // Fire readiness in the background. The session awaits this task before
        // flushing buffered audio, so the UI transitions to .recording immediately
        // while the server-side ASR setup completes (~one RTT).
        let readinessTask: Task<DictationProviderInfo?, Error> = Task {
            try await connection.sendDictation(.dictationStart)

            // Wait for dictation_ready to arrive in the recording stream.
            // The message routing task yields it; we consume a copy here.
            let info = try await waitForReady(in: connection, timeout: .seconds(10))
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

    /// Wait for `dictation_ready` from the server by monitoring the dictation subscription.
    /// Uses a continuation that the routing task resolves when it sees `.dictationReady`.
    private var readyContinuation: CheckedContinuation<DictationProviderInfo?, Error>?
    private var readyTimeoutTask: Task<Void, Never>?

    private func waitForReady(
        in connection: ServerConnection,
        timeout: Duration
    ) async throws -> DictationProviderInfo? {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<DictationProviderInfo?, Error>) in
            readyContinuation = continuation

            readyTimeoutTask = Task { [weak self] in
                try? await Task.sleep(for: timeout)
                guard let self, let cont = self.readyContinuation else { return }
                self.readyContinuation = nil
                cont.resume(throwing: VoiceInputError.remoteRequestTimedOut)
            }
        }
    }

    /// Start a task that consumes dictation messages from the /stream WS
    /// and forwards them to the per-recording stream + resolves readiness.
    private func startDictationRouting(connection: ServerConnection) {
        stopDictationRouting()

        let dictationStream = connection.subscribeDictation()
        dictationRouteTask = Task { [weak self] in
            for await message in dictationStream {
                guard let self else { break }

                // Resolve readiness if waiting
                if case .dictationReady(let provider) = message {
                    readyTimeoutTask?.cancel()
                    readyTimeoutTask = nil
                    if let cont = readyContinuation {
                        readyContinuation = nil
                        cont.resume(returning: provider)
                    }
                }

                // Resolve readiness on fatal error too
                if case .dictationError(_, let fatal) = message, fatal {
                    readyTimeoutTask?.cancel()
                    readyTimeoutTask = nil
                    if let cont = readyContinuation {
                        readyContinuation = nil
                        let errorMsg: String
                        if case .dictationError(let e, _) = message { errorMsg = e } else { errorMsg = "Unknown" }
                        cont.resume(throwing: VoiceInputError.internalError("Server: \(errorMsg)"))
                    }
                }

                // Forward to recording stream
                activeRecordingContinuation?.yield(message)

                // dictation_final ends this recording's stream
                if case .dictationFinal = message {
                    activeRecordingContinuation?.finish()
                    activeRecordingContinuation = nil
                    activeRecordingMessages = nil
                }
            }
        }
    }

    private func stopDictationRouting() {
        dictationRouteTask?.cancel()
        dictationRouteTask = nil
        activeRecordingContinuation?.finish()
        activeRecordingContinuation = nil
        activeRecordingMessages = nil
        readyTimeoutTask?.cancel()
        readyTimeoutTask = nil
        if let cont = readyContinuation {
            readyContinuation = nil
            cont.resume(throwing: VoiceInputError.internalError("Dictation routing stopped"))
        }
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
        ]
    }

    func makeSession(
        context: VoiceProviderContext,
        preparation: VoiceProviderPreparation
    ) throws -> any VoiceTranscriptionSession {
        guard let connection = context.serverConnection else {
            throw VoiceInputError.serverNotConnected
        }
        guard let readinessTask = activeReadinessTask else {
            throw VoiceInputError.internalError("Dictation readiness task not prepared")
        }
        guard let recordingMessages = activeRecordingMessages else {
            throw VoiceInputError.internalError("Dictation recording messages not prepared")
        }
        // Clear per-recording state — session now owns these.
        activeReadinessTask = nil
        activeRecordingMessages = nil
        return OppiDictationSession(
            connection: connection,
            readinessTask: readinessTask,
            messages: recordingMessages
        )
    }
}
