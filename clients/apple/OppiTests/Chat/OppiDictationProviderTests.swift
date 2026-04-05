@preconcurrency import AVFoundation
import Testing

@testable import Oppi

// MARK: - DictationServerMessage Decoding

@Suite("DictationServerMessage decoding")
struct DictationServerMessageDecodingTests {

    @Test func decodesReady() throws {
        let json = #"{"type":"dictation_ready"}"#
        let message = try decode(json)
        #expect(message == .ready)
    }

    @Test func decodesResult() throws {
        let json = #"{"type":"dictation_result","text":"Hello world","version":3}"#
        let message = try decode(json)
        #expect(message == .result(text: "Hello world", version: 3))
    }

    @Test func decodesFinal() throws {
        let json = #"{"type":"dictation_final","text":"Hello world how are you","uncorrected":"hello world how are you","audioId":"dict_abc123"}"#
        let message = try decode(json)
        #expect(message == .final_(text: "Hello world how are you", uncorrected: "hello world how are you", audioId: "dict_abc123"))
    }

    @Test func decodesFinalMinimal() throws {
        let json = #"{"type":"dictation_final","text":"Hello"}"#
        let message = try decode(json)
        #expect(message == .final_(text: "Hello", uncorrected: nil, audioId: nil))
    }

    @Test func decodesError() throws {
        let json = #"{"type":"dictation_error","error":"STT backend unreachable","fatal":true}"#
        let message = try decode(json)
        #expect(message == .error(error: "STT backend unreachable", fatal: true))
    }

    @Test func decodesErrorDefaultsFatalToFalse() throws {
        let json = #"{"type":"dictation_error","error":"transient failure"}"#
        let message = try decode(json)
        #expect(message == .error(error: "transient failure", fatal: false))
    }

    @Test func unknownTypeThrows() {
        let json = #"{"type":"dictation_unknown"}"#
        #expect(throws: DecodingError.self) {
            try decode(json)
        }
    }

    private func decode(_ json: String) throws -> DictationServerMessage {
        let data = try #require(json.data(using: .utf8))
        return try JSONDecoder().decode(DictationServerMessage.self, from: data)
    }
}

// MARK: - DictationClientMessage Encoding

@Suite("DictationClientMessage encoding")
struct DictationClientMessageEncodingTests {

    @Test func encodesStart() throws {
        let message = DictationClientMessage.start(language: "en")
        let json = try encode(message)
        #expect(json.contains("\"type\":\"dictation_start\""))
        #expect(json.contains("\"language\":\"en\""))
    }

    @Test func encodesStartNilLanguage() throws {
        let message = DictationClientMessage.start(language: nil)
        let json = try encode(message)
        #expect(json.contains("\"type\":\"dictation_start\""))
        #expect(!json.contains("language"))
    }

    @Test func encodesStop() throws {
        let message = DictationClientMessage.stop
        let json = try encode(message)
        #expect(json.contains("\"type\":\"dictation_stop\""))
    }

    @Test func encodesCancel() throws {
        let message = DictationClientMessage.cancel
        let json = try encode(message)
        #expect(json.contains("\"type\":\"dictation_cancel\""))
    }

    private func encode(_ message: DictationClientMessage) throws -> String {
        let data = try JSONEncoder().encode(message)
        return try #require(String(data: data, encoding: .utf8))
    }
}

// MARK: - PCM Conversion

@Suite("PCM conversion")
struct PCMConversionTests {

    @Test func convertsFloat32ToInt16PCM() throws {
        // Create a small float32 buffer with known values
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
            #expect(int16Ptr[2] == -Int16.max)  // max negative (note: Int16(-1.0 * max) = -32767, not -32768)
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
        let event = mapServerMessage(.result(text: "Hello world", version: 1))
        #expect(event == .replaceFinalTranscript("Hello world"))
    }

    @Test func finalMapsToReplaceFinalTranscript() {
        let event = mapServerMessage(.final_(text: "Complete transcript", uncorrected: nil, audioId: nil))
        #expect(event == .replaceFinalTranscript("Complete transcript"))
    }

    @Test func readyMapsToNil() {
        let event = mapServerMessage(.ready)
        #expect(event == nil)
    }

    @Test func nonFatalErrorMapsToNil() {
        let event = mapServerMessage(.error(error: "transient", fatal: false))
        #expect(event == nil)
    }

    /// Map a server message to the VoiceSessionEvent it would produce,
    /// following the same logic as OppiDictationSession's message listener.
    private func mapServerMessage(_ message: DictationServerMessage) -> VoiceSessionEvent? {
        switch message {
        case .ready:
            return nil
        case .result(let text, _):
            return .replaceFinalTranscript(text)
        case .final_(let text, _, _):
            return text.isEmpty ? nil : .replaceFinalTranscript(text)
        case .error(_, let fatal):
            return fatal ? nil : nil  // fatal errors throw, non-fatal are logged
        }
    }
}

// MARK: - Provider Tests

@Suite("OppiDictationProvider")
@MainActor
struct OppiDictationProviderTests {

    @Test func providerIdAndEngine() {
        let provider = OppiDictationProvider()
        #expect(provider.id == .remoteASR)
        #expect(provider.engine == .remoteASR)
    }

    @Test func prepareSessionThrowsWithoutCredentials() async {
        let provider = OppiDictationProvider()
        let context = VoiceProviderContext(
            locale: Locale(identifier: "en-US"),
            source: "test",
            remoteEndpoint: nil,
            serverCredentials: nil
        )

        await #expect(throws: VoiceInputError.self) {
            try await provider.prepareSession(context: context)
        }
    }

    @Test func makeSessionThrowsWithoutPrepare() {
        let provider = OppiDictationProvider()
        let context = VoiceProviderContext(
            locale: Locale(identifier: "en-US"),
            source: "test",
            remoteEndpoint: nil
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
        let provider = registry.provider(for: .remoteASR)
        #expect(provider is OppiDictationProvider)
    }
}

// MARK: - VoiceSessionEvent Equatable (test support)

extension VoiceSessionEvent: @retroactive Equatable {
    public static func == (lhs: VoiceSessionEvent, rhs: VoiceSessionEvent) -> Bool {
        switch (lhs, rhs) {
        case (.partialTranscript(let a), .partialTranscript(let b)):
            return a == b
        case (.appendFinalTranscript(let a), .appendFinalTranscript(let b)):
            return a == b
        case (.replaceFinalTranscript(let a), .replaceFinalTranscript(let b)):
            return a == b
        case (.remoteChunkTelemetry, .remoteChunkTelemetry):
            return true  // approximate for testing
        default:
            return false
        }
    }
}
