import Foundation
import Testing
import UIKit
@testable import Oppi

@Suite("Session timeline navigation")
@MainActor
struct SessionTimelineNavigationTests {
    @Test func detachedNavigationExpandsHistoryAndLandsOnSelectedAssistantMessage() async throws {
        let result = await navigateFromDetachedTail(to: "msg-20")
        #expect(
            result.reachedTarget,
            "Expected timeline navigation to land on msg-20; top=\(result.topVisible), visible=\(result.visibleIDs)"
        )
        #expect(result.didHighlightTarget, "Expected assistant target row to flash after navigation")
        #expect(result.highlightOverlayFrontmost, "Expected assistant highlight overlay to render above row content")
    }

    @Test func detachedNavigationExpandsHistoryAndLandsOnSelectedToolRow() async throws {
        let result = await navigateFromDetachedTail(to: "tool-21")
        #expect(
            result.reachedTarget,
            "Expected timeline navigation to land on tool-21; top=\(result.topVisible), visible=\(result.visibleIDs)"
        )
        #expect(result.didHighlightTarget, "Expected tool target row to flash after navigation")
        #expect(result.highlightOverlayFrontmost, "Expected tool highlight overlay to render above row content")
    }
}

private struct NavigationResult {
    let reachedTarget: Bool
    let didHighlightTarget: Bool
    let highlightOverlayFrontmost: Bool
    let topVisible: String
    let visibleIDs: [String]
}

@MainActor
private func navigateFromDetachedTail(to targetID: String) async -> NavigationResult {
    let harness = makeWindowedTimelineHarness(
        sessionId: "session-outline-navigation-\(targetID)",
        useAnchoredCollectionView: true
    )
    let allItems = makeMixedTimelineItems(count: 120)
    let visibleTail = Array(allItems.suffix(40))

    applyTimelineItems(
        visibleTail,
        hiddenCount: allItems.count - visibleTail.count,
        nonce: nil,
        to: harness
    )

    harness.collectionView.scrollToItem(at: IndexPath(item: 15, section: 0), at: .top, animated: false)
    settleTimelineLayout(harness.collectionView, passes: 2)
    harness.coordinator.updateScrollState(harness.collectionView)
    harness.scrollController.detachFromBottomForUserScroll()

    harness.scrollController.requestNavigationHighlight(for: targetID)
    applyTimelineItems(
        allItems,
        hiddenCount: 0,
        nonce: 2,
        scrollTargetID: targetID,
        to: harness
    )

    let reachedTarget = await waitForTimelineCondition(timeoutMs: 500) {
        await MainActor.run {
            settleTimelineLayout(harness.collectionView, passes: 3)
            harness.coordinator.updateScrollState(harness.collectionView)
            return harness.scrollController.currentTopVisibleItemId == targetID
        }
    }

    let didHighlightTarget = await waitForTimelineCondition(timeoutMs: 400) {
        await MainActor.run {
            guard let highlightedCell = timelineCell(for: targetID, in: harness) else { return false }
            return highlightedCell.isShowingNavigationHighlightForTesting
        }
    }

    let highlightOverlayFrontmost = await MainActor.run {
        timelineCell(for: targetID, in: harness)?.isNavigationHighlightOverlayFrontmostForTesting ?? false
    }

    return NavigationResult(
        reachedTarget: reachedTarget,
        didHighlightTarget: didHighlightTarget,
        highlightOverlayFrontmost: highlightOverlayFrontmost,
        topVisible: harness.scrollController.currentTopVisibleItemId ?? "nil",
        visibleIDs: visibleTimelineIDs(in: harness)
    )
}

@MainActor
private func applyTimelineItems(
    _ items: [ChatItem],
    hiddenCount: Int,
    nonce: Int?,
    scrollTargetID: String? = nil,
    to harness: WindowedTimelineHarness
) {
    let scrollCommand: ChatTimelineScrollCommand? = if let nonce, let scrollTargetID {
        ChatTimelineScrollCommand(
            id: scrollTargetID,
            anchor: .top,
            animated: false,
            nonce: nonce
        )
    } else {
        nil
    }

    let config = makeTimelineConfiguration(
        items: items,
        hiddenCount: hiddenCount,
        isBusy: false,
        scrollCommand: scrollCommand,
        sessionId: harness.sessionId,
        reducer: harness.reducer,
        toolOutputStore: harness.toolOutputStore,
        toolArgsStore: harness.toolArgsStore,
        toolSegmentStore: harness.toolSegmentStore,
        connection: harness.connection,
        scrollController: harness.scrollController,
        audioPlayer: harness.audioPlayer
    )
    harness.coordinator.apply(configuration: config, to: harness.collectionView)
    settleTimelineLayout(harness.collectionView, passes: 2)
}

private func makeMixedTimelineItems(count: Int) -> [ChatItem] {
    (0..<count).map { index in
        if index.isMultiple(of: 2) {
            let text = Array(repeating: "Message \(index) line with enough text to wrap across the cell.", count: 4)
                .joined(separator: "\n")
            return .assistantMessage(
                id: "msg-\(index)",
                text: text,
                timestamp: Date(timeIntervalSince1970: TimeInterval(index))
            )
        }

        let output = Array(repeating: "output \(index)", count: 6).joined(separator: "\n")
        return .toolCall(
            id: "tool-\(index)",
            tool: "bash",
            argsSummary: "printf 'row \(index)'",
            outputPreview: output,
            outputByteCount: output.utf8.count,
            isError: false,
            isDone: true
        )
    }
}

@MainActor
private func visibleTimelineIDs(in harness: WindowedTimelineHarness) -> [String] {
    harness.collectionView.indexPathsForVisibleItems
        .sorted { $0.item < $1.item }
        .compactMap { indexPath in
            guard indexPath.item < harness.coordinator.currentIDs.count else { return nil }
            return harness.coordinator.currentIDs[indexPath.item]
        }
}

@MainActor
private func timelineCell(for itemID: String, in harness: WindowedTimelineHarness) -> SafeSizingCell? {
    guard let index = harness.coordinator.currentIDs.firstIndex(of: itemID) else { return nil }
    return harness.collectionView.cellForItem(at: IndexPath(item: index, section: 0)) as? SafeSizingCell
}
