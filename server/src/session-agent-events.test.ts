import { describe, expect, it, vi } from "vitest";
import type { SessionBackendEvent } from "./pi-events.js";
import { SessionAgentEventCoordinator } from "./session-agent-events.js";
import { TurnDedupeCache } from "./turn-cache.js";
import type { Session } from "./types.js";

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: "child-1",
    status: "busy",
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    ...overrides,
  };
}

describe("SessionAgentEventCoordinator", () => {
  it("mirrors child ready state updates to the parent session key", () => {
    const active = {
      session: makeSession({ parentSessionId: "parent-1", status: "busy" }),
      pendingUIRequests: new Map(),
      partialResults: new Map(),
      streamedAssistantText: "",
      hasStreamedThinking: false,
      toolNames: new Map(),
      shellPreviewLastSent: new Map(),
      streamingArgPreviews: new Set<string>(),
      turnCache: new TurnDedupeCache(),
      pendingTurnStarts: [],
      sdkBackend: {} as never,
      subscribers: new Set<(msg: unknown) => void>(),
      toolFullOutputPaths: new Map<string, string>(),
    };

    const broadcast = vi.fn();
    const coordinator = new SessionAgentEventCoordinator({
      getActiveSession: vi.fn(() => active),
      eventProcessor: {
        translationContext: vi.fn(() => ({
          sessionId: active.session.id,
          partialResults: active.partialResults,
          streamedAssistantText: active.streamedAssistantText,
          hasStreamedThinking: active.hasStreamedThinking,
          mobileRenderers: {} as never,
          toolNames: active.toolNames,
          shellPreviewLastSent: active.shellPreviewLastSent,
          streamingArgPreviews: active.streamingArgPreviews,
        })),
        updateSessionFromEvent: vi.fn(() => {
          active.session.status = "ready";
        }),
        handleExtensionUIRequest: vi.fn(),
      } as never,
      stopCoordinator: {
        finishPendingStopOnAgentEnd: vi.fn(),
      } as never,
      turnCoordinator: {
        markNextTurnStarted: vi.fn(),
      } as never,
      broadcast,
      resetIdleTimer: vi.fn(),
    });

    coordinator.handlePiEvent(active.session.id, {
      type: "agent_end",
      messages: [],
    } as unknown as SessionBackendEvent);

    const stateBroadcasts = broadcast.mock.calls.filter(([, message]) => message.type === "state");
    expect(stateBroadcasts).toHaveLength(2);
    expect(stateBroadcasts).toEqual([
      ["child-1", { type: "state", session: active.session }],
      ["parent-1", { type: "state", session: active.session }],
    ]);
  });
});
