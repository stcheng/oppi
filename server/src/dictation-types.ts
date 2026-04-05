/**
 * Dictation pipeline types.
 *
 * Defines the WS protocol messages (client/server) and configuration
 * for the /dictation WebSocket endpoint.
 */

// ─── Config ───

export interface DictationConfig {
  /** STT backend endpoint (OpenAI-compatible /v1/audio/transcriptions). */
  sttEndpoint: string;

  /** Model to request from the STT backend. */
  sttModel: string;

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
}

export const DEFAULT_DICTATION_CONFIG: DictationConfig = {
  sttEndpoint: "http://localhost:9847",
  sttModel: "mlx-community/Qwen3-ASR-1.7B-bf16",
  retranscribeIntervalMs: 2000,
  preserveAudio: true,
  maxDurationSec: 300,
  llmEndpoint: "http://localhost:8400",
  llmModel: "Qwen3.5-122B-A10B-4bit",
  llmCorrectionEnabled: true,
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
}
