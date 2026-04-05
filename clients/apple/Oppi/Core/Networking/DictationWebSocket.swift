import Foundation
import OSLog

private let logger = Logger(subsystem: AppIdentifiers.subsystem, category: "DictationWS")

// MARK: - Message Types

enum DictationClientMessage: Encodable, Sendable {
    case start(language: String?)
    case stop
    case cancel

    private enum CodingKeys: String, CodingKey {
        case type
        case language
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .start(let language):
            try container.encode("dictation_start", forKey: .type)
            try container.encodeIfPresent(language, forKey: .language)
        case .stop:
            try container.encode("dictation_stop", forKey: .type)
        case .cancel:
            try container.encode("dictation_cancel", forKey: .type)
        }
    }
}

/// Server-provided STT backend metadata, sent with `dictation_ready`.
/// Used to tag client metrics with the actual provider/model the server is using.
struct DictationProviderInfo: Sendable, Equatable {
    let sttProvider: String
    let sttModel: String
    let llmCorrectionEnabled: Bool
}

enum DictationServerMessage: Decodable, Sendable, Equatable {
    case ready(provider: DictationProviderInfo?)
    case result(text: String, version: Int)
    case final_(text: String, uncorrected: String?, audioId: String?)
    case error(error: String, fatal: Bool)

    private enum CodingKeys: String, CodingKey {
        case type
        case text
        case version
        case uncorrected
        case audioId
        case error
        case fatal
        case sttProvider
        case sttModel
        case llmCorrectionEnabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "dictation_ready":
            let providerName = try container.decodeIfPresent(String.self, forKey: .sttProvider)
            let model = try container.decodeIfPresent(String.self, forKey: .sttModel)
            let llmEnabled = try container.decodeIfPresent(Bool.self, forKey: .llmCorrectionEnabled)
            let info: DictationProviderInfo?
            if let providerName, let model {
                info = DictationProviderInfo(
                    sttProvider: providerName,
                    sttModel: model,
                    llmCorrectionEnabled: llmEnabled ?? false
                )
            } else {
                info = nil
            }
            self = .ready(provider: info)
        case "dictation_result":
            let text = try container.decode(String.self, forKey: .text)
            let version = try container.decode(Int.self, forKey: .version)
            self = .result(text: text, version: version)
        case "dictation_final":
            let text = try container.decode(String.self, forKey: .text)
            let uncorrected = try container.decodeIfPresent(String.self, forKey: .uncorrected)
            let audioId = try container.decodeIfPresent(String.self, forKey: .audioId)
            self = .final_(text: text, uncorrected: uncorrected, audioId: audioId)
        case "dictation_error":
            let error = try container.decode(String.self, forKey: .error)
            let fatal = try container.decodeIfPresent(Bool.self, forKey: .fatal) ?? false
            self = .error(error: error, fatal: fatal)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown dictation message type: \(type)"
            )
        }
    }
}

// MARK: - DictationWebSocket

/// Manages a dedicated WebSocket connection to the server's `/dictation` endpoint.
/// Separate from the main `/stream` connection — binary audio frames plus JSON control messages.
///
/// The receive loop delivers all messages to the `messages` stream. A separate
/// `waitForReady()` method resolves when the server sends `dictation_ready`,
/// allowing callers to block until setup completes without consuming the stream.
@MainActor
final class DictationWebSocket {
    enum ConnectionState: Equatable, Sendable {
        case disconnected
        case connecting
        case connected
        case disconnecting
    }

    private(set) var state: ConnectionState = .disconnected

    /// Provider metadata received from the server's `dictation_ready` message.
    /// Available after `waitForReady()` resolves.
    private(set) var lastProviderInfo: DictationProviderInfo?

    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var urlSession: URLSession?
    private var trustDelegate: PinnedServerTrustDelegate?

    private var messageContinuation: AsyncThrowingStream<DictationServerMessage, Error>.Continuation?
    private var _messages: AsyncThrowingStream<DictationServerMessage, Error>?

    /// Continuation resolved when `dictation_ready` arrives. Separate from the
    /// message stream so `prepareSession` can wait for readiness without consuming
    /// the stream the session will iterate.
    private var readyContinuation: CheckedContinuation<Void, Error>?
    private var readyTimeoutTask: Task<Void, Never>?

    deinit {
        // Prevent CheckedContinuation leak — Swift crashes if a continuation
        // is dropped without being resumed.
        readyTimeoutTask?.cancel()
        if let cont = readyContinuation {
            readyContinuation = nil
            cont.resume(throwing: DictationWebSocketError.notConnected)
        }
        messageContinuation?.finish()
    }

    /// Receive stream — yields decoded server messages until disconnect.
    /// All messages (including `dictation_ready`) are buffered here. The session
    /// can ignore `.ready` when iterating.
    var messages: AsyncThrowingStream<DictationServerMessage, Error> {
        if let existing = _messages {
            return existing
        }
        let (stream, continuation) = AsyncThrowingStream.makeStream(of: DictationServerMessage.self)
        _messages = stream
        messageContinuation = continuation
        return stream
    }

    /// Open a WebSocket to `/dictation` using the provided server credentials.
    func connect(credentials: ServerCredentials) throws {
        guard state == .disconnected else {
            logger.warning("DictationWS connect called in state \(String(describing: self.state))")
            return
        }

        let wsScheme = credentials.resolvedScheme.websocketScheme
        guard let url = URL(string: "\(wsScheme)://\(credentials.host):\(credentials.port)/dictation") else {
            throw DictationWebSocketError.invalidURL
        }

        state = .connecting

        let delegate = PinnedServerTrustDelegate(
            pinnedLeafFingerprint: credentials.normalizedTLSCertFingerprint
        )
        self.trustDelegate = delegate

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        self.urlSession = session

        var request = URLRequest(url: url)
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")

        let wsTask = session.webSocketTask(with: request)
        self.task = wsTask

        // Ensure the messages stream exists before starting the receive loop
        _ = messages

        wsTask.resume()
        startReceiveLoop(wsTask)

        logger.info("DictationWS connecting to \(url.absoluteString, privacy: .public)")
    }

    /// Block until the server sends `dictation_ready`, or throw on timeout.
    ///
    /// This does NOT consume the message stream — the receive loop resolves
    /// a separate continuation. Messages are still buffered in `messages` for
    /// the session to iterate later.
    func waitForReady(timeout: Duration = .seconds(10)) async throws {
        if state == .connected { return }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            readyContinuation = continuation

            readyTimeoutTask = Task { [weak self] in
                try? await Task.sleep(for: timeout)
                guard let self, let cont = self.readyContinuation else { return }
                self.readyContinuation = nil
                cont.resume(throwing: VoiceInputError.remoteRequestTimedOut)
            }
        }
    }

    /// Send a JSON control message (text frame).
    func send(_ message: DictationClientMessage) async throws {
        guard let task, state == .connected || state == .connecting else {
            throw DictationWebSocketError.notConnected
        }
        let data = try JSONEncoder().encode(message)
        guard let jsonString = String(data: data, encoding: .utf8) else {
            throw DictationWebSocketError.encodingFailed
        }
        try await task.send(.string(jsonString))
    }

    /// Send raw PCM audio as a binary WebSocket frame.
    func sendAudio(_ data: Data) async throws {
        guard let task, state == .connected || state == .connecting else {
            throw DictationWebSocketError.notConnected
        }
        try await task.send(.data(data))
    }

    /// Gracefully disconnect.
    func disconnect() {
        guard state != .disconnected else { return }
        state = .disconnecting

        receiveTask?.cancel()
        receiveTask = nil

        readyTimeoutTask?.cancel()
        readyTimeoutTask = nil
        if let cont = readyContinuation {
            readyContinuation = nil
            cont.resume(throwing: DictationWebSocketError.notConnected)
        }

        task?.cancel(with: .normalClosure, reason: nil)
        task = nil

        messageContinuation?.finish()
        messageContinuation = nil
        _messages = nil

        urlSession?.invalidateAndCancel()
        urlSession = nil
        trustDelegate = nil

        state = .disconnected
        logger.info("DictationWS disconnected")
    }

    // MARK: - Private

    private func startReceiveLoop(_ ws: URLSessionWebSocketTask) {
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let wsMessage = try await ws.receive()
                    guard let self else { break }

                    let text: String
                    switch wsMessage {
                    case .string(let s):
                        text = s
                    case .data(let d):
                        guard let decoded = String(data: d, encoding: .utf8) else { continue }
                        text = decoded
                    @unknown default:
                        continue
                    }

                    guard let data = text.data(using: .utf8) else { continue }

                    do {
                        let serverMessage = try JSONDecoder().decode(DictationServerMessage.self, from: data)

                        // Transition to connected on dictation_ready
                        if case .ready(let provider) = serverMessage, self.state == .connecting {
                            self.state = .connected
                            self.lastProviderInfo = provider
                            self.readyTimeoutTask?.cancel()
                            self.readyTimeoutTask = nil
                            if let cont = self.readyContinuation {
                                self.readyContinuation = nil
                                cont.resume()
                            }
                        }

                        // Resolve ready continuation on fatal error too
                        if case .error(let error, let fatal) = serverMessage, fatal {
                            self.readyTimeoutTask?.cancel()
                            self.readyTimeoutTask = nil
                            if let cont = self.readyContinuation {
                                self.readyContinuation = nil
                                cont.resume(
                                    throwing: VoiceInputError.internalError("Server: \(error)")
                                )
                            }
                        }

                        // Always yield to the message stream
                        self.messageContinuation?.yield(serverMessage)
                    } catch {
                        logger.error("DictationWS decode error: \(error.localizedDescription, privacy: .public)")
                    }
                } catch {
                    if !Task.isCancelled {
                        logger.error("DictationWS receive error: \(error.localizedDescription, privacy: .public)")
                        await MainActor.run { [weak self] in
                            guard let self else { return }
                            self.readyTimeoutTask?.cancel()
                            self.readyTimeoutTask = nil
                            if let cont = self.readyContinuation {
                                self.readyContinuation = nil
                                cont.resume(throwing: error)
                            }
                            self.messageContinuation?.finish(throwing: error)
                            self.messageContinuation = nil
                            self._messages = nil
                            self.state = .disconnected
                        }
                    }
                    break
                }
            }
        }
    }
}

// MARK: - Errors

enum DictationWebSocketError: LocalizedError {
    case invalidURL
    case notConnected
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .invalidURL: "Invalid dictation WebSocket URL"
        case .notConnected: "Dictation WebSocket not connected"
        case .encodingFailed: "Failed to encode dictation message"
        }
    }
}
