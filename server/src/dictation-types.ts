/**
 * Dictation pipeline types.
 *
 * Defines the WS protocol messages (client/server) and server-side
 * configuration for dictation routed through the main /stream WebSocket.
 */

// ─── Config ───

export interface DictationConfig {
  /** STT backend endpoint (must implement the streaming session API). */
  sttEndpoint: string;

  /** Model to request from the STT backend. */
  sttModel: string;

  /** Save audio as FLAC on finalize. */
  preserveAudio: boolean;
}

export const DEFAULT_DICTATION_CONFIG: DictationConfig = {
  sttEndpoint: "http://localhost:9748",
  sttModel: "mlx-community/Qwen3-ASR-1.7B-bf16",
  preserveAudio: true,
};

// ─── Client -> Server messages ───

export interface DictationStartMessage {
  type: "dictation_start";
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
  /** STT provider identifier reported by the backend (e.g. "streaming-localhost"). */
  sttProvider?: string;
  /** STT model identifier. */
  sttModel?: string;
}

export interface DictationResultMessage {
  type: "dictation_result";
  text: string;
  /** When true, the text is a batch-corrected replacement. Client should snap (no animation). */
  snap?: boolean;
}

export interface DictationFinalMessage {
  type: "dictation_final";
  text: string;
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
    /** Audio save (FLAC encode + write) latency in ms. */
    audioSaveMs: number;
    /** Total finalize latency in ms (final STT + save). */
    finalizeMs: number;
  };
}
