import { describe, expect, it } from "vitest";
import {
  SessionEventProcessor,
  type PendingAskState,
  type EventProcessorSessionState,
} from "./session-events.js";
import type { Session } from "./types.js";

function makeSession(id = "sess-1"): Session {
  return {
    id,
    status: "ready",
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  };
}

function createResolveHarness(): {
  processor: SessionEventProcessor;
  responses: Array<{ id: string; value?: string; cancelled?: boolean }>;
} {
  const responses: Array<{ id: string; value?: string; cancelled?: boolean }> = [];

  const processor = new SessionEventProcessor({
    storage: {} as never,
    mobileRenderers: {} as never,
    broadcast: () => {},
    persistSessionNow: () => {},
    markSessionDirty: () => {},
    respondToUIRequest: (_key, response) => {
      responses.push({ id: response.id, value: response.value, cancelled: response.cancelled });
      return true;
    },
  });

  return { processor, responses };
}

function makeActive(
  pendingAsk: PendingAskState,
): Pick<EventProcessorSessionState, "pendingAsk" | "session"> {
  return { session: makeSession(), pendingAsk };
}

function makePendingAsk(
  questions: PendingAskState["questions"],
  deferred: PendingAskState["deferred"],
): PendingAskState {
  return {
    requestId: "ask-1",
    questions,
    deferred,
    broadcastMessage: { type: "extension_ui_request" } as never,
    initiatedAt: Date.now(),
  };
}

describe("resolveAskDeferred", () => {
  it("resolves single-select answer as single label via select", () => {
    const { processor, responses } = createResolveHarness();

    const ask = makePendingAsk(
      [{ id: "color", question: "Pick a color" }],
      [
        {
          id: "sel-1",
          req: {
            type: "extension_ui_request",
            id: "sel-1",
            method: "select",
            options: ["Red", "Blue", "Green"],
          },
        },
      ],
    );

    processor.resolveAskDeferred("key", makeActive(ask), { color: "blue" }, false);

    expect(responses).toHaveLength(1);
    expect(responses[0].value).toBe("Blue");
    expect(responses[0].cancelled).toBeUndefined();
  });

  it("resolves multi-select answer with ALL values, not just the first", () => {
    const { processor, responses } = createResolveHarness();

    const ask = makePendingAsk(
      [{ id: "tools", question: "Which tools?", multiSelect: true }],
      [
        {
          id: "sel-1",
          req: {
            type: "extension_ui_request",
            id: "sel-1",
            method: "select",
            options: ["Ruff", "Mypy", "Pylint"],
          },
        },
      ],
    );

    // iOS sends array of values for multi-select
    processor.resolveAskDeferred("key", makeActive(ask), { tools: ["ruff", "mypy"] }, false);

    expect(responses).toHaveLength(1);
    // Should contain JSON array with ALL matched labels, not just the first
    const parsed = JSON.parse(responses[0].value!);
    expect(parsed).toEqual(expect.arrayContaining(["Ruff", "Mypy"]));
    expect(parsed).toHaveLength(2);
  });

  it("multi-select with single value in array still works", () => {
    const { processor, responses } = createResolveHarness();

    const ask = makePendingAsk(
      [{ id: "tools", question: "Which tools?", multiSelect: true }],
      [
        {
          id: "sel-1",
          req: {
            type: "extension_ui_request",
            id: "sel-1",
            method: "select",
            options: ["Ruff", "Mypy"],
          },
        },
      ],
    );

    processor.resolveAskDeferred("key", makeActive(ask), { tools: ["ruff"] }, false);

    expect(responses).toHaveLength(1);
    const parsed = JSON.parse(responses[0].value!);
    expect(parsed).toEqual(["Ruff"]);
  });

  it("handles mixed single-select and multi-select questions", () => {
    const { processor, responses } = createResolveHarness();

    const ask = makePendingAsk(
      [
        { id: "approach", question: "Testing approach?" },
        { id: "frameworks", question: "Which frameworks?", multiSelect: true },
      ],
      [
        {
          id: "sel-1",
          req: {
            type: "extension_ui_request",
            id: "sel-1",
            method: "select",
            options: ["Unit tests", "Integration tests"],
          },
        },
        {
          id: "sel-2",
          req: {
            type: "extension_ui_request",
            id: "sel-2",
            method: "select",
            options: ["Jest", "Vitest", "Playwright"],
          },
        },
      ],
    );

    processor.resolveAskDeferred(
      "key",
      makeActive(ask),
      { approach: "unit tests", frameworks: ["jest", "vitest"] },
      false,
    );

    expect(responses).toHaveLength(2);
    // Single-select: plain label
    expect(responses[0].value).toBe("Unit tests");
    // Multi-select: JSON array of labels
    const parsed = JSON.parse(responses[1].value!);
    expect(parsed).toEqual(expect.arrayContaining(["Jest", "Vitest"]));
    expect(parsed).toHaveLength(2);
  });

  it("cancelled answers cancel all deferred requests", () => {
    const { processor, responses } = createResolveHarness();

    const ask = makePendingAsk(
      [{ id: "tools", question: "Which tools?", multiSelect: true }],
      [
        {
          id: "sel-1",
          req: { type: "extension_ui_request", id: "sel-1", method: "select", options: ["Ruff"] },
        },
      ],
    );

    processor.resolveAskDeferred("key", makeActive(ask), {}, true);

    expect(responses).toHaveLength(1);
    expect(responses[0].cancelled).toBe(true);
  });

  it("ignored multi-select question cancels deferred request", () => {
    const { processor, responses } = createResolveHarness();

    const ask = makePendingAsk(
      [{ id: "tools", question: "Which tools?", multiSelect: true }],
      [
        {
          id: "sel-1",
          req: { type: "extension_ui_request", id: "sel-1", method: "select", options: ["Ruff"] },
        },
      ],
    );

    // No answer for "tools" — ignored
    processor.resolveAskDeferred("key", makeActive(ask), {}, false);

    expect(responses).toHaveLength(1);
    expect(responses[0].cancelled).toBe(true);
  });

  it("clears pendingAsk after resolution", () => {
    const { processor } = createResolveHarness();

    const ask = makePendingAsk(
      [{ id: "q", question: "Q?" }],
      [
        {
          id: "sel-1",
          req: { type: "extension_ui_request", id: "sel-1", method: "select", options: ["A"] },
        },
      ],
    );
    const active = makeActive(ask);

    processor.resolveAskDeferred("key", active, { q: "a" }, false);
    expect(active.pendingAsk).toBeUndefined();
  });
});
