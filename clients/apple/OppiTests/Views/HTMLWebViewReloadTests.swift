import Testing
@testable import Oppi

@Suite("HTMLContentTracker")
@MainActor
struct HTMLWebViewReloadTests {

    // MARK: - Deferred loading (no window)

    @Test func defersLoadBeforeAttach() {
        let tracker = HTMLContentTracker()
        // Not attached to a window — should not load yet
        #expect(tracker.contentToLoad(for: "<h1>Hello</h1>") == nil)
    }

    @Test func loadsOnWindowAttach() {
        let tracker = HTMLContentTracker()
        _ = tracker.contentToLoad(for: "<h1>Hello</h1>")
        // Attaching to window should flush the pending content
        #expect(tracker.attach() == "<h1>Hello</h1>")
    }

    @Test func nothingPendingOnAttach() {
        let tracker = HTMLContentTracker()
        // Attach without any content request
        #expect(tracker.attach() == nil)
    }

    @Test func lastContentWinsBeforeAttach() {
        let tracker = HTMLContentTracker()
        _ = tracker.contentToLoad(for: "<h1>First</h1>")
        _ = tracker.contentToLoad(for: "<h1>Second</h1>")
        // Only the last content should be loaded on attach
        #expect(tracker.attach() == "<h1>Second</h1>")
    }

    // MARK: - Immediate loading (window attached)

    @Test func loadsImmediatelyWhenAttached() {
        let tracker = HTMLContentTracker()
        _ = tracker.attach()
        #expect(tracker.contentToLoad(for: "<h1>Hello</h1>") == "<h1>Hello</h1>")
    }

    @Test func sameContentDoesNotReload() {
        let tracker = HTMLContentTracker()
        _ = tracker.attach()
        _ = tracker.contentToLoad(for: "<h1>Hello</h1>")
        #expect(tracker.contentToLoad(for: "<h1>Hello</h1>") == nil)
    }

    @Test func differentContentTriggersReload() {
        let tracker = HTMLContentTracker()
        _ = tracker.attach()
        _ = tracker.contentToLoad(for: "<h1>Hello</h1>")
        #expect(tracker.contentToLoad(for: "<h1>World</h1>") == "<h1>World</h1>")
    }

    // MARK: - Process termination recovery

    @Test func processTerminationForcesReload() {
        let tracker = HTMLContentTracker()
        _ = tracker.attach()
        _ = tracker.contentToLoad(for: "<h1>Hello</h1>")

        tracker.markProcessTerminated()
        // Same content but process died — must reload
        #expect(tracker.contentToLoad(for: "<h1>Hello</h1>") == "<h1>Hello</h1>")
    }

    @Test func processTerminationClearsAfterReload() {
        let tracker = HTMLContentTracker()
        _ = tracker.attach()
        _ = tracker.contentToLoad(for: "<h1>Hello</h1>")

        tracker.markProcessTerminated()
        _ = tracker.contentToLoad(for: "<h1>Hello</h1>")
        // After reload, same content should not trigger again
        #expect(tracker.contentToLoad(for: "<h1>Hello</h1>") == nil)
    }

    // MARK: - Detach / reattach

    @Test func detachThenReattachReloads() {
        let tracker = HTMLContentTracker()
        _ = tracker.attach()
        _ = tracker.contentToLoad(for: "<h1>Hello</h1>")

        tracker.detach()
        // After detach, new content goes pending
        #expect(tracker.contentToLoad(for: "<h1>Hello</h1>") == nil)
        // Reattach flushes pending
        #expect(tracker.attach() == "<h1>Hello</h1>")
    }

    // MARK: - Empty content

    @Test func emptyContentStillTracked() {
        let tracker = HTMLContentTracker()
        _ = tracker.attach()
        #expect(tracker.contentToLoad(for: "") == "")
        #expect(tracker.contentToLoad(for: "") == nil)
        #expect(tracker.contentToLoad(for: "<p>Content</p>") == "<p>Content</p>")
    }
}
