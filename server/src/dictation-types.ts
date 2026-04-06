/**
 * Dictation pipeline types.
 *
 * Defines the WS protocol messages (client/server) and configuration
 * for the /dictation WebSocket endpoint.
 */

// ─── Config ───

export type SttProviderType =
  | "mlx-streaming"
  | "mlx-server"
  | "openai"
  | "deepgram"
  | "elevenlabs"
  | "qwen_asr";

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

  /** Language hint for providers that support it (ISO-639-1). */
  sttLanguage?: string;

  /**
   * Auto-generate a domain term sheet from workspace context and inject
   * it into the ASR model's system prompt. Improves accuracy for project-
   * specific proper nouns and technical terms at zero latency cost.
   * Default: true.
   */
  termSheetEnabled?: boolean;

  /** Extra file paths to include in term sheet extraction. */
  termSheetExtraFiles?: string[];

  /** Extra directories to scan for JSONL/text files containing terms. */
  termSheetExtraDirs?: string[];

  /** Manually-specified terms (always included when term sheet is enabled). */
  termSheetManualTerms?: string[];

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

  /**
   * Run regex-extracted term sheet candidates through a local LLM to
   * filter noise (generic English, formatting artifacts, well-known
   * acronyms). Uses the same llmEndpoint. Default: false.
   */
  termSheetLlmCurationEnabled?: boolean;
}

export const DEFAULT_DICTATION_CONFIG: DictationConfig = {
  sttEndpoint: "http://localhost:9847",
  sttModel: "mlx-community/Qwen3-ASR-1.7B-bf16",
  preserveAudio: true,
  maxDurationSec: 0,
  llmEndpoint: "http://localhost:8400",
  llmModel: "Qwen3.5-122B-A10B-4bit",
  llmCorrectionEnabled: false,
  termSheetEnabled: true,
  termSheetLlmCurationEnabled: false,
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
