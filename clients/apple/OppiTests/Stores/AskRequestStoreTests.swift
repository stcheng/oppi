import Foundation
import Testing
@testable import Oppi

@Suite("AskRequestStore")
@MainActor
struct AskRequestStoreTests {

    // MARK: - Basic operations

    @Test func initiallyEmpty() {
        let store = AskRequestStore()
        #expect(store.pending.isEmpty)
        #expect(store.count == 0)
    }

    @Test func setAndRetrieveAskRequest() {
        let store = AskRequestStore()
        let ask = AskRequest(
            id: "ask-1",
            sessionId: "s1",
            questions: [AskQuestion(id: "q1", question: "Which color?", options: [
                AskOption(value: "red", label: "Red"),
            ], multiSelect: false)],
            allowCustom: true,
            timeout: nil
        )
        store.set(ask, for: "s1")
        #expect(store.count == 1)
        #expect(store.pending(for: "s1") != nil)
        #expect(store.pending(for: "s1")?.id == "ask-1")
    }

    @Test func removeAskRequest() {
        let store = AskRequestStore()
        let ask = AskRequest(
            id: "ask-1",
            sessionId: "s1",
            questions: [],
            allowCustom: true,
            timeout: nil
        )
        store.set(ask, for: "s1")
        store.remove(for: "s1")
        #expect(store.pending(for: "s1") == nil)
        #expect(store.count == 0)
    }

    @Test func pendingReturnsNilForUnknownSession() {
        let store = AskRequestStore()
        #expect(store.pending(for: "unknown") == nil)
    }

    @Test func hasPendingAskForSession() {
        let store = AskRequestStore()
        let ask = AskRequest(
            id: "ask-1",
            sessionId: "s1",
            questions: [],
            allowCustom: true,
            timeout: nil
        )
        store.set(ask, for: "s1")
        #expect(store.hasPending(for: "s1"))
        #expect(!store.hasPending(for: "s2"))
    }

    @Test func multipleSessionsTrackedIndependently() {
        let store = AskRequestStore()
        let ask1 = AskRequest(id: "ask-1", sessionId: "s1", questions: [], allowCustom: true, timeout: nil)
        let ask2 = AskRequest(id: "ask-2", sessionId: "s2", questions: [], allowCustom: true, timeout: nil)
        store.set(ask1, for: "s1")
        store.set(ask2, for: "s2")
        #expect(store.count == 2)
        store.remove(for: "s1")
        #expect(store.count == 1)
        #expect(store.hasPending(for: "s2"))
    }

    // MARK: - Server switching

    @Test func switchServerClearsAndIsolates() {
        let store = AskRequestStore()
        store.switchServer(to: "server-a")
        let ask = AskRequest(id: "ask-1", sessionId: "s1", questions: [], allowCustom: true, timeout: nil)
        store.set(ask, for: "s1")
        #expect(store.count == 1)

        store.switchServer(to: "server-b")
        #expect(store.count == 0)
        #expect(!store.hasPending(for: "s1"))
    }

    @Test func removeServerCleansUp() {
        let store = AskRequestStore()
        store.switchServer(to: "server-a")
        let ask = AskRequest(id: "ask-1", sessionId: "s1", questions: [], allowCustom: true, timeout: nil)
        store.set(ask, for: "s1")
        store.removeServer("server-a")
        #expect(store.count == 0)
    }
}
