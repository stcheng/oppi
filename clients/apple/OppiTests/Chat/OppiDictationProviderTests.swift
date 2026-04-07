@preconcurrency import AVFoundation
import Testing

@testable import Oppi

// MARK: - Dictation ServerMessage Decoding

@Suite("Dictation ServerMessage decoding")
struct DictationServerMessageDecodingTests {

    @Test func decodesReadyMinimal() throws {
        let message = try decode(#"{"type":"dictation_ready"}"#)
        #expect(message == .dictationReady(provider: nil))
    }

    @Test func decodesReadyWithProviderInfo() throws {
        let json = #"{"type":"dictation_ready","sttProvider":"mlx-server","sttModel":"Qwen3-ASR-1.7B","llmCorrectionEnabled":true}"#
        let message = try decode(json)
        let expected = DictationProviderInfo(
            sttProvider: "mlx-server",
            sttModel: "Qwen3-ASR-1.7B",
            llmCorrectionEnabled: true
        )
        #expect(message == .dictationReady(provider: expected))
    }

    @Test func decodesReadyWithPartialProviderInfo() throws {
        // If only sttProvider is present but not sttModel, provider should be nil
        let json = #"{"type":"dictation_ready","sttProvider":"openai"}"#
        let message = try decode(json)
        #expect(message == .dictationReady(provider: nil))
    }

    @Test func decodesResult() throws {
        let json = #"{"type":"dictation_result","text":"Hello world"}"#
        let message = try decode(json)
        #expect(message == .dictationResult(text: "Hello world", snap: false))
    }

    @Test func decodesFinal() throws {
        let json = #"{"type":"dictation_final","text":"Hello world how are you","uncorrected":"hello world how are you","audioId":"dict_abc123"}"#
        let message = try decode(json)
        #expect(message == .dictationFinal(text: "Hello world how are you", uncorrected: "hello world how are you", audioId: "dict_abc123"))
    }

    @Test func decodesFinalMinimal() throws {
        let json = #"{"type":"dictation_final","text":"Hello"}"#
        let message = try decode(json)
        #expect(message == .dictationFinal(text: "Hello", uncorrected: nil, audioId: nil))
    }

    @Test func decodesError() throws {
        let json = #"{"type":"dictation_error","error":"STT backend unreachable","fatal":true}"#
        let message = try decode(json)
        #expect(message == .dictationError(error: "STT backend unreachable", fatal: true))
    }

    @Test func decodesErrorDefaultsFatalToFalse() throws {
        let json = #"{"type":"dictation_error","error":"transient failure"}"#
        let message = try decode(json)
        #expect(message == .dictationError(error: "transient failure", fatal: false))
    }

    private func decode(_ json: String) throws -> ServerMessage {
        let data = try #require(json.data(using: .utf8))
        return try JSONDecoder().decode(ServerMessage.self, from: data)
    }
}

// MARK: - Dictation ClientMessage Encoding

@Suite("Dictation ClientMessage encoding")
struct DictationClientMessageEncodingTests {

    @Test func encodesStart() throws {
        let message = ClientMessage.dictationStart
        let json = try encode(message)
        #expect(json.contains("\"type\":\"dictation_start\""))
    }

    @Test func encodesStop() throws {
        let message = ClientMessage.dictationStop
        let json = try encode(message)
        #expect(json.contains("\"type\":\"dictation_stop\""))
    }

    @Test func encodesCancel() throws {
        let message = ClientMessage.dictationCancel
        let json = try encode(message)
        #expect(json.contains("\"type\":\"dictation_cancel\""))
    }

    private func encode(_ message: ClientMessage) throws -> String {
        let data = try JSONEncoder().encode(message)
        return try #require(String(data: data, encoding: .utf8))
    }
}

// MARK: - PCM Conversion

@Suite("PCM conversion")
struct PCMConversionTests {

    @Test func convertsFloat32ToInt16PCM() throws {
        let format = try #require(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        ))

        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4))
        buffer.frameLength = 4

        let floatData = try #require(buffer.floatChannelData?[0])
        floatData[0] = 0.0      // silence
        floatData[1] = 1.0      // max positive
        floatData[2] = -1.0     // max negative
        floatData[3] = 0.5      // mid positive

        let pcmData = OppiDictationSession.convertToInt16PCM(buffer: buffer)

        // 4 samples * 2 bytes each = 8 bytes
        #expect(pcmData.count == 8)

        // Verify sample values (little-endian Int16)
        pcmData.withUnsafeBytes { raw in
            let int16Ptr = raw.bindMemory(to: Int16.self)
            #expect(int16Ptr[0] == 0)           // silence
            #expect(int16Ptr[1] == Int16.max)   // max positive
            #expect(int16Ptr[2] == -Int16.max)  // max negative
            #expect(int16Ptr[3] == Int16(0.5 * Float(Int16.max)))  // mid positive
        }
    }

    @Test func emptyBufferReturnsEmptyData() throws {
        let format = try #require(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        ))

        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 0))
        buffer.frameLength = 0

        let pcmData = OppiDictationSession.convertToInt16PCM(buffer: buffer)
        #expect(pcmData.isEmpty)
    }

    @Test func clampsOutOfRangeValues() throws {
        let format = try #require(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        ))

        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2))
        buffer.frameLength = 2

        let floatData = try #require(buffer.floatChannelData?[0])
        floatData[0] = 2.0    // over max
        floatData[1] = -3.0   // under min

        let pcmData = OppiDictationSession.convertToInt16PCM(buffer: buffer)

        pcmData.withUnsafeBytes { raw in
            let int16Ptr = raw.bindMemory(to: Int16.self)
            #expect(int16Ptr[0] == Int16.max)    // clamped to max
            #expect(int16Ptr[1] == -Int16.max)   // clamped to min
        }
    }
}

// MARK: - Event Mapping

@Suite("Dictation event mapping")
struct DictationEventMappingTests {

    @Test func resultMapsToReplaceFinalTranscript() {
        let event = mapServerMessage(.dictationResult(text: "Hello world", snap: false))
        #expect(event == .replaceFinalTranscript("Hello world"))
    }

    @Test func finalMapsToReplaceFinalTranscript() {
        let event = mapServerMessage(.dictationFinal(text: "Complete transcript", uncorrected: nil, audioId: nil))
        #expect(event == .replaceFinalTranscript("Complete transcript"))
    }

    @Test func readyMapsToNil() {
        let event = mapServerMessage(.dictationReady(provider: nil))
        #expect(event == nil)
    }

    @Test func nonFatalErrorMapsToNil() {
        let event = mapServerMessage(.dictationError(error: "transient", fatal: false))
        #expect(event == nil)
    }

    /// Map a server message to the VoiceSessionEvent it would produce,
    /// following the same logic as OppiDictationSession's message listener.
    private func mapServerMessage(_ message: ServerMessage) -> VoiceSessionEvent? {
        switch message {
        case .dictationReady:
            return nil
        case .dictationResult(let text, let snap):
            return .replaceFinalTranscript(text, snap: snap)
        case .dictationFinal(let text, _, _):
            return text.isEmpty ? nil : .replaceFinalTranscript(text)
        case .dictationError(_, let fatal):
            return fatal ? nil : nil
        default:
            return nil
        }
    }
}

// MARK: - Provider Tests

@Suite("OppiDictationProvider")
@MainActor
struct OppiDictationProviderTests {

    @Test func providerIdAndEngine() {
        let provider = OppiDictationProvider()
        #expect(provider.id == .oppiServer)
        #expect(provider.engine == .serverDictation)
    }

    @Test func prepareSessionThrowsWithoutCredentials() async {
        let provider = OppiDictationProvider()
        let context = VoiceProviderContext(
            locale: Locale(identifier: "en-US"),
            source: "test",
            serverCredentials: nil
        )

        await #expect(throws: VoiceInputError.self) {
            try await provider.prepareSession(context: context)
        }
    }

    @Test func prepareSessionThrowsWithoutConnection() async {
        let provider = OppiDictationProvider()
        // Has credentials but no connection
        let context = VoiceProviderContext(
            locale: Locale(identifier: "en-US"),
            source: "test",
            serverCredentials: ServerCredentials(
                host: "localhost", port: 7749,
                token: "test-token",
                name: "test-server",
                scheme: .http
            )
        )

        await #expect(throws: VoiceInputError.self) {
            try await provider.prepareSession(context: context)
        }
    }

    @Test func makeSessionThrowsWithoutPrepare() {
        let provider = OppiDictationProvider()
        let context = VoiceProviderContext(
            locale: Locale(identifier: "en-US"),
            source: "test"
        )
        let preparation = VoiceProviderPreparation(
            audioFormat: nil,
            pathTag: "test",
            setupMetricTags: [:]
        )

        #expect(throws: VoiceInputError.self) {
            try provider.makeSession(context: context, preparation: preparation)
        }
    }

    @Test func registryIncludesOppiDictationProvider() {
        let registry = VoiceProviderRegistry.makeDefault()
        let provider = registry.provider(for: .serverDictation)
        #expect(provider is OppiDictationProvider)
    }
}

// MARK: - Disconnect Regression Tests

@Suite("Dictation disconnect regression")
@MainActor
struct DictationDisconnectRegressionTests {

    @Test func unexpectedMessageStreamEndSurfacesDisconnectError() async {
        let connection = ServerConnection()
        let recordingPair = AsyncStream.makeStream(of: ServerMessage.self)
        let session = OppiDictationSession(
            connection: connection,
            readinessTask: Task { nil },
            messages: recordingPair.stream
        )

        let errorTask = Task {
            await consumeStreamError(from: session.events)
        }

        session._startMessageListenerForTesting()
        recordingPair.continuation.finish()

        let error = await errorTask.value
        #expect(error?.localizedDescription == "Dictation connection lost")
    }

    @Test func audioDrainSendFailureSurfacesDisconnectError() async {
        let connection = ServerConnection()
        connection._sendDictationAudioForTesting = { _ in
            throw WebSocketError.notConnected
        }

        let recordingPair = AsyncStream.makeStream(of: ServerMessage.self)
        let audioPair = AsyncStream.makeStream(of: Data.self)
        let session = OppiDictationSession(
            connection: connection,
            readinessTask: Task { nil },
            messages: recordingPair.stream
        )

        let errorTask = Task {
            await consumeStreamError(from: session.events)
        }

        session._setPendingAudioStreamForTesting(audioPair.stream)
        session._startAudioDrainTaskForTesting()
        audioPair.continuation.yield(Data([0x01, 0x02]))
        audioPair.continuation.finish()

        let error = await errorTask.value
        #expect(error?.localizedDescription == "Dictation connection lost")
    }

    private func consumeStreamError(
        from events: AsyncThrowingStream<VoiceSessionEvent, Error>
    ) async -> Error? {
        do {
            for try await _ in events {}
            return nil
        } catch {
            return error
        }
    }
}

// MARK: - Crash Regression Tests

@Suite("Dictation crash regression")
@MainActor
struct DictationCrashRegressionTests {

    /// Regression: provider(for:) used fatalError on missing provider,
    /// crashing the app when server returned 404 for /dictation.
    /// Now throws VoiceInputError instead.
    @Test func providerLookupDoesNotCrashOnMissingEngine() {
        let registry = VoiceProviderRegistry(providers: [])
        let provider = registry.provider(for: .serverDictation)
        #expect(provider == nil, "Missing provider should return nil, not crash")
    }

    /// Regression: VoiceInputManager.provider(for:) used fatalError.
    /// Verify it throws a recoverable error instead.
    @Test func managerHandlesMissingProviderGracefully() async throws {
        let emptyRegistry = VoiceProviderRegistry(providers: [])
        let manager = VoiceInputManager(
            providerRegistry: emptyRegistry,
            systemAccess: MockSystemAccess(hasPermissions: true)
        )
        manager.setEngineMode(.remote)

        do {
            try await manager.startRecording(source: "test")
            Issue.record("Expected startRecording to throw for missing provider")
        } catch {
            #expect(manager.state != .recording)
        }
    }
}

// MARK: - Mock System Access (for crash regression tests)

private struct MockSystemAccess: VoiceInputSystemAccessing {
    let hasPermissions: Bool
    var hasMicPermission: Bool { hasPermissions }
    func requestPermissions() async -> Bool { hasPermissions }
    func requestMicPermission() async -> Bool { hasPermissions }
    func activateAudioSession() throws {}
    func deactivateAudioSession() {}
}

// MARK: - VoiceSessionEvent Equatable (test support)

extension VoiceSessionEvent: @retroactive Equatable {
    public static func == (lhs: VoiceSessionEvent, rhs: VoiceSessionEvent) -> Bool {
        switch (lhs, rhs) {
        case (.partialTranscript(let a), .partialTranscript(let b)):
            return a == b
        case (.appendFinalTranscript(let a), .appendFinalTranscript(let b)):
            return a == b
        case (.replaceFinalTranscript(let a, let snapA), .replaceFinalTranscript(let b, let snapB)):
            return a == b && snapA == snapB
        case (.remoteChunkTelemetry, .remoteChunkTelemetry):
            return true
        case (.providerMetricTags(let a), .providerMetricTags(let b)):
            return a == b
        default:
            return false
        }
    }
}
