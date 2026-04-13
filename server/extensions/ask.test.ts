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
  renderCall?: (
    args: Record<string, unknown>,
    theme: { fg: (token: string, text: string) => string; bold: (text: string) => string },
  ) => { render: (width: number) => string[] };
  renderResult?: (
    result: { details?: unknown },
    options: unknown,
    theme: { fg: (token: string, text: string) => string; bold: (text: string) => string },
  ) => { render: (width: number) => string[] };
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

  it("returns all selected values for multi-select questions", async () => {
    const api = createMockAPI();
    createAskFactory()(api as never);
    const tool = api.tools.get("ask")!;

    // Simulate server returning JSON-encoded array of labels for multi-select
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        select: async (_question: string, _options: string[]) => {
          // Server resolves multi-select as JSON array of labels
          return JSON.stringify(["Ruff", "Mypy"]);
        },
      },
    };

    const params = {
      questions: [
        {
          id: "tools",
          question: "Which linting tools?",
          options: [
            { value: "ruff", label: "Ruff" },
            { value: "mypy", label: "Mypy" },
            { value: "pylint", label: "Pylint" },
          ],
          multiSelect: true,
        },
      ],
    };

    const result = await tool.execute("tc-multi", params, undefined, undefined, ctx);
    const details = result.details as { answers: Record<string, string | string[]> };
    expect(details.answers["tools"]).toEqual(["ruff", "mypy"]);
    expect(result.content[0]?.text).toContain("ruff");
    expect(result.content[0]?.text).toContain("mypy");
  });

  it("handles single-select alongside multi-select questions", async () => {
    const api = createMockAPI();
    createAskFactory()(api as never);
    const tool = api.tools.get("ask")!;

    let callIndex = 0;
    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        select: async (_question: string, _options: string[]) => {
          callIndex++;
          if (callIndex === 1) {
            // First question: single-select returns plain label
            return "Unit tests";
          } else {
            // Second question: multi-select returns JSON array of labels
            return JSON.stringify(["Jest", "Vitest"]);
          }
        },
      },
    };

    const params = {
      questions: [
        {
          id: "approach",
          question: "Testing approach?",
          options: [
            { value: "unit", label: "Unit tests" },
            { value: "integration", label: "Integration tests" },
          ],
        },
        {
          id: "frameworks",
          question: "Which frameworks?",
          options: [
            { value: "jest", label: "Jest" },
            { value: "vitest", label: "Vitest" },
            { value: "playwright", label: "Playwright" },
          ],
          multiSelect: true,
        },
      ],
    };

    const result = await tool.execute("tc-mixed", params, undefined, undefined, ctx);
    const details = result.details as { answers: Record<string, string | string[]> };
    expect(details.answers["approach"]).toBe("unit");
    expect(details.answers["frameworks"]).toEqual(["jest", "vitest"]);
  });

  it("falls back to single value array when select returns non-JSON for multi-select", async () => {
    const api = createMockAPI();
    createAskFactory()(api as never);
    const tool = api.tools.get("ask")!;

    const ctx = {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        select: async () => "Ruff", // plain string, not JSON
      },
    };

    const params = {
      questions: [
        {
          id: "tools",
          question: "Which tools?",
          options: [
            { value: "ruff", label: "Ruff" },
            { value: "mypy", label: "Mypy" },
          ],
          multiSelect: true,
        },
      ],
    };

    const result = await tool.execute("tc-fallback", params, undefined, undefined, ctx);
    const details = result.details as { answers: Record<string, string | string[]> };
    // Falls back to wrapping single value in array
    expect(details.answers["tools"]).toEqual(["ruff"]);
  });

  it("renders human-friendly question modes and answer labels in the TUI", () => {
    const api = createMockAPI();
    createAskFactory()(api as never);
    const tool = api.tools.get("ask")!;
    const theme = {
      fg: (_token: string, text: string) => text,
      bold: (text: string) => text,
    };

    const callText = tool
      .renderCall?.(
        {
          questions: [
            {
              id: "ups_rule",
              question: "How should I handle UPS mail?",
              options: [
                { value: "ups_split_recommended", label: "Split recommended" },
                { value: "ups_archive_all", label: "Archive all" },
              ],
            },
            {
              id: "mail_tags",
              question: "Which tags should I apply?",
              options: [
                { value: "bills", label: "Bills" },
                { value: "receipts", label: "Receipts" },
              ],
              multiSelect: true,
            },
          ],
          allowCustom: true,
        },
        theme,
      )
      .render(160)
      .join("\n");

    expect(callText).toContain("single-select + custom");
    expect(callText).toContain("multi-select + custom");
    expect(callText).toContain("Split recommended · Archive all");

    const resultText = tool
      .renderResult?.(
        {
          details: {
            questions: [
              {
                id: "ups_rule",
                question: "How should I handle UPS mail?",
                options: [
                  { value: "ups_split_recommended", label: "Split recommended" },
                  { value: "ups_archive_all", label: "Archive all" },
                ],
              },
              {
                id: "mail_tags",
                question: "Which tags should I apply?",
                options: [
                  { value: "bills", label: "Bills" },
                  { value: "receipts", label: "Receipts" },
                ],
                multiSelect: true,
              },
              {
                id: "notes",
                question: "Anything else?",
                options: [{ value: "none", label: "Nothing else" }],
              },
            ],
            answers: {
              ups_rule: "ups_split_recommended",
              mail_tags: ["bills", "receipts"],
              notes: "Keep tax paperwork only",
            },
          },
        },
        undefined,
        theme,
      )
      .render(160)
      .join("\n");

    expect(resultText).toContain("Split recommended");
    expect(resultText).toContain("Bills, Receipts");
    expect(resultText).toContain('"Keep tax paperwork only"');
    expect(resultText).not.toContain("ups_split_recommended");
  });
});
