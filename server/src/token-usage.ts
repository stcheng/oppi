import type { PiMessageUsage } from "./pi-events.js";

export interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CacheWriteResolution {
  value: number;
  source: "reported" | "estimated" | "none";
  ruleId?: string;
}

interface CacheWriteInferenceRule {
  id: string;
  description: string;
  matches: (modelId: string) => boolean;
  estimate: (tokens: TokenCounts) => number;
}

const CACHE_WRITE_INFERENCE_RULES: CacheWriteInferenceRule[] = [
  {
    id: "openai-gpt-uncached-input",
    description:
      "OpenAI Responses/Codex often report cached read tokens but omit explicit cache write tokens. " +
      "Use uncached input as a write-equivalent for model-breakdown display.",
    matches: (modelId: string) => {
      const lower = modelId.toLowerCase();
      const isOpenAIFamily =
        lower.startsWith("openai/") ||
        lower.startsWith("openai-codex/") ||
        lower.startsWith("azure-openai-responses/") ||
        lower.includes("/openai/");
      return isOpenAIFamily && lower.includes("gpt-");
    },
    estimate: (tokens: TokenCounts) => {
      if (tokens.cacheRead <= 0 || tokens.input <= 0) {
        return 0;
      }
      return tokens.input;
    },
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readFiniteNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) {
    return undefined;
  }

  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function nonNegative(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value;
}

/**
 * Normalize heterogeneous provider usage payloads into server canonical fields.
 *
 * Provider notes (pi upstream):
 * - Anthropic messages expose cache_read_input_tokens / cache_creation_input_tokens
 * - OpenAI Chat Completions expose prompt_tokens_details.cached_tokens (+ optional cache_write_tokens)
 * - OpenAI Responses expose input_tokens_details.cached_tokens and may omit cache writes
 */
export function normalizePiUsage(usageLike: PiMessageUsage | unknown): NormalizedUsage | null {
  const usage = asRecord(usageLike);
  if (!usage) {
    return null;
  }

  const cost = asRecord(usage.cost);

  const explicitInput = readFiniteNumber(usage, "input");
  const explicitOutput = readFiniteNumber(usage, "output");
  const explicitCacheRead = readFiniteNumber(usage, "cacheRead");
  const explicitCacheWrite = readFiniteNumber(usage, "cacheWrite");

  // OpenAI-family raw usage fallback:
  // - Chat Completions: prompt_tokens_details.cached_tokens/cache_write_tokens
  // - Responses API: input_tokens_details.cached_tokens/cache_write_tokens
  const promptDetails =
    asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details);

  const fallbackCacheRead =
    readFiniteNumber(promptDetails, "cached_tokens") ??
    readFiniteNumber(usage, "cache_read_input_tokens") ??
    readFiniteNumber(usage, "cache_read_tokens");

  const fallbackCacheWrite =
    readFiniteNumber(promptDetails, "cache_write_tokens") ??
    readFiniteNumber(promptDetails, "cache_creation_tokens") ??
    readFiniteNumber(usage, "cache_write_tokens") ??
    readFiniteNumber(usage, "cache_creation_input_tokens") ??
    readFiniteNumber(usage, "cache_creation_tokens");

  const cacheRead = nonNegative(explicitCacheRead ?? fallbackCacheRead);
  const cacheWrite = nonNegative(explicitCacheWrite ?? fallbackCacheWrite);

  const promptTokens =
    readFiniteNumber(usage, "prompt_tokens") ?? readFiniteNumber(usage, "input_tokens");
  const completionTokens =
    readFiniteNumber(usage, "completion_tokens") ?? readFiniteNumber(usage, "output_tokens");

  let input = nonNegative(explicitInput);

  if (promptTokens !== undefined) {
    // Prefer provider total-input counters when available.
    input = Math.max(0, promptTokens - cacheRead - cacheWrite);
  }

  const output = nonNegative(explicitOutput ?? completionTokens);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: nonNegative(readFiniteNumber(cost, "total")),
  };
}

function normalizeTokens(tokens: Partial<TokenCounts> | undefined): TokenCounts {
  return {
    input: nonNegative(tokens?.input),
    output: nonNegative(tokens?.output),
    cacheRead: nonNegative(tokens?.cacheRead),
    cacheWrite: nonNegative(tokens?.cacheWrite),
  };
}

/**
 * Resolve cache write for model-breakdown display.
 *
 * - Uses reported cacheWrite when present.
 * - Otherwise applies a model-specific inference rule (if any).
 */
export function resolveCacheWriteForModelBreakdown(
  modelId: string | undefined,
  tokens: Partial<TokenCounts> | undefined,
): CacheWriteResolution {
  const normalized = normalizeTokens(tokens);

  if (normalized.cacheWrite > 0) {
    return { value: normalized.cacheWrite, source: "reported" };
  }

  if (!modelId) {
    return { value: 0, source: "none" };
  }

  for (const rule of CACHE_WRITE_INFERENCE_RULES) {
    if (!rule.matches(modelId)) {
      continue;
    }

    const estimate = nonNegative(rule.estimate(normalized));
    if (estimate > 0) {
      return { value: estimate, source: "estimated", ruleId: rule.id };
    }

    return { value: 0, source: "none", ruleId: rule.id };
  }

  return { value: 0, source: "none" };
}
