import Accelerate
@preconcurrency import AVFoundation
import Foundation
import OSLog

private let logger = Logger(subsystem: AppIdentifiers.subsystem, category: "DictationSession")

/// Voice transcription session that streams raw PCM audio over a `/dictation` WebSocket
/// and receives full transcript replacements from the server.
///
/// Key simplification vs the old RemoteASRTranscriber:
/// - No chunk timing on the client — streams PCM continuously
/// - No transcript merging/dedup — server returns full text each time
/// - `dictation_result` maps to `.replaceFinalTranscript`
/// - `dictation_final` maps to `.replaceFinalTranscript` + stream completion
@MainActor
final class OppiDictationSession: VoiceTranscriptionSession {
    let events: AsyncThrowingStream<VoiceSessionEvent, Error>
    let audioLevels: AsyncStream<Float>

    private let ws: DictationWebSocket
    private let eventContinuation: AsyncThrowingStream<VoiceSessionEvent, Error>.Continuation
    private let audioLevelContinuation: AsyncStream<Float>.Continuation
    private var messageListenTask: Task<Void, Never>?
    private var audioEngine: AVAudioEngine?
    private var audioConverter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var stopped = false

    init(ws: DictationWebSocket) {
        self.ws = ws

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

        return VoiceSessionStartTimings(
            analyzerStartMs: analyzerStartMs,
            audioStartMs: audioStartMs
        )
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true

        stopAudioEngine()

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

        do {
            try await ws.send(.cancel)
        } catch {
            logger.debug("Failed to send dictation_cancel: \(error.localizedDescription, privacy: .public)")
        }

        messageListenTask?.cancel()
        messageListenTask = nil
        ws.disconnect()
        cleanup()
    }

    // MARK: - Audio Capture

    /// Start the audio engine, converting hardware input to 16kHz 16-bit mono PCM
    /// and sending binary frames over the WebSocket.
    private func startAudioCapture() throws {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        ) else {
            throw VoiceInputError.internalError("Cannot create 16kHz mono format")
        }
        self.targetFormat = format

        let converter: AVAudioConverter?
        if inputFormat != format {
            converter = AVAudioConverter(from: inputFormat, to: format)
        } else {
            converter = nil
        }
        self.audioConverter = converter

        // Capture weak references for the nonisolated audio tap
        let weakWS = WeakRef(ws)
        let levelContinuation = audioLevelContinuation

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { buffer, _ in
            // Convert to target format if needed
            let outputBuffer: AVAudioPCMBuffer
            if let converter {
                let frameCapacity = AVAudioFrameCount(
                    Double(buffer.frameLength) * format.sampleRate / inputFormat.sampleRate
                )
                guard let converted = AVAudioPCMBuffer(
                    pcmFormat: format,
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

            // Compute audio level from float samples
            if let channelData = outputBuffer.floatChannelData?[0] {
                let frameLength = UInt(outputBuffer.frameLength)
                var rms: Float = 0
                vDSP_rmsqv(channelData, 1, &rms, frameLength)
                let level = min(1.0, rms * 25.0)
                levelContinuation.yield(level)
            }

            // Convert float32 to 16-bit signed integer PCM and send as binary
            let pcmData = Self.convertToInt16PCM(buffer: outputBuffer)
            guard !pcmData.isEmpty else { return }

            guard let ws = weakWS.value else { return }
            Task { @MainActor in
                try? await ws.sendAudio(pcmData)
            }
        }

        engine.prepare()
        try engine.start()
        self.audioEngine = engine

        logger.info("Audio capture started (16kHz, 16-bit, mono)")
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
        let stream = ws.messages
        messageListenTask = Task { [weak self] in
            do {
                for try await message in stream {
                    guard !Task.isCancelled else { break }
                    guard let self else { break }

                    switch message {
                    case .ready:
                        logger.debug("Server ready for dictation")

                    case .result(let text, let version):
                        logger.debug("Dictation result v\(version): \(text.count) chars")
                        eventContinuation.yield(.replaceFinalTranscript(text))

                    case .final_(let text, _, _):
                        logger.info("Dictation final: \(text.count) chars")
                        if !text.isEmpty {
                            eventContinuation.yield(.replaceFinalTranscript(text))
                        }
                        eventContinuation.finish()
                        ws.disconnect()
                        return

                    case .error(let error, let fatal):
                        logger.error("Dictation error (fatal=\(fatal)): \(error, privacy: .public)")
                        if fatal {
                            eventContinuation.finish(
                                throwing: VoiceInputError.internalError("Server error: \(error)")
                            )
                            ws.disconnect()
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

            // Stream ended without dictation_final (disconnect, etc.)
            self?.eventContinuation.finish()
        }
    }

    private func cleanup() {
        messageListenTask = nil
        eventContinuation.finish()
        audioLevelContinuation.finish()
    }
}

// MARK: - Weak wrapper for nonisolated audio tap

/// Sendable weak reference wrapper used to pass MainActor-isolated
/// objects into nonisolated audio tap closures without violating concurrency rules.
private final class WeakRef<T: AnyObject>: @unchecked Sendable {
    weak var value: T?
    init(_ value: T) {
        self.value = value
    }
}
