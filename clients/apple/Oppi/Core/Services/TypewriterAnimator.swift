import Foundation
import OSLog

private let logger = Logger(subsystem: AppIdentifiers.subsystem, category: "Typewriter")

/// Animates text appearing character-by-character when the server sends
/// full-replacement transcript updates during dictation.
///
/// Server dictation sends the entire transcript every ~2s. Without animation,
/// each update causes a jarring text jump. This class computes the delta
/// (new characters appended since the last update) and reveals them gradually
/// over ~1.5s, leaving a 0.5s buffer before the next server update.
///
/// If a new update arrives mid-animation, the current animation snaps to
/// completion and a new animation starts for the fresh delta.
///
/// Only used for server dictation (`.replaceFinalTranscript` events).
/// On-device dictation already streams partial results natively.
@MainActor @Observable
final class TypewriterAnimator {

    // MARK: - Observable State

    /// Text currently visible to the user. May trail `targetText` during animation.
    private(set) var displayText = ""

    /// Whether a character-reveal animation is in progress.
    private(set) var isAnimating = false

    // MARK: - Internal State

    /// The full text that the current animation is revealing toward.
    private var targetText = ""

    /// The async task driving the character reveal loop.
    private var animationTask: Task<Void, Never>?

    // MARK: - Animation duration

    /// Total time to reveal the delta characters (nanoseconds).
    /// 1.5s leaves a 0.5s buffer before the next ~2s server update.
    static let animationDurationNs: UInt64 = 1_500_000_000

    /// Minimum interval between character reveals to avoid sub-frame flicker.
    static let minimumIntervalNs: UInt64 = 8_000_000 // ~8ms, roughly one frame at 120Hz

    // MARK: - Public API

    /// Feed a new full replacement transcript from the server.
    ///
    /// Computes the delta from the previous target and animates new characters.
    /// Corrections (batch retranscription, punctuation changes) snap instantly.
    /// Only genuinely new characters appended to the end get animated.
    ///
    /// Period-merge: if the only removed characters are trailing punctuation
    /// (.!?。！？) and there’s new text after, treat it as a pure append.
    /// The ASR commonly outputs "word." then corrects to "word more text."
    func update(fullText: String) {
        // Snap any in-progress animation to its target
        commitCurrentAnimation()

        let previousTarget = targetText
        targetText = fullText

        // Find how many leading characters are shared
        let commonCount = Self.commonPrefixCount(previousTarget, fullText)

        // Detect if the removal is just trailing punctuation (period-merge).
        // The ASR frequently outputs speculative periods that get removed
        // when more speech arrives — this is not a real correction.
        let removedCount = previousTarget.count - commonCount
        let isTrailingPunctOnly = removedCount > 0
            && fullText.count > previousTarget.count
            && Self.isOnlyTrailingPunctuation(previousTarget, from: commonCount)
        let isCorrection = removedCount > 0 && !isTrailingPunctOnly

        if isCorrection {
            // Real correction: snap the corrected portion immediately,
            // only animate chars beyond the old target length.
            let snapTo = min(previousTarget.count, fullText.count)
            let snapEnd = fullText.index(fullText.startIndex, offsetBy: snapTo)
            displayText = String(fullText[..<snapEnd])

            // If no new chars beyond old length, we're done
            guard fullText.count > previousTarget.count else { return }
        } else {
            // Pure append (or period-merge) — show common prefix, animate the delta
            let prefixEnd = fullText.index(fullText.startIndex, offsetBy: commonCount)
            displayText = String(fullText[..<prefixEnd])
        }

        // Nothing new to animate?
        guard fullText.count > displayText.count else {
            displayText = fullText
            return
        }

        let animateFrom = fullText.index(fullText.startIndex, offsetBy: displayText.count)
        let deltaCount = fullText.count - displayText.count
        let intervalNs = max(
            Self.minimumIntervalNs,
            Self.animationDurationNs / UInt64(max(1, deltaCount))
        )

        isAnimating = true

        animationTask = Task { [weak self] in
            var currentIndex = animateFrom
            let target = fullText

            while currentIndex < target.endIndex {
                do {
                    try await Task.sleep(nanoseconds: intervalNs)
                } catch {
                    break
                }
                guard !Task.isCancelled else { break }
                guard let self else { break }

                currentIndex = target.index(after: currentIndex)
                self.displayText = String(target[..<currentIndex])
            }

            guard let self else { return }
            if !Task.isCancelled {
                self.isAnimating = false
            }
        }

        logger.debug("Typewriter: animating \(deltaCount) chars over \(deltaCount * Int(intervalNs / 1_000_000))ms")
    }

    /// Immediately finish any in-progress animation, snapping to the target text.
    /// Call when stopping recording or transitioning away from the recording state.
    func commitCurrentAnimation() {
        animationTask?.cancel()
        animationTask = nil
        displayText = targetText
        isAnimating = false
    }

    /// Full reset — clears all state. Call on session teardown or cancel.
    func reset() {
        animationTask?.cancel()
        animationTask = nil
        targetText = ""
        displayText = ""
        isAnimating = false
    }

    // MARK: - Helpers

    private static let trailingPunctuation: Set<Character> = [".", "!", "?", "\u{3002}", "\u{FF01}", "\u{FF1F}"]

    /// Check if all characters from `fromIndex` to the end are trailing punctuation.
    private static func isOnlyTrailingPunctuation(_ text: String, from offset: Int) -> Bool {
        var idx = text.index(text.startIndex, offsetBy: offset)
        while idx < text.endIndex {
            let ch = text[idx]
            if !ch.isWhitespace && !trailingPunctuation.contains(ch) {
                return false
            }
            idx = text.index(after: idx)
        }
        return true
    }

    /// Count of shared leading characters between two strings.
    static func commonPrefixCount(_ a: String, _ b: String) -> Int {
        var count = 0
        var ai = a.startIndex
        var bi = b.startIndex
        while ai < a.endIndex, bi < b.endIndex, a[ai] == b[bi] {
            count += 1
            ai = a.index(after: ai)
            bi = b.index(after: bi)
        }
        return count
    }
}
