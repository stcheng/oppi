import Foundation
import Testing
@testable import Oppi

@Suite("TypewriterAnimator")
@MainActor
struct TypewriterAnimatorTests {

    // MARK: - Basic Behavior

    @Test func initialStateIsEmpty() {
        let animator = TypewriterAnimator()
        #expect(animator.displayText.isEmpty)
        #expect(!animator.isAnimating)
    }

    @Test func firstUpdateStartsAnimation() {
        let animator = TypewriterAnimator()
        animator.update(fullText: "Hello world")
        #expect(animator.isAnimating)
        #expect(animator.displayText.isEmpty, "Delta is the full string, so display starts empty")
    }

    @Test func commitSnapsToTarget() {
        let animator = TypewriterAnimator()
        animator.update(fullText: "Hello world")
        #expect(animator.isAnimating)

        animator.commitCurrentAnimation()
        #expect(animator.displayText == "Hello world")
        #expect(!animator.isAnimating)
    }

    @Test func resetClearsEverything() {
        let animator = TypewriterAnimator()
        animator.update(fullText: "Hello world")
        animator.commitCurrentAnimation()

        animator.reset()
        #expect(animator.displayText.isEmpty)
        #expect(!animator.isAnimating)
    }

    // MARK: - Delta Computation

    @Test func secondUpdateAnimatesOnlyDelta() {
        let animator = TypewriterAnimator()

        // First update: "Hello"
        animator.update(fullText: "Hello")
        animator.commitCurrentAnimation()
        #expect(animator.displayText == "Hello")

        // Second update: "Hello world" — common prefix is "Hello", delta is " world"
        animator.update(fullText: "Hello world")
        #expect(animator.isAnimating)
        // Display should show the common prefix immediately
        #expect(animator.displayText == "Hello")

        animator.commitCurrentAnimation()
        #expect(animator.displayText == "Hello world")
    }

    @Test func shorterTextSnapsImmediately() {
        let animator = TypewriterAnimator()

        animator.update(fullText: "Hello world")
        animator.commitCurrentAnimation()

        // Correction: shorter text
        animator.update(fullText: "Hello")
        #expect(!animator.isAnimating, "Shorter text should snap, not animate")
        #expect(animator.displayText == "Hello")
    }

    @Test func identicalTextIsNoOp() {
        let animator = TypewriterAnimator()

        animator.update(fullText: "Hello")
        animator.commitCurrentAnimation()

        animator.update(fullText: "Hello")
        #expect(!animator.isAnimating)
        #expect(animator.displayText == "Hello")
    }

    @Test func newUpdateSnapsCurrentAnimation() {
        let animator = TypewriterAnimator()

        // Start first animation
        animator.update(fullText: "Hello")
        #expect(animator.isAnimating)

        // Second update arrives mid-animation — should snap first, start new
        animator.update(fullText: "Hello world")
        // After commit of first ("Hello") + start of new, display = "Hello" (common prefix)
        #expect(animator.displayText == "Hello")
        #expect(animator.isAnimating)

        animator.commitCurrentAnimation()
        #expect(animator.displayText == "Hello world")
    }

    // MARK: - Common Prefix

    @Test func commonPrefixCountEmptyStrings() {
        #expect(TypewriterAnimator.commonPrefixCount("", "") == 0)
        #expect(TypewriterAnimator.commonPrefixCount("abc", "") == 0)
        #expect(TypewriterAnimator.commonPrefixCount("", "abc") == 0)
    }

    @Test func commonPrefixCountPartialMatch() {
        #expect(TypewriterAnimator.commonPrefixCount("Hello", "Hello world") == 5)
        #expect(TypewriterAnimator.commonPrefixCount("Hello world", "Hello") == 5)
    }

    @Test func commonPrefixCountFullMatch() {
        #expect(TypewriterAnimator.commonPrefixCount("abc", "abc") == 3)
    }

    @Test func commonPrefixCountNoMatch() {
        #expect(TypewriterAnimator.commonPrefixCount("abc", "xyz") == 0)
    }

    @Test func commonPrefixCountUnicode() {
        // CJK characters
        #expect(TypewriterAnimator.commonPrefixCount("你好世界", "你好朋友") == 2)
        // Emoji
        #expect(TypewriterAnimator.commonPrefixCount("👋🌍", "👋🌎") == 1)
    }

    // MARK: - Animation Completion

    @Test func animationCompletesNaturally() async throws {
        let animator = TypewriterAnimator()

        // Short text = fast animation
        animator.update(fullText: "Hi")
        #expect(animator.isAnimating)

        // Wait for animation to complete (1.5s + buffer)
        try await Task.sleep(for: .seconds(2))

        #expect(!animator.isAnimating)
        #expect(animator.displayText == "Hi")
    }

    @Test func animationRevealsCharactersProgressively() async throws {
        let animator = TypewriterAnimator()

        animator.update(fullText: "ABCDE")

        // Wait a short time — should have revealed some but not all
        try await Task.sleep(for: .milliseconds(500))

        let partialLength = animator.displayText.count
        #expect(partialLength > 0, "Should have revealed at least one character")
        #expect(partialLength < 5, "Should not have revealed all characters yet")
        #expect(animator.isAnimating)

        // Wait for completion
        try await Task.sleep(for: .seconds(1.5))
        #expect(animator.displayText == "ABCDE")
    }

    @Test func rapidUpdatesConverge() async throws {
        let animator = TypewriterAnimator()

        // Simulate server updates arriving every 200ms
        animator.update(fullText: "The")
        try await Task.sleep(for: .milliseconds(200))
        animator.update(fullText: "The quick")
        try await Task.sleep(for: .milliseconds(200))
        animator.update(fullText: "The quick brown fox")

        // Commit — should have the latest
        animator.commitCurrentAnimation()
        #expect(animator.displayText == "The quick brown fox")
    }
}
