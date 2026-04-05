import Foundation

@MainActor
final class VoiceInputRouteResolver {

    func resolveEngine(
        mode: VoiceInputManager.EngineMode,
        fallback: VoiceInputManager.TranscriptionEngine,
        serverCredentials: ServerCredentials? = nil
    ) async -> VoiceInputManager.TranscriptionEngine {
        switch mode {
        case .onDevice:
            return fallback
        case .remote:
            return .serverDictation
        case .auto:
            if serverCredentials != nil {
                return .serverDictation
            }
            return fallback
        }
    }
}
