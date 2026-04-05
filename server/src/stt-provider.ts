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

// ─── Interface ───

/**
 * Streaming STT provider. Audio is piped incrementally and transcript
 * updates arrive via callback as they're produced.
 *
 * Lifecycle: start() → feedAudio()* → onToken() callbacks → stop() → final text
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

/** Resolve ~ to home directory in paths. */
function expandTilde(p: string): string {
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
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
 * Supported providers: mlx-streaming (default), qwen_asr.
 */
export function createSttProvider(
  config: DictationConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): SttProvider {
  const providerType = config.sttProvider ?? "mlx-streaming";

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

    default:
      throw new Error(
        `Unknown STT provider: "${providerType}". Supported: mlx-streaming, qwen_asr`,
      );
  }
}
