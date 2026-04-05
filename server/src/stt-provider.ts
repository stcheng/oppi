/**
 * STT provider interface and implementations.
 *
 * Single interface: SttProvider (streaming).
 * All providers — native binary, HTTP batch — implement the same lifecycle:
 *   start() → feedAudio()* → onToken() → stop() → final text
 *
 * HTTP providers wrap their batch transcribe() behind HttpSttAdapter,
 * which owns the retranscribe timer and WAV encoding internally.
 * DictationManager never branches on provider type.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import type { DictationConfig } from "./dictation-types.js";

// ─── PCM constants (shared with dictation-manager) ───

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // 16-bit
const NUM_CHANNELS = 1;

// ─── Interface ───

/**
 * Streaming STT provider. Audio is piped incrementally and transcript
 * updates arrive via callback as they're produced.
 *
 * Lifecycle: start() → feedAudio()* → onToken() callbacks → stop() → final text
 *
 * Both native binary providers (qwen_asr) and HTTP batch providers
 * (MLX, OpenAI, Deepgram, ElevenLabs) implement this interface.
 * HTTP providers use HttpSttAdapter which handles accumulation,
 * WAV encoding, and retranscribe timing internally.
 */
export interface SttProvider {
  /** Provider identifier for logs/metrics (e.g. "mlx-server", "qwen_asr"). */
  readonly name: string;
  /** Model identifier. */
  readonly model: string;
  /** Spawn the STT process / prepare for audio input. */
  start(): void;
  /** Write raw PCM audio (s16le, 16kHz, mono). */
  feedAudio(pcm: Buffer): void;
  /** Register callback for transcript updates (full replacement text each time). */
  onToken(cb: (text: string) => void): void;
  /** Close audio input, wait for completion, return full final text. */
  stop(): Promise<string>;
  /** Clean up provider resources (e.g. remote sessions). Call on shutdown. */
  dispose?(): Promise<void>;
}

// ─── Helpers ───

/** Convert Node Buffer to ArrayBuffer-backed Blob for FormData. */
function bufferToBlob(buf: Buffer, type: string): Blob {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Blob([ab], { type });
}

/** Create a 44-byte WAV header for the given PCM data length. */
function makeWavHeader(dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = NUM_CHANNELS * BYTES_PER_SAMPLE;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/** Resolve ~ to home directory in paths. */
function expandTilde(p: string): string {
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

// ─── Adaptive interval (used by HttpSttAdapter) ───

const ADAPTIVE_THRESHOLDS: Array<{ maxSeconds: number; intervalMs: number }> = [
  { maxSeconds: 30, intervalMs: 2000 },
  { maxSeconds: 60, intervalMs: 4000 },
  { maxSeconds: 120, intervalMs: 6000 },
  { maxSeconds: Infinity, intervalMs: 12000 },
];

/** Return the retranscribe interval for the given audio duration. */
export function adaptiveInterval(audioSeconds: number, baseIntervalMs: number): number {
  for (const threshold of ADAPTIVE_THRESHOLDS) {
    if (audioSeconds < threshold.maxSeconds) {
      const scale = threshold.intervalMs / 2000;
      return Math.round(baseIntervalMs * scale);
    }
  }
  return baseIntervalMs * 6;
}

// ─── HTTP batch transcriber (internal, used by HttpSttAdapter) ───

/**
 * Batch transcription function. Implementations call an HTTP endpoint
 * with a WAV buffer and return the transcript text.
 */
interface HttpTranscriber {
  readonly name: string;
  readonly model: string;
  readonly endpoint: string;
  transcribe(audio: Buffer): Promise<string>;
}

// ─── HttpSttAdapter ───

/** Initial audio buffer capacity (64 KB ≈ 2s). */
const INITIAL_AUDIO_BUFFER_SIZE = 64 * 1024;

export interface HttpSttAdapterOptions {
  /** Base retranscribe interval in ms (adaptive — widens as audio grows). */
  retranscribeIntervalMs: number;
  /** Max dictation session duration in seconds (0 = unlimited). */
  maxDurationSec: number;
}

/**
 * Wraps any HTTP batch transcriber behind the SttProvider streaming interface.
 *
 * Accumulates PCM audio, runs a retranscribe timer that periodically
 * encodes WAV and calls the underlying transcriber, and fires the
 * onToken callback with the full replacement text each time.
 *
 * The retranscribe timer, adaptive intervals, WAV encoding, and
 * inflight guard all live here — not in DictationManager.
 */
export class HttpSttAdapter implements SttProvider {
  readonly name: string;
  readonly model: string;
  /** Endpoint URL (exposed for metadata/audio preservation). */
  readonly endpoint: string;

  /** @internal Exposed for testing. */
  readonly transcriber: HttpTranscriber;
  private opts: HttpSttAdapterOptions;
  private tokenCb: ((text: string) => void) | null = null;

  private audioBuffer: Buffer = Buffer.alloc(0);
  private totalBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  private stopped = false;
  private lastText = "";
  private retranscribeCount = 0;

  constructor(transcriber: HttpTranscriber, opts: HttpSttAdapterOptions) {
    this.transcriber = transcriber;
    this.name = transcriber.name;
    this.model = transcriber.model;
    this.endpoint = transcriber.endpoint;
    this.opts = opts;
  }

  start(): void {
    this.audioBuffer = Buffer.alloc(INITIAL_AUDIO_BUFFER_SIZE);
    this.totalBytes = 0;
    this.lastText = "";
    this.inflight = false;
    this.stopped = false;
    this.retranscribeCount = 0;
    this.scheduleRetranscribe();
  }

  feedAudio(pcm: Buffer): void {
    if (this.stopped) return;
    const needed = this.totalBytes + pcm.length;
    if (needed > this.audioBuffer.length) {
      const newCap = Math.max(this.audioBuffer.length * 2, needed);
      const newBuf = Buffer.alloc(newCap);
      this.audioBuffer.copy(newBuf, 0, 0, this.totalBytes);
      this.audioBuffer = newBuf;
    }
    pcm.copy(this.audioBuffer, this.totalBytes);
    this.totalBytes += pcm.length;
  }

  onToken(cb: (text: string) => void): void {
    this.tokenCb = cb;
  }

  async stop(): Promise<string> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Do one final transcription if we have audio
    if (this.totalBytes > 0) {
      try {
        this.lastText = await this.callTranscribe();
      } catch {
        // Return whatever we had from the last successful retranscribe
      }
    }
    return this.lastText;
  }

  /** Exposed for metrics: how many retranscribe calls were made. */
  getRetranscribeCount(): number {
    return this.retranscribeCount;
  }

  // ─── Internal ───

  private scheduleRetranscribe(): void {
    if (this.timer) clearInterval(this.timer);
    const audioSeconds = this.totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE * NUM_CHANNELS);
    const intervalMs = adaptiveInterval(audioSeconds, this.opts.retranscribeIntervalMs);

    this.timer = setInterval(() => {
      if (this.stopped) return;

      // Re-schedule if audio grew past a threshold
      const currentSeconds = this.totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE * NUM_CHANNELS);
      const newInterval = adaptiveInterval(currentSeconds, this.opts.retranscribeIntervalMs);
      if (newInterval !== intervalMs) {
        this.scheduleRetranscribe();
      }

      // Check max duration
      if (this.opts.maxDurationSec > 0 && currentSeconds >= this.opts.maxDurationSec) {
        this.stopped = true;
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        return;
      }

      void this.retranscribe();
    }, intervalMs);
  }

  private async retranscribe(): Promise<void> {
    if (this.inflight || this.totalBytes === 0) return;
    this.inflight = true;
    this.retranscribeCount++;

    try {
      const text = await this.callTranscribe();
      this.lastText = text;
      this.tokenCb?.(text);
    } catch (err) {
      console.warn(
        "[http-stt] Retranscribe error:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.inflight = false;
    }
  }

  private async callTranscribe(): Promise<string> {
    const pcm = this.audioBuffer.subarray(0, this.totalBytes);
    const wav = Buffer.concat([makeWavHeader(this.totalBytes), pcm]);
    return this.transcriber.transcribe(wav);
  }
}

// ─── Qwen ASR Provider (native binary) ───

export interface QwenAsrOptions {
  /** Path to the qwen_asr binary. */
  binary: string;
  /** Path to the model directory (with *.safetensors, vocab.json). */
  modelDir: string;
}

/**
 * Streaming STT via antirez/qwen-asr (pure C binary, MIT license).
 * https://github.com/antirez/qwen-asr
 *
 * Spawns `qwen_asr -d <modelDir> --stdin --stream` per session.
 * Pipes raw s16le 16kHz mono PCM to stdin, reads decoded tokens from stdout.
 * The binary handles internal 2s chunking, prefix rollback, and sliding window.
 */
export class QwenAsrProvider implements SttProvider {
  readonly name = "qwen_asr";
  readonly model: string;
  private opts: QwenAsrOptions;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private tokenCb: ((text: string) => void) | null = null;
  private accumulated = "";

  constructor(opts: QwenAsrOptions) {
    this.opts = opts;
    const parts = opts.modelDir.replace(/\/+$/, "").split("/");
    this.model = parts[parts.length - 1] || "qwen-asr";
  }

  start(): void {
    if (this.proc) throw new Error("QwenAsrProvider already started");
    this.accumulated = "";

    this.proc = spawn(this.opts.binary, ["-d", this.opts.modelDir, "--stdin", "--stream"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Tokens stream as individual pieces (subwords/words), flushed after each
    // decode step. We accumulate into a running transcript and fire the callback
    // with the full text so far (iOS expects replacement semantics).
    this.proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const cleaned = text.replace(/\n$/, "");
      if (cleaned.length === 0) return;
      this.accumulated += cleaned;
      this.tokenCb?.(this.accumulated);
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf8").trim();
      if (msg) console.warn("[qwen-asr]", msg);
    });
  }

  feedAudio(pcm: Buffer): void {
    if (!this.proc || this.proc.stdin.destroyed) return;
    this.proc.stdin.write(pcm);
  }

  onToken(cb: (text: string) => void): void {
    this.tokenCb = cb;
  }

  stop(): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = this.proc;
      if (!proc) {
        resolve(this.accumulated);
        return;
      }

      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("qwen_asr did not exit within 30s after stdin close"));
      }, 30_000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        this.proc = null;
        if (code !== 0 && code !== null) {
          reject(new Error(`qwen_asr exited with code ${code}`));
          return;
        }
        resolve(this.accumulated);
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        this.proc = null;
        reject(new Error(`qwen_asr process error: ${err.message}`));
      });

      if (!proc.stdin.destroyed) {
        proc.stdin.end();
      }
    });
  }
}

// ─── HTTP transcriber implementations ───

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

export class MlxServerTranscriber implements HttpTranscriber {
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
    if (this.opts.temperature !== undefined)
      formData.append("temperature", String(this.opts.temperature));
    if (this.opts.topK !== undefined) formData.append("top_k", String(this.opts.topK));
    if (this.opts.topP !== undefined) formData.append("top_p", String(this.opts.topP));
    if (this.opts.repetitionPenalty !== undefined)
      formData.append("repetition_penalty", String(this.opts.repetitionPenalty));
    if (this.opts.repetitionContextSize !== undefined)
      formData.append("repetition_context_size", String(this.opts.repetitionContextSize));
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

export interface OpenAiSttOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  language?: string;
  temperature?: number;
  prompt?: string;
}

export class OpenAiTranscriber implements HttpTranscriber {
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

export interface DeepgramSttOptions {
  endpoint?: string;
  apiKey: string;
  model?: string;
  language?: string;
  smartFormat?: boolean;
}

export class DeepgramTranscriber implements HttpTranscriber {
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
    const result = (await response.json()) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    return result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  }
}

export interface ElevenLabsSttOptions {
  endpoint?: string;
  apiKey: string;
  model?: string;
  languageCode?: string;
}

export class ElevenLabsTranscriber implements HttpTranscriber {
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

// ─── MLX Streaming Provider ───

/**
 * Streaming STT via MLX server's stateful session endpoint.
 *
 * Uses encoder window caching + decoder KV reuse + prefix rollback
 * for O(1) per-chunk latency instead of O(n) retranscribe.
 *
 * API:
 *   POST /v1/audio/transcriptions/stream      → create session
 *   POST /v1/audio/transcriptions/stream/:id   → feed chunk (raw PCM)
 *   DELETE /v1/audio/transcriptions/stream/:id  → stop, get final text
 */
export class MlxStreamingSttProvider implements SttProvider {
  readonly name = "mlx-streaming";
  readonly model: string;
  readonly endpoint: string;
  private fetchFn: typeof globalThis.fetch;
  private sessionId: string | null = null;
  private warmSessionId: string | null = null;
  private tokenCb: ((text: string) => void) | null = null;
  private lastText = "";
  private audioQueue: Buffer[] = [];
  private feeding = false;
  private stopped = false;
  private feedTimer: ReturnType<typeof setInterval> | null = null;
  /** How often to flush accumulated audio to the session (ms). */
  private feedIntervalMs: number;

  constructor(
    opts: { endpoint: string; model: string },
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    feedIntervalMs = 2000,
  ) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.fetchFn = fetchFn;
    this.feedIntervalMs = feedIntervalMs;
    // Pre-warm a session at construction time
    void this.warmUpSession();
  }

  start(): void {
    // Cleanup existing active session if start() called again without stop()
    if (this.sessionId) {
      void this.deleteSession(this.sessionId);
      this.sessionId = null;
    }
    if (this.feedTimer) {
      clearInterval(this.feedTimer);
      this.feedTimer = null;
    }

    this.lastText = "";
    this.audioQueue = [];
    this.feeding = false;
    this.stopped = false;

    // Use warm session if available, otherwise create fresh
    if (this.warmSessionId) {
      this.sessionId = this.warmSessionId;
      this.warmSessionId = null;
      this.feedTimer = setInterval(() => void this.flushAudio(), this.feedIntervalMs);
    } else {
      this.sessionId = null;
      void this.createSession();
    }
  }

  feedAudio(pcm: Buffer): void {
    if (this.stopped) return;
    this.audioQueue.push(pcm);
  }

  onToken(cb: (text: string) => void): void {
    this.tokenCb = cb;
  }

  async stop(): Promise<string> {
    this.stopped = true;
    if (this.feedTimer) {
      clearInterval(this.feedTimer);
      this.feedTimer = null;
    }

    // Flush remaining audio
    if (this.sessionId && this.audioQueue.length > 0) {
      try {
        await this.flushAudio();
      } catch {
        // Best effort
      }
    }

    // Stop session and get final text
    if (this.sessionId) {
      try {
        const url = `${this.endpoint}/v1/audio/transcriptions/stream/${this.sessionId}`;
        const res = await this.fetchFn(url, {
          method: "DELETE",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = (await res.json()) as { text?: string };
          this.lastText = data.text ?? this.lastText;
        }
      } catch {
        // Return whatever we had
      }
      this.sessionId = null;
    }

    // Pre-warm next session so next mic tap is instant
    void this.warmUpSession();

    return this.lastText;
  }

  /** Cleanup all sessions. Call on server shutdown. */
  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.feedTimer) {
      clearInterval(this.feedTimer);
      this.feedTimer = null;
    }

    const promises: Promise<void>[] = [];
    if (this.sessionId) {
      promises.push(this.deleteSession(this.sessionId));
      this.sessionId = null;
    }
    if (this.warmSessionId) {
      promises.push(this.deleteSession(this.warmSessionId));
      this.warmSessionId = null;
    }
    await Promise.allSettled(promises);
  }

  // ─── Internal ───

  /** DELETE a session on the MLX server. Best-effort, logs errors. */
  private async deleteSession(id: string): Promise<void> {
    try {
      const url = `${this.endpoint}/v1/audio/transcriptions/stream/${id}`;
      await this.fetchFn(url, {
        method: "DELETE",
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      console.warn(
        "[mlx-streaming] Failed to delete session:",
        id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async warmUpSession(): Promise<void> {
    // Cleanup existing warm session to prevent leak
    if (this.warmSessionId) {
      await this.deleteSession(this.warmSessionId);
      this.warmSessionId = null;
    }

    try {
      const url = `${this.endpoint}/v1/audio/transcriptions/stream`;
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { session_id?: string };
        this.warmSessionId = data.session_id ?? null;
      }
    } catch {
      // Non-fatal — will create on demand in start()
    }
  }

  private async createSession(): Promise<void> {
    if (this.stopped) return;
    try {
      const url = `${this.endpoint}/v1/audio/transcriptions/stream`;
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Create session HTTP ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { session_id?: string };
      this.sessionId = data.session_id ?? null;
      if (this.sessionId) {
        // Start the feed timer
        this.feedTimer = setInterval(() => void this.flushAudio(), this.feedIntervalMs);
      }
    } catch (err) {
      console.error(
        "[mlx-streaming] Failed to create session:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async flushAudio(): Promise<void> {
    if (this.feeding || !this.sessionId || this.audioQueue.length === 0) return;
    this.feeding = true;

    try {
      // Concatenate queued chunks into one buffer
      const pcm = Buffer.concat(this.audioQueue);
      this.audioQueue = [];

      const url = `${this.endpoint}/v1/audio/transcriptions/stream/${this.sessionId}`;
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(pcm),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        const data = (await res.json()) as { text?: string };
        const text = data.text ?? "";
        if (text) {
          this.lastText = text;
          this.tokenCb?.(text);
        }
      } else if (res.status === 404) {
        // Stale session — MLX server likely restarted
        console.warn("[mlx-streaming] Session", this.sessionId, "not found (404), recreating");
        this.sessionId = null;
        if (this.feedTimer) {
          clearInterval(this.feedTimer);
          this.feedTimer = null;
        }
        await this.createSession();
      }
    } catch (err) {
      console.warn("[mlx-streaming] Feed error:", err instanceof Error ? err.message : String(err));
    } finally {
      this.feeding = false;
    }
  }
}

// ─── Factory ───

/**
 * Create an SttProvider from DictationConfig.
 * All providers return the same SttProvider interface —
 * HTTP batch providers are wrapped in HttpSttAdapter.
 */
export function createSttProvider(
  config: DictationConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): SttProvider {
  const providerType = config.sttProvider ?? "mlx-server";

  switch (providerType) {
    case "qwen_asr": {
      if (!config.sttBinary) {
        throw new Error(
          'qwen_asr provider requires "sttBinary" in asr config (path to qwen_asr binary)',
        );
      }
      if (!config.sttModelDir) {
        throw new Error(
          'qwen_asr provider requires "sttModelDir" in asr config (path to model directory)',
        );
      }
      return new QwenAsrProvider({
        binary: expandTilde(config.sttBinary),
        modelDir: expandTilde(config.sttModelDir),
      });
    }

    case "mlx-streaming":
      return new MlxStreamingSttProvider(
        {
          endpoint: config.sttEndpoint,
          model: config.sttModel,
        },
        fetchFn,
      );

    case "mlx-server":
      return new HttpSttAdapter(
        new MlxServerTranscriber(
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
        ),
        {
          retranscribeIntervalMs: config.retranscribeIntervalMs,
          maxDurationSec: config.maxDurationSec,
        },
      );

    case "openai":
      return new HttpSttAdapter(
        new OpenAiTranscriber(
          {
            endpoint: config.sttEndpoint,
            model: config.sttModel,
            apiKey: config.sttApiKey ?? "",
            language: config.sttLanguage,
            temperature: config.sttTemperature,
          },
          fetchFn,
        ),
        {
          retranscribeIntervalMs: config.retranscribeIntervalMs,
          maxDurationSec: config.maxDurationSec,
        },
      );

    case "deepgram":
      return new HttpSttAdapter(
        new DeepgramTranscriber(
          {
            endpoint: config.sttEndpoint,
            apiKey: config.sttApiKey ?? "",
            model: config.sttModel,
            language: config.sttLanguage,
          },
          fetchFn,
        ),
        {
          retranscribeIntervalMs: config.retranscribeIntervalMs,
          maxDurationSec: config.maxDurationSec,
        },
      );

    case "elevenlabs":
      return new HttpSttAdapter(
        new ElevenLabsTranscriber(
          {
            endpoint: config.sttEndpoint,
            apiKey: config.sttApiKey ?? "",
            model: config.sttModel,
            languageCode: config.sttLanguage,
          },
          fetchFn,
        ),
        {
          retranscribeIntervalMs: config.retranscribeIntervalMs,
          maxDurationSec: config.maxDurationSec,
        },
      );

    default:
      throw new Error(
        `Unknown STT provider: "${providerType}". ` +
          `Supported: mlx-streaming, qwen_asr, mlx-server, openai, deepgram, elevenlabs`,
      );
  }
}
