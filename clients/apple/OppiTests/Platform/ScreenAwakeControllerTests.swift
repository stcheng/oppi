@testable import Oppi
import Foundation
import Testing

@Suite("ScreenAwakeController", .serialized)
@MainActor
struct ScreenAwakeControllerTests {

    @Test("active session immediately prevents sleep")
    func activeSessionDisablesIdleTimer() {
        var idleTimerUpdates: [Bool] = []

        let controller = ScreenAwakeController(
            timeoutProvider: { .seconds(2) },
            idleTimerSetter: { idleTimerUpdates.append($0) },
            sleepFunction: { _ in }
        )

        controller.setSessionActivity(true, sessionId: "s1")

        #expect(controller.isPreventingSleep)
        #expect(idleTimerUpdates.last == true)
    }

    @Test("idle timeout releases prevention after activity ends")
    func releasesAfterTimeout() async {
        var idleTimerUpdates: [Bool] = []

        let controller = ScreenAwakeController(
            timeoutProvider: { .milliseconds(40) },
            idleTimerSetter: { idleTimerUpdates.append($0) }
        )

        controller.setSessionActivity(true, sessionId: "s1")
        controller.setSessionActivity(false, sessionId: "s1")

        let released = await waitForTestCondition(timeout: .milliseconds(300), poll: .milliseconds(10)) {
            await MainActor.run { !controller.isPreventingSleep }
        }

        #expect(released)
        #expect(idleTimerUpdates.contains(true))
        #expect(idleTimerUpdates.last == false)
    }

    @Test("off timeout releases immediately when activity stops")
    func offTimeoutReleasesImmediately() {
        var idleTimerUpdates: [Bool] = []

        let controller = ScreenAwakeController(
            timeoutProvider: { nil },
            idleTimerSetter: { idleTimerUpdates.append($0) }
        )

        controller.setSessionActivity(true, sessionId: "s1")
        controller.setSessionActivity(false, sessionId: "s1")

        #expect(!controller.isPreventingSleep)
        #expect(idleTimerUpdates == [true, false])
    }
}
