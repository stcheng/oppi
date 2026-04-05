/**
 * STT provider interface and implementations.
 *
 * Each provider encapsulates its own HTTP call, auth, field mapping,
 * and response parsing. The DictationManager just calls transcribe().
 *
 * Provider landscape (April 2026):
 * - OpenAI / Groq: multipart form, Bearer auth, {text} response
 * - Deepgram: raw audio body, Token auth, nested results.channels response
 * - ElevenLabs: multipart form, xi-api-key header, {text} response
 * - MLX Server (ours): OpenAI-compatible + extra knobs
 */

import type { DictationConfig } from "./dictation-types.js";

// ─── Interface ───

/** Audio in → text out. That's the contract. */
export interface SttProvider {
  /** Provider identifier for logs/metrics (e.g. "mlx-server", "openai"). */
  readonly name: string;
  /** Model identifier used for transcription. */
  readonly model: string;
  /** Endpoint URL for metadata/debugging. */
  readonly endpoint: string;
  /** Transcribe WAV audio buffer to text. */
  transcribe(audio: Buffer): Promise<string>;
}

// ─── Helpers ───

/** Convert Node Buffer to ArrayBuffer-backed Blob for FormData. */
function bufferToBlob(buf: Buffer, type: string): Blob {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Blob([ab], { type });
}

// ─── MLX Server Provider ───

export interface MlxServerSttOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  authStyle?: "bearer" | "x-api-key";
  temperature?: number;
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  repetitionContextSize?: number;
}

/**
 * Local MLX inference server (our own). OpenAI-compatible base +
 * extra knobs (repetition_penalty, top_k, etc.) and dictation_cleanup
 * post-processing.
 */
export class MlxServerSttProvider implements SttProvider {
  readonly name = "mlx-server";
  readonly model: string;
  readonly endpoint: string;
  private opts: MlxServerSttOptions;
  private fetchFn: typeof globalThis.fetch;

  constructor(opts: MlxServerSttOptions, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.opts = opts;
    this.model = opts.model;
    this.endpoint = opts.endpoint;
    this.fetchFn = fetchFn;
  }

  async transcribe(audio: Buffer): Promise<string> {
    const formData = new FormData();
    formData.append("file", bufferToBlob(audio, "audio/wav"), "audio.wav");
    formData.append("model", this.opts.model);

    // MLX server decode knobs
    if (this.opts.temperature !== undefined)
      formData.append("temperature", String(this.opts.temperature));
    if (this.opts.topK !== undefined) formData.append("top_k", String(this.opts.topK));
    if (this.opts.topP !== undefined) formData.append("top_p", String(this.opts.topP));
    if (this.opts.repetitionPenalty !== undefined)
      formData.append("repetition_penalty", String(this.opts.repetitionPenalty));
    if (this.opts.repetitionContextSize !== undefined)
      formData.append("repetition_context_size", String(this.opts.repetitionContextSize));

    // MLX server post-processing
    formData.append("dictation_cleanup", "true");

    const url = `${this.opts.endpoint}/v1/audio/transcriptions`;
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) {
      const style = this.opts.authStyle ?? "bearer";
      if (style === "x-api-key") {
        headers["x-api-key"] = this.opts.apiKey;
      } else {
        headers["Authorization"] = `Bearer ${this.opts.apiKey}`;
      }
    }

    const response = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`STT HTTP ${response.status}: ${body}`);
    }

    const result = (await response.json()) as { text?: string };
    return result.text ?? "";
  }
}

// ─── OpenAI-Compatible Provider ───
// Works with: OpenAI, Groq, and any OpenAI-compatible STT endpoint.

export interface OpenAiSttOptions {
  endpoint: string; // e.g. "https://api.openai.com" or "https://api.groq.com/openai"
  model: string; // e.g. "whisper-1" or "whisper-large-v3-turbo"
  apiKey: string;
  language?: string;
  temperature?: number;
  prompt?: string;
}

/**
 * Standard OpenAI /v1/audio/transcriptions endpoint.
 * Also works with Groq (endpoint: "https://api.groq.com/openai").
 */
export class OpenAiSttProvider implements SttProvider {
  readonly name = "openai";
  readonly model: string;
  readonly endpoint: string;
  private opts: OpenAiSttOptions;
  private fetchFn: typeof globalThis.fetch;

  constructor(opts: OpenAiSttOptions, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.opts = opts;
    this.model = opts.model;
    this.endpoint = opts.endpoint;
    this.fetchFn = fetchFn;
  }

  async transcribe(audio: Buffer): Promise<string> {
    const formData = new FormData();
    formData.append("file", bufferToBlob(audio, "audio/wav"), "audio.wav");
    formData.append("model", this.opts.model);

    // Standard OpenAI fields only
    if (this.opts.language) formData.append("language", this.opts.language);
    if (this.opts.temperature !== undefined)
      formData.append("temperature", String(this.opts.temperature));
    if (this.opts.prompt) formData.append("prompt", this.opts.prompt);

    const url = `${this.opts.endpoint}/v1/audio/transcriptions`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`STT HTTP ${response.status}: ${body}`);
    }

    const result = (await response.json()) as { text?: string };
    return result.text ?? "";
  }
}

// ─── Deepgram Provider ───

export interface DeepgramSttOptions {
  endpoint?: string; // default: "https://api.deepgram.com"
  apiKey: string;
  model?: string; // default: "nova-3"
  language?: string;
  smartFormat?: boolean; // default: true
}

/**
 * Deepgram pre-recorded audio API. Sends raw audio bytes (not multipart),
 * model/language as query params, auth via Token header.
 */
export class DeepgramSttProvider implements SttProvider {
  readonly name = "deepgram";
  readonly model: string;
  readonly endpoint: string;
  private opts: DeepgramSttOptions;
  private fetchFn: typeof globalThis.fetch;

  constructor(opts: DeepgramSttOptions, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.opts = opts;
    this.model = opts.model ?? "nova-3";
    this.endpoint = opts.endpoint ?? "https://api.deepgram.com";
    this.fetchFn = fetchFn;
  }

  async transcribe(audio: Buffer): Promise<string> {
    const params = new URLSearchParams();
    params.set("model", this.model);
    if (this.opts.smartFormat !== false) params.set("smart_format", "true");
    if (this.opts.language) params.set("language", this.opts.language);

    const url = `${this.endpoint}/v1/listen?${params.toString()}`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.opts.apiKey}`,
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`STT HTTP ${response.status}: ${body}`);
    }

    // Deepgram nests transcript under results.channels[0].alternatives[0].transcript
    const result = (await response.json()) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    return result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  }
}

// ─── ElevenLabs Provider ───

export interface ElevenLabsSttOptions {
  endpoint?: string; // default: "https://api.elevenlabs.io"
  apiKey: string;
  model?: string; // default: "scribe_v2"
  languageCode?: string;
}

/**
 * ElevenLabs Speech-to-Text API. Multipart form with model_id (not model),
 * language_code (not language), auth via xi-api-key header.
 */
export class ElevenLabsSttProvider implements SttProvider {
  readonly name = "elevenlabs";
  readonly model: string;
  readonly endpoint: string;
  private opts: ElevenLabsSttOptions;
  private fetchFn: typeof globalThis.fetch;

  constructor(opts: ElevenLabsSttOptions, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.opts = opts;
    this.model = opts.model ?? "scribe_v2";
    this.endpoint = opts.endpoint ?? "https://api.elevenlabs.io";
    this.fetchFn = fetchFn;
  }

  async transcribe(audio: Buffer): Promise<string> {
    const formData = new FormData();
    formData.append("file", bufferToBlob(audio, "audio/wav"), "audio.wav");
    formData.append("model_id", this.model);
    if (this.opts.languageCode) formData.append("language_code", this.opts.languageCode);

    const url = `${this.endpoint}/v1/speech-to-text`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "xi-api-key": this.opts.apiKey },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`STT HTTP ${response.status}: ${body}`);
    }

    const result = (await response.json()) as { text?: string };
    return result.text ?? "";
  }
}

// ─── Factory ───

/**
 * Create an SttProvider from DictationConfig.
 * Provider type is selected by `config.sttProvider` (default: "mlx-server").
 */
export function createSttProvider(
  config: DictationConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): SttProvider {
  const providerType = config.sttProvider ?? "mlx-server";

  switch (providerType) {
    case "mlx-server":
      return new MlxServerSttProvider(
        {
          endpoint: config.sttEndpoint,
          model: config.sttModel,
          apiKey: config.sttApiKey,
          authStyle: config.sttAuthStyle,
          temperature: config.sttTemperature,
          topK: config.sttTopK,
          topP: config.sttTopP,
          repetitionPenalty: config.sttRepetitionPenalty,
          repetitionContextSize: config.sttRepetitionContextSize,
        },
        fetchFn,
      );

    case "openai":
      return new OpenAiSttProvider(
        {
          endpoint: config.sttEndpoint,
          model: config.sttModel,
          apiKey: config.sttApiKey ?? "",
          language: config.sttLanguage,
          temperature: config.sttTemperature,
        },
        fetchFn,
      );

    case "deepgram":
      return new DeepgramSttProvider(
        {
          endpoint: config.sttEndpoint,
          apiKey: config.sttApiKey ?? "",
          model: config.sttModel,
          language: config.sttLanguage,
        },
        fetchFn,
      );

    case "elevenlabs":
      return new ElevenLabsSttProvider(
        {
          endpoint: config.sttEndpoint,
          apiKey: config.sttApiKey ?? "",
          model: config.sttModel,
          languageCode: config.sttLanguage,
        },
        fetchFn,
      );

    default:
      throw new Error(
        `Unknown STT provider: "${providerType}". ` +
          `Supported: mlx-server, openai, deepgram, elevenlabs`,
      );
  }
}
