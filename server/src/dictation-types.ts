/**
 * Dictation pipeline types.
 *
 * Defines the WS protocol messages (client/server) and configuration
 * for the /dictation WebSocket endpoint.
 */

// ─── Config ───

export type SttProviderType = "mlx-server" | "openai" | "deepgram" | "elevenlabs" | "qwen_asr";

export interface DictationConfig {
  /** STT provider type. Default: "mlx-server". */
  sttProvider?: SttProviderType;

  /** STT backend endpoint (required for HTTP providers, ignored for native). */
  sttEndpoint: string;

  /** Path to qwen_asr binary. Only used when provider is "qwen_asr". */
  sttBinary?: string;

  /** Path to qwen_asr model directory. Only used when provider is "qwen_asr". */
  sttModelDir?: string;

  /** Model to request from the STT backend. */
  sttModel: string;

  /** API key for the STT backend. Omit or empty = no auth. */
  sttApiKey?: string;

  /** Auth header style: "bearer" (default, OpenAI-style) or "x-api-key" (NanoGPT-style). */
  sttAuthStyle?: "bearer" | "x-api-key";

  /** Language hint for providers that support it (ISO-639-1). */
  sttLanguage?: string;

  /** Base retranscribe interval in ms (adaptive — widens as audio grows). */
  retranscribeIntervalMs: number;

  /** Save audio as FLAC on finalize. */
  preserveAudio: boolean;

  /** Max dictation session duration in seconds (0 = unlimited). */
  maxDurationSec: number;

  /** LLM correction endpoint (OpenAI-compatible /v1/chat/completions). */
  llmEndpoint: string;

  /** Model for LLM correction. */
  llmModel: string;

  /** Whether to run LLM correction on finalize. */
  llmCorrectionEnabled: boolean;

  // ─── STT decode knobs (mlx-server specific, ignored by other providers) ───
  /** Sampling temperature sent to the STT model (0 = greedy). */
  sttTemperature?: number;
  /** Top-k sampling for STT model. */
  sttTopK?: number;
  /** Top-p (nucleus) sampling for STT model. */
  sttTopP?: number;
  /** Repetition penalty for STT model. */
  sttRepetitionPenalty?: number;
  /** Context size used for repetition penalty calculation. */
  sttRepetitionContextSize?: number;
}

export const DEFAULT_DICTATION_CONFIG: DictationConfig = {
  sttEndpoint: "http://localhost:9847",
  sttModel: "mlx-community/Qwen3-ASR-1.7B-bf16",
  sttApiKey: "",
  retranscribeIntervalMs: 2000,
  preserveAudio: true,
  maxDurationSec: 0,
  llmEndpoint: "http://localhost:8400",
  llmModel: "Qwen3.5-122B-A10B-4bit",
  llmCorrectionEnabled: false,
  // STT decode knobs — tuned for live dictation with Qwen3-ASR
  sttTemperature: 0.01,
  sttTopK: 1,
  sttTopP: 0.9,
  sttRepetitionPenalty: 1.28,
  sttRepetitionContextSize: 64,
};

// ─── Client -> Server messages ───

export interface DictationStartMessage {
  type: "dictation_start";
  language?: string;
}

export interface DictationStopMessage {
  type: "dictation_stop";
}

export interface DictationCancelMessage {
  type: "dictation_cancel";
}

export type DictationClientMessage =
  | DictationStartMessage
  | DictationStopMessage
  | DictationCancelMessage;

// ─── Server -> Client messages ───

export interface DictationReadyMessage {
  type: "dictation_ready";
  /** STT provider identifier (e.g. "mlx-server", "openai", "deepgram"). */
  sttProvider?: string;
  /** STT model identifier. */
  sttModel?: string;
  /** Whether LLM correction is enabled for finalization. */
  llmCorrectionEnabled?: boolean;
}

export interface DictationResultMessage {
  type: "dictation_result";
  text: string;
  version: number;
}

export interface DictationFinalMessage {
  type: "dictation_final";
  text: string;
  uncorrected?: string;
  audioId?: string;
}

export interface DictationErrorMessage {
  type: "dictation_error";
  error: string;
  fatal: boolean;
}

export type DictationServerMessage =
  | DictationReadyMessage
  | DictationResultMessage
  | DictationFinalMessage
  | DictationErrorMessage;

// ─── Dictionary ───

export interface DictationDictionary {
  corrections: Record<string, string>;
  domain_terms: string[];
}

// ─── Audio metadata (saved alongside FLAC) ───

export interface DictationAudioMetadata {
  audioId: string;
  startedAt: string;
  durationMs: number;
  sampleRate: number;
  transcript: string;
  language?: string;
  model: string;
  sttEndpoint: string;
  /** Pipeline timing breakdown (populated when metrics are available). */
  timing?: {
    /** Total session wall-clock time (start to final) in ms. */
    sessionMs: number;
    /** Final STT call latency in ms. */
    finalSttMs: number;
    /** Real-time factor for final STT (sttMs / audioDurationMs). <1.0 = faster than real-time. */
    sttRealTimeFactor: number;
    /** LLM correction call latency in ms (0 if disabled or skipped). */
    llmCorrectionMs: number;
    /** Audio save (FLAC encode + write) latency in ms. */
    audioSaveMs: number;
    /** Total finalize latency in ms (final STT + LLM + save). */
    finalizeMs: number;
    /** Number of retranscribe ticks during the session. */
    retranscribeCount: number;
  };
}
