import { describe, expect, it } from "vitest";

import { createAskFactory } from "./ask.js";

type TurnStartHandler = () => Promise<void> | void;

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: {
      questions: Array<{
        id: string;
        question: string;
        options: Array<{ value: string; label: string }>;
        multiSelect?: boolean;
      }>;
      allowCustom?: boolean;
    },
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: {
      hasUI: boolean;
      ui: {
        custom: (...args: unknown[]) => Promise<unknown>;
        select: (question: string, options: string[]) => Promise<string | undefined>;
      };
    },
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

function createMockAPI(): {
  tools: Map<string, RegisteredTool>;
  on(event: string, handler: TurnStartHandler): void;
  registerTool(tool: RegisteredTool): void;
  resetTurn(): Promise<void>;
} {
  const tools = new Map<string, RegisteredTool>();
  let turnStart: TurnStartHandler | undefined;

  return {
    tools,
    on(event: string, handler: TurnStartHandler) {
      if (event === "turn_start") {
        turnStart = handler;
      }
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    async resetTurn() {
      await turnStart?.();
    },
  };
}

describe("createAskFactory", () => {
  it("registers the ask tool", () => {
    const api = createMockAPI();
    createAskFactory()(api as never);
    expect(api.tools.has("ask")).toBe(true);
  });

  it("enforces one ask call per turn and resets on turn_start", async () => {
    const api = createMockAPI();
    createAskFactory()(api as never);
    const tool = api.tools.get("ask");
    expect(tool).toBeDefined();

    const ctx = {
      hasUI: false,
      ui: {
        custom: async () => undefined,
        select: async () => undefined,
      },
    };

    const params = {
      questions: [
        {
          id: "scope",
          question: "Which scope?",
          options: [
            { value: "small", label: "Small" },
            { value: "large", label: "Large" },
          ],
        },
      ],
    };

    const first = await tool!.execute("tc-1", params, undefined, undefined, ctx);
    expect(first.content[0]?.text).toContain("Defaults");

    await expect(tool!.execute("tc-2", params, undefined, undefined, ctx)).rejects.toThrow(
      /Only one ask call per turn/,
    );

    await api.resetTurn();
    const second = await tool!.execute("tc-3", params, undefined, undefined, ctx);
    expect(second.content[0]?.text).toContain("Defaults");
  });
});
