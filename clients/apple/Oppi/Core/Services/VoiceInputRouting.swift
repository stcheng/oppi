import Foundation

@MainActor
final class VoiceInputRouteResolver {

    func resolveEngine(
        mode: VoiceInputManager.EngineMode,
        fallback: VoiceInputManager.TranscriptionEngine,
        serverCredentials: ServerCredentials? = nil,
        asrAvailable: Bool = false
    ) async -> VoiceInputManager.TranscriptionEngine {
        switch mode {
        case .onDevice:
            return fallback
        case .remote:
            // Only route to server if ASR is actually configured.
            // Otherwise fall back to on-device so the user isn't stuck.
            return asrAvailable ? .serverDictation : fallback
        case .auto:
            if serverCredentials != nil, asrAvailable {
                return .serverDictation
            }
            return fallback
        }
    }
}
