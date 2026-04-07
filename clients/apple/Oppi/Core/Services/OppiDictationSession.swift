import Accelerate
@preconcurrency import AVFoundation
import Foundation
import OSLog

private let logger = Logger(subsystem: AppIdentifiers.subsystem, category: "DictationSession")

/// Voice transcription session that streams raw PCM audio over a `/dictation` WebSocket
/// and receives full transcript replacements from the server.
///
/// Streams raw PCM continuously — no client-side chunk timing.
/// The server returns full text each time:
/// - `dictation_result` maps to `.replaceFinalTranscript`
/// - `dictation_final` maps to `.replaceFinalTranscript` + stream completion
///
/// **Optimistic recording:** Audio capture starts immediately on `start()`. A background
/// drain task blocks on `readinessTask` (WS `dictation_ready`) before forwarding audio,
/// so the UI shows `.recording` with live waveform while the network round-trip completes.
@MainActor
final class OppiDictationSession: VoiceTranscriptionSession {
    let events: AsyncThrowingStream<VoiceSessionEvent, Error>
    let audioLevels: AsyncStream<Float>

    private let ws: DictationWebSocket
    /// Resolves once the server sends `dictation_ready`. Audio is buffered until then.
    private let readinessTask: Task<DictationProviderInfo?, Error>
    /// Recording-scoped message stream, created by the provider before each tap.
    /// Scoped to this recording only — the WS connection outlives it.
    private let recordingMessages: AsyncThrowingStream<DictationServerMessage, Error>
    private let eventContinuation: AsyncThrowingStream<VoiceSessionEvent, Error>.Continuation
    private let audioLevelContinuation: AsyncStream<Float>.Continuation
    private var messageListenTask: Task<Void, Never>?
    /// Drains the audio stream to the WS, waiting for readiness first.
    private var audioDrainTask: Task<Void, Never>?
    /// Feeds raw PCM chunks from the audio tap into the drain task.
    private var audioContinuation: AsyncStream<Data>.Continuation?
    /// Pending audio stream, transferred to the drain task on start.
    private var pendingAudioStream: AsyncStream<Data>?
    private var audioEngine: AVAudioEngine?
    private var audioConverter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var stopped = false

    init(
        ws: DictationWebSocket,
        readinessTask: Task<DictationProviderInfo?, Error>,
        messages: AsyncThrowingStream<DictationServerMessage, Error>
    ) {
        self.ws = ws
        self.readinessTask = readinessTask
        self.recordingMessages = messages

        let (events, eventContinuation) = AsyncThrowingStream.makeStream(of: VoiceSessionEvent.self)
        self.events = events
        self.eventContinuation = eventContinuation

        let (audioLevels, audioLevelContinuation) = AsyncStream.makeStream(of: Float.self)
        self.audioLevels = audioLevels
        self.audioLevelContinuation = audioLevelContinuation
    }

    func start() async throws -> VoiceSessionStartTimings {
        let analyzerStart = ContinuousClock.now

        // Start listening for server messages
        startMessageListener()
        let analyzerStartMs = analyzerStart.elapsedMs()

        // Start audio engine with conversion to 16kHz mono
        let audioStart = ContinuousClock.now
        try startAudioCapture()
        let audioStartMs = audioStart.elapsedMs()

        // Begin draining audio to WS in background (blocks on readinessTask first)
        startAudioDrainTask()

        return VoiceSessionStartTimings(
            analyzerStartMs: analyzerStartMs,
            audioStartMs: audioStartMs
        )
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true

        stopAudioEngine()
        // Close the audio stream so the drain task's for-await loop exits naturally
        audioContinuation?.finish()
        audioContinuation = nil

        // Wait for the drain task to flush all buffered audio before signalling stop.
        // This ensures no audio is lost if the WS was still connecting.
        await audioDrainTask?.value
        audioDrainTask = nil

        // Send stop, wait for final transcript
        do {
            try await ws.send(.stop)
            logger.info("Sent dictation_stop, waiting for final")
        } catch {
            logger.error("Failed to send dictation_stop: \(error.localizedDescription, privacy: .public)")
        }

        // Wait for the message listener to finish (it completes on dictation_final or error)
        await messageListenTask?.value
        cleanup()
    }

    func cancel() async {
        guard !stopped else { return }
        stopped = true

        stopAudioEngine()
        audioContinuation?.finish()
        audioContinuation = nil

        // Cancel background setup and drain — no audio to flush on cancel
        readinessTask.cancel()
        audioDrainTask?.cancel()
        audioDrainTask = nil

        do {
            try await ws.send(.cancel)
        } catch {
            logger.debug("Failed to send dictation_cancel: \(error.localizedDescription, privacy: .public)")
        }

        messageListenTask?.cancel()
        messageListenTask = nil
        // Do NOT disconnect ws — owned by OppiDictationProvider, persists for session lifetime.
        cleanup()
    }

    // MARK: - Audio Capture

    /// Start the audio engine via a non-actor helper.
    /// The `installTap` closure MUST NOT inherit @MainActor isolation —
    /// it runs on the real-time audio thread and libdispatch will crash
    /// with `EXC_BREAKPOINT: Block was expected to execute on queue
    /// [com.apple.main-thread]` if the closure carries MainActor context.
    ///
    /// PCM chunks are yielded into `pendingAudioStream` via `audioContinuation`.
    /// `AsyncStream.Continuation.yield()` is thread-safe and safe to call
    /// directly from the RT audio thread without dispatch indirection.
    private func startAudioCapture() throws {
        let (audioStream, audioContinuation) = AsyncStream<Data>.makeStream()
        self.audioContinuation = audioContinuation
        self.pendingAudioStream = audioStream

        let (engine, levelStream) = try DictationAudioEngineHelper.startEngine(
            audioContinuation: audioContinuation,
            audioLevelContinuation: audioLevelContinuation
        )
        self.audioEngine = engine

        // Drain level stream in the background (inherits MainActor from class)
        Task { [weak self] in
            for await level in levelStream {
                self?.audioLevelContinuation.yield(level)
            }
        }

        logger.info("Audio capture started (16kHz, 16-bit, mono)")
    }

    /// Starts a background task that:
    /// 1. Waits for `dictation_ready` (via readinessTask)
    /// 2. Forwards all buffered + subsequent PCM chunks to the WS
    ///
    /// If WS setup fails, the event stream is finished with the error
    /// so `VoiceInputManager` transitions to `.error` state.
    private func startAudioDrainTask() {
        guard let audioStream = pendingAudioStream else { return }
        pendingAudioStream = nil

        let ws = self.ws
        let readinessTask = self.readinessTask
        let eventContinuation = self.eventContinuation

        audioDrainTask = Task {
            // Block until server is ready (or fails)
            do {
                let info = try await readinessTask.value
                // Emit provider metadata so VoiceInputManager can update metric tags
                // with the actual stt_backend and model (unknown at setup time).
                if let info {
                    eventContinuation.yield(.providerMetricTags([
                        "stt_backend": info.sttProvider,
                        "model": info.sttModel,
                        "llm_correction": info.llmCorrectionEnabled ? "1" : "0",
                    ]))
                }
            } catch is CancellationError {
                // Cancelled by cancel() — clean exit, no error to surface
                return
            } catch {
                logger.error("Dictation WS setup failed: \(error.localizedDescription, privacy: .public)")
                eventContinuation.finish(throwing: error)
                return
            }

            // WS is ready — pipe all audio (buffered + live) to the server
            for await chunk in audioStream {
                guard !Task.isCancelled else { break }
                try? await ws.sendAudio(chunk)
            }
        }
    }

    private func stopAudioEngine() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
        audioConverter = nil
    }

    // MARK: - PCM Conversion

    /// Convert float32 PCM buffer to 16-bit signed integer PCM data (little-endian).
    nonisolated static func convertToInt16PCM(buffer: AVAudioPCMBuffer) -> Data {
        guard let floatData = buffer.floatChannelData?[0] else { return Data() }
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return Data() }

        var data = Data(count: frameLength * 2)
        data.withUnsafeMutableBytes { rawBuffer in
            guard let int16Ptr = rawBuffer.bindMemory(to: Int16.self).baseAddress else { return }
            for i in 0..<frameLength {
                // Clamp float [-1.0, 1.0] to Int16 range
                let sample = max(-1.0, min(1.0, floatData[i]))
                int16Ptr[i] = Int16(sample * Float(Int16.max))
            }
        }
        return data
    }

    // MARK: - Server Message Handling

    private func startMessageListener() {
        // Use the recording-scoped stream from OppiDictationProvider.
        // Ends on dictation_final or WS drop. The WS itself is NOT disconnected here.
        let stream = recordingMessages
        messageListenTask = Task { [weak self] in
            do {
                for try await message in stream {
                    guard !Task.isCancelled else { break }
                    guard let self else { break }

                    switch message {
                    case .ready:
                        logger.debug("dictation_ready received (recording started)")

                    case .result(let text, let snap):
                        logger.debug("Dictation result: \(text.count) chars\(snap ? " (snap)" : "")")
                        eventContinuation.yield(.replaceFinalTranscript(text, snap: snap))

                    case .final_(let text, _, _):
                        logger.info("Dictation final: \(text.count) chars")
                        if !text.isEmpty {
                            eventContinuation.yield(.replaceFinalTranscript(text))
                        }
                        // Recording complete. The WS receive loop already finished
                        // this stream; the for-await exits naturally after this return.
                        eventContinuation.finish()
                        return

                    case .error(let error, let fatal):
                        logger.error("Dictation error (fatal=\(fatal)): \(error, privacy: .public)")
                        if fatal {
                            eventContinuation.finish(
                                throwing: VoiceInputError.internalError("Server error: \(error)")
                            )
                            return
                        }
                    }
                }
            } catch {
                if !Task.isCancelled {
                    logger.error("Message stream error: \(error.localizedDescription, privacy: .public)")
                    self?.eventContinuation.finish(throwing: error)
                }
            }

            // Stream ended without dictation_final (WS dropped, etc.)
            self?.eventContinuation.finish()
        }
    }

    private func cleanup() {
        audioDrainTask = nil
        audioContinuation = nil
        pendingAudioStream = nil
        messageListenTask = nil
        eventContinuation.finish()
        audioLevelContinuation.finish()
    }
}

// MARK: - Non-actor audio engine helper

/// Starts the AVAudioEngine + installTap outside any actor context.
/// The installTap closure runs on the real-time audio thread.
/// If it inherits @MainActor (from OppiDictationSession), libdispatch
/// crashes with EXC_BREAKPOINT. This plain enum has no actor isolation.
///
/// PCM chunks are yielded into `audioContinuation` directly from the RT thread.
/// `AsyncStream.Continuation.yield()` is thread-safe and does not create Tasks,
/// so it is safe to call from the real-time audio callback.
enum DictationAudioEngineHelper {
    static func startEngine(
        audioContinuation: AsyncStream<Data>.Continuation,
        audioLevelContinuation: AsyncStream<Float>.Continuation
    ) throws -> (AVAudioEngine, AsyncStream<Float>) {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        ) else {
            throw VoiceInputError.internalError("Cannot create 16kHz mono format")
        }

        let converter: AVAudioConverter?
        if inputFormat != targetFormat {
            converter = AVAudioConverter(from: inputFormat, to: targetFormat)
        } else {
            converter = nil
        }

        let (levelStream, levelContinuation) = AsyncStream<Float>.makeStream()

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { buffer, _ in
            let outputBuffer: AVAudioPCMBuffer
            if let converter {
                let frameCapacity = AVAudioFrameCount(
                    Double(buffer.frameLength) * targetFormat.sampleRate / inputFormat.sampleRate
                )
                guard let converted = AVAudioPCMBuffer(
                    pcmFormat: targetFormat,
                    frameCapacity: frameCapacity
                ) else { return }

                var error: NSError?
                converter.convert(to: converted, error: &error) { _, outStatus in
                    outStatus.pointee = .haveData
                    return buffer
                }
                if error != nil { return }
                outputBuffer = converted
            } else {
                outputBuffer = buffer
            }

            // Audio level — AsyncStream.Continuation.yield() is thread-safe
            if let channelData = outputBuffer.floatChannelData?[0] {
                let frameLength = UInt(outputBuffer.frameLength)
                var rms: Float = 0
                vDSP_rmsqv(channelData, 1, &rms, frameLength)
                let level = min(1.0, rms * 25.0)
                levelContinuation.yield(level)
            }

            // Yield PCM chunk to the audio stream — the drain task forwards
            // to WS once dictation_ready is received
            let pcmData = OppiDictationSession.convertToInt16PCM(buffer: outputBuffer)
            guard !pcmData.isEmpty else { return }
            audioContinuation.yield(pcmData)
        }

        engine.prepare()
        try engine.start()
        return (engine, levelStream)
    }
}


