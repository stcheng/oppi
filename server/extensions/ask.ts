import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const AskOptionSchema = Type.Object({
  value: Type.String({ description: "Return value when selected" }),
  label: Type.String({ description: "Display label" }),
  description: Type.Optional(Type.String({ description: "Short description below label" })),
});

const AskQuestionSchema = Type.Object({
  id: Type.String({ description: "Stable key for the answer map" }),
  question: Type.String({ description: "Full question text" }),
  options: Type.Array(AskOptionSchema, {
    description: "Options for the user to choose from (2-6 recommended)",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
  ),
});

const AskParams = Type.Object({
  questions: Type.Array(AskQuestionSchema, {
    description: "One or more questions to ask. Presented as a horizontal pager on mobile.",
  }),
  allowCustom: Type.Optional(
    Type.Boolean({ description: "Allow typing a custom answer per question. Default: true" }),
  ),
});

/**
 * First-party ask extension.
 *
 * Oppi intercepts ask tool execution and renders it as a native AskCard on iOS.
 * Keeping the tool definition server-owned ensures the mobile UI contract and
 * prompt guidance stay in sync even if the host's ~/.pi/agent/extensions changes.
 */
export function createAskFactory(): ExtensionFactory {
  return (pi) => {
    let askedThisTurn = false;

    pi.on("turn_start", async () => {
      askedThisTurn = false;
    });

    pi.registerTool({
      name: "ask",
      label: "Ask",
      description:
        "Ask the user one or more clarifying questions with predefined options. " +
        "Call ONCE per turn — bundle all questions into a single call. " +
        "The user sees a rich card UI where they can tap options, select multiple, " +
        "type a custom answer, or ignore any question. " +
        "Use this whenever the user's intent is ambiguous, there are multiple valid " +
        "approaches, or you are about to make an assumption that could be wrong. " +
        "Prefer asking over guessing.",
      promptSnippet:
        "Ask the user clarifying questions — prefer asking over guessing when intent is ambiguous",
      promptGuidelines: [
        "Call ask at most ONCE per turn. Bundle all your questions into that one call.",
        "Two kinds of unknowns — treat them differently:" +
          "\n  - Discoverable facts (file locations, existing patterns, API shapes): explore first via read/bash/grep. Never ask what you can look up." +
          "\n  - Preferences and tradeoffs (approaches, scope, naming, conventions): ask early. These can't be discovered from the codebase.",
        "Use ask proactively when you face genuine ambiguity. The user has a rich card UI " +
          "that makes answering quick — asking is cheap, guessing wrong is expensive. " +
          "Prefer asking over guessing when the decision materially changes the implementation.",
        "Provide 2-6 clear options per question. Put your recommended option first. " +
          "Include a description when the label alone is ambiguous.",
        "Set multiSelect: true when more than one option can apply (e.g. 'which of these should I include?').",
        "The user can always type a custom answer or ignore any question — your options don't need to cover every possibility.",
        "If the user ignores a question, proceed using your best judgment — don't re-ask the same question.",
        "Good triggers for ask: file organization choices, naming conventions, test strategy, error handling approach, " +
          "scope of a refactor, which features to include, API design tradeoffs, dependency choices.",
      ],
      parameters: AskParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (askedThisTurn) {
          throw new Error("Only one ask call per turn. Bundle all questions into a single call.");
        }
        askedThisTurn = true;

        if (!ctx.hasUI) {
          const fallback: Record<string, string | string[]> = {};
          for (const q of params.questions) {
            if (q.options.length > 0) {
              fallback[q.id] = q.multiSelect ? [q.options[0].value] : q.options[0].value;
            }
          }
          return {
            content: [
              {
                type: "text",
                text: `No UI available. Defaults: ${JSON.stringify(fallback)}`,
              },
            ],
            details: { questions: params.questions, answers: fallback, allIgnored: false },
          };
        }

        // Oppi renders ask as a single native card, so all select() calls must
        // be issued concurrently. The server defers them, sends one AskCard to
        // iOS, then resolves the batch from the user's response.
        const results = await Promise.all(
          params.questions.map((q) => {
            const options = q.options.map((o) => o.label);
            return ctx.ui.select(q.question, options);
          }),
        );

        const answers: Record<string, string | string[]> = {};
        let allIgnored = true;

        for (let i = 0; i < params.questions.length; i++) {
          const q = params.questions[i];
          const selected = results[i];

          if (selected === undefined) {
            continue;
          }

          allIgnored = false;
          const matched = q.options.find((o) => o.label === selected);
          const value = matched?.value ?? selected;
          answers[q.id] = q.multiSelect ? [value] : value;
        }

        if (allIgnored) {
          return {
            content: [
              {
                type: "text",
                text: "The user chose not to answer any questions. Proceed using your best judgment.",
              },
            ],
            details: { questions: params.questions, answers: {}, allIgnored: true },
          };
        }

        const lines: string[] = [];
        for (const q of params.questions) {
          const answer = answers[q.id];
          if (answer === undefined) {
            lines.push(`${q.id}: (ignored)`);
          } else if (Array.isArray(answer)) {
            lines.push(`${q.id}: ${answer.join(", ")}`);
          } else {
            lines.push(`${q.id}: ${answer}`);
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { questions: params.questions, answers, allIgnored: false },
        };
      },
    });
  };
}
