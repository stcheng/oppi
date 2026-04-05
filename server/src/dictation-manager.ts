/**
 * Dictation pipeline manager.
 *
 * Handles per-WS-connection audio accumulation, adaptive retranscription,
 * HTTP proxy to a configurable STT backend, optional LLM post-correction,
 * and lossless audio preservation.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { WebSocket, RawData } from "ws";
import type {
  DictationConfig,
  DictationClientMessage,
  DictationServerMessage,
  DictationDictionary,
  DictationAudioMetadata,
} from "./dictation-types.js";
import type { SttProvider } from "./stt-provider.js";
import type { ServerMetricCollector } from "./server-metric-collector.js";

// ─── Constants ───

/** PCM audio format: 16-bit signed, 16kHz, mono. */
const SAMPLE_RATE = 16000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

/** Adaptive retranscribe thresholds (seconds of audio -> interval ms). */
const ADAPTIVE_THRESHOLDS: Array<{ maxSeconds: number; intervalMs: number }> = [
  { maxSeconds: 30, intervalMs: 2000 },
  { maxSeconds: 60, intervalMs: 4000 },
  { maxSeconds: 120, intervalMs: 6000 },
  { maxSeconds: Infinity, intervalMs: 12000 },
];

/** Initial audio buffer capacity (64 KB ≈ 2s of 16kHz mono 16-bit). */
const INITIAL_AUDIO_BUFFER_SIZE = 64 * 1024;

// ─── Per-connection session state ───

interface DictationSession {
  /** Accumulated raw PCM audio (pre-concatenated, grows via amortized doubling). */
  audioBuffer: Buffer;
  /** Valid byte count within audioBuffer. */
  totalBytes: number;
  /** Retranscribe timer handle. */
  timer: ReturnType<typeof setInterval> | null;
  /** Monotonic version counter for dictation_result ordering. */
  version: number;
  /** ISO timestamp when dictation started. */
  startedAt: string;
  /** High-res monotonic start time for latency measurement. */
  startHrMs: number;
  /** Language hint from client. */
  language?: string;
  /** Whether a retranscribe request is in flight (prevents overlap). */
  inflight: boolean;
  /** Set to true once dictation_stop is received. */
  stopping: boolean;
  /** Count of retranscribe ticks that actually fired an STT call. */
  retranscribeCount: number;
}

// ─── WAV encoding ───

/**
 * Encode raw PCM samples as a WAV file (RIFF header + data).
 * 16-bit signed, 16kHz, mono, little-endian.
 */
export function encodeWav(pcmChunks: Buffer[]): Buffer {
  const dataLength = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(44);

  const byteRate = SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = NUM_CHANNELS * BYTES_PER_SAMPLE;

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4); // file size - 8
  header.write("WAVE", 8);

  // fmt sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // sub-chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // data sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, ...pcmChunks]);
}

/** Create a 44-byte WAV header for the given PCM data length (no data copy). */
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
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

// ─── Adaptive interval ───

/** Return the retranscribe interval for the given audio duration in seconds. */
export function adaptiveInterval(audioSeconds: number, baseIntervalMs: number): number {
  for (const threshold of ADAPTIVE_THRESHOLDS) {
    if (audioSeconds < threshold.maxSeconds) {
      // Scale relative to the base interval (default 2000ms)
      const scale = threshold.intervalMs / 2000;
      return Math.round(baseIntervalMs * scale);
    }
  }
  return baseIntervalMs * 6; // fallback: 6x base
}

// ─── DictationManager ───

export class DictationManager {
  private config: DictationConfig;
  private dataDir: string;
  private dictionary: DictationDictionary = { corrections: {}, domain_terms: [] };
  private dictionaryPath: string;
  private dictionaryLoaded = false;

  /** STT provider (owns HTTP call, auth, response parsing). */
  private sttProvider: SttProvider;

  /** Injected fetch — used for LLM correction calls. */
  private fetchFn: typeof globalThis.fetch;

  /** Optional metrics collector for pipeline telemetry. */
  private metrics: ServerMetricCollector | null;

  constructor(
    config: DictationConfig,
    dataDir: string,
    sttProvider: SttProvider,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    metrics?: ServerMetricCollector,
  ) {
    this.config = config;
    this.dataDir = dataDir;
    this.dictionaryPath = join(dataDir, "dictation", "dictionary.json");
    this.sttProvider = sttProvider;
    this.fetchFn = fetchFn;
    this.metrics = metrics ?? null;
  }

  // ─── Public API ───

  /** Wire up message/binary/close handlers on a newly upgraded /dictation WS. */
  handleConnection(ws: WebSocket): void {
    let session: DictationSession | null = null;

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        // Binary frame = raw PCM audio
        if (!session) return; // Ignore audio before dictation_start
        const buf = toBuffer(data);
        const needed = session.totalBytes + buf.length;
        if (needed > session.audioBuffer.length) {
          const newCap = Math.max(session.audioBuffer.length * 2, needed);
          const newBuf = Buffer.alloc(newCap);
          session.audioBuffer.copy(newBuf, 0, 0, session.totalBytes);
          session.audioBuffer = newBuf;
        }
        buf.copy(session.audioBuffer, session.totalBytes);
        session.totalBytes += buf.length;
        return;
      }

      // Text frame = JSON control message
      let msg: DictationClientMessage;
      try {
        msg = JSON.parse(toBuffer(data).toString("utf8")) as DictationClientMessage;
      } catch {
        sendMessage(ws, { type: "dictation_error", error: "Invalid JSON", fatal: false });
        return;
      }

      switch (msg.type) {
        case "dictation_start":
          if (session) {
            sendMessage(ws, {
              type: "dictation_error",
              error: "Dictation already active",
              fatal: false,
            });
            return;
          }
          session = {
            audioBuffer: Buffer.alloc(INITIAL_AUDIO_BUFFER_SIZE),
            totalBytes: 0,
            timer: null,
            version: 0,
            startedAt: new Date().toISOString(),
            startHrMs: performance.now(),
            language: msg.language,
            inflight: false,
            stopping: false,
            retranscribeCount: 0,
          };
          this.startSession(ws, session);
          break;

        case "dictation_stop":
          if (!session) {
            sendMessage(ws, {
              type: "dictation_error",
              error: "No active dictation session",
              fatal: false,
            });
            return;
          }
          session.stopping = true;
          this.finalizeSession(ws, session);
          session = null;
          break;

        case "dictation_cancel":
          if (session) {
            this.cancelSession(session);
            session = null;
          }
          break;

        default:
          sendMessage(ws, {
            type: "dictation_error",
            error: `Unknown message type: ${(msg as { type: string }).type}`,
            fatal: false,
          });
      }
    });

    ws.on("close", () => {
      if (session) {
        this.cancelSession(session);
        session = null;
      }
    });

    ws.on("error", () => {
      if (session) {
        this.cancelSession(session);
        session = null;
      }
    });
  }

  // ─── Session lifecycle ───

  private startSession(ws: WebSocket, session: DictationSession): void {
    // Load dictionary on first use
    void this.ensureDictionary();

    sendMessage(ws, {
      type: "dictation_ready",
      sttProvider: this.sttProvider.name,
      sttModel: this.sttProvider.model,
      llmCorrectionEnabled: this.config.llmCorrectionEnabled,
    });

    // Start retranscribe timer
    this.scheduleRetranscribe(ws, session);
  }

  private scheduleRetranscribe(ws: WebSocket, session: DictationSession): void {
    if (session.timer) clearInterval(session.timer);

    const audioSeconds = session.totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE * NUM_CHANNELS);
    const intervalMs = adaptiveInterval(audioSeconds, this.config.retranscribeIntervalMs);

    session.timer = setInterval(() => {
      if (session.stopping) return;

      // Re-schedule with updated interval if audio grew past a threshold
      const currentSeconds = session.totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE * NUM_CHANNELS);
      const newInterval = adaptiveInterval(currentSeconds, this.config.retranscribeIntervalMs);
      if (newInterval !== intervalMs) {
        this.scheduleRetranscribe(ws, session);
      }

      // Check max duration
      if (this.config.maxDurationSec > 0 && currentSeconds >= this.config.maxDurationSec) {
        session.stopping = true;
        sendMessage(ws, {
          type: "dictation_error",
          error: `Max duration reached (${this.config.maxDurationSec}s)`,
          fatal: true,
        });
        this.finalizeSession(ws, session);
        return;
      }

      void this.retranscribe(ws, session);
    }, intervalMs);
  }

  private cancelSession(session: DictationSession): void {
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }
  }

  private async finalizeSession(ws: WebSocket, session: DictationSession): Promise<void> {
    const finalizeT0 = performance.now();
    const langTag = session.language ?? "unknown";

    if (session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }

    // Emit session-level metrics regardless of outcome
    const sessionMs = Math.round(performance.now() - session.startHrMs);
    const audioDurationMs = Math.round(
      (session.totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE * NUM_CHANNELS)) * 1000,
    );
    this.metrics?.record(
      "server.dictation_session_ms",
      sessionMs,
      this.metricTags({ language: langTag }),
    );
    this.metrics?.record(
      "server.dictation_audio_duration_ms",
      audioDurationMs,
      this.metricTags({ language: langTag }),
    );
    this.metrics?.record(
      "server.dictation_retranscribe_count",
      session.retranscribeCount,
      this.metricTags({ language: langTag }),
    );

    if (session.totalBytes === 0) {
      sendMessage(ws, { type: "dictation_final", text: "" });
      return;
    }

    // Final STT transcription
    const audioSeconds = session.totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE * NUM_CHANNELS);
    let text: string;
    let finalSttMs = 0;
    const sttT0 = performance.now();
    try {
      text = await this.callStt(session);
      finalSttMs = Math.round(performance.now() - sttT0);
      this.metrics?.record(
        "server.dictation_stt_ms",
        finalSttMs,
        this.metricTags({
          phase: "finalize",
          audio_seconds: String(Math.round(audioSeconds)),
          language: langTag,
        }),
      );
      if (audioSeconds > 0) {
        this.metrics?.record(
          "server.dictation_stt_audio_ratio",
          Math.round((finalSttMs / (audioSeconds * 1000)) * 100) / 100,
          this.metricTags({ phase: "finalize", language: langTag }),
        );
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.metrics?.record(
        "server.dictation_error",
        1,
        this.metricTags({ phase: "stt", fatal: "true", error_kind: "stt", language: langTag }),
      );
      sendMessage(ws, { type: "dictation_error", error: `STT failed: ${errorMsg}`, fatal: true });
      return;
    }

    // Optional LLM correction
    let uncorrected: string | undefined;
    let llmCorrectionMs = 0;
    if (this.config.llmCorrectionEnabled && text.trim().length > 0) {
      const llmT0 = performance.now();
      try {
        const corrected = await this.correctWithLlm(text);
        llmCorrectionMs = Math.round(performance.now() - llmT0);
        const changed = corrected !== null && corrected !== undefined && corrected !== text;
        this.metrics?.record(
          "server.dictation_llm_correction_ms",
          llmCorrectionMs,
          this.metricTags({
            changed: String(changed),
            llm_model: this.config.llmModel,
            language: langTag,
          }),
        );
        if (changed) {
          uncorrected = text;
          text = corrected;
        }
      } catch (err) {
        llmCorrectionMs = Math.round(performance.now() - llmT0);
        this.metrics?.record(
          "server.dictation_error",
          1,
          this.metricTags({ phase: "llm", fatal: "false", error_kind: "llm", language: langTag }),
        );
        this.metrics?.record(
          "server.dictation_llm_correction_ms",
          llmCorrectionMs,
          this.metricTags({ changed: "error", llm_model: this.config.llmModel, language: langTag }),
        );
        // LLM failure is non-fatal — use raw ASR text
        console.warn(
          "[dictation] LLM correction failed, using raw ASR:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Audio preservation
    let audioId: string | undefined;
    let audioSaveMs = 0;
    if (this.config.preserveAudio) {
      const saveT0 = performance.now();
      const sttRtf =
        audioDurationMs > 0 ? Math.round((finalSttMs / audioDurationMs) * 100) / 100 : 0;
      const timing: DictationAudioMetadata["timing"] = {
        sessionMs,
        finalSttMs,
        sttRealTimeFactor: sttRtf,
        llmCorrectionMs,
        audioSaveMs: 0, // updated after save completes
        finalizeMs: 0, // updated after save completes
        retranscribeCount: session.retranscribeCount,
      };
      try {
        audioId = await this.saveAudio(session, text, timing);
        audioSaveMs = Math.round(performance.now() - saveT0);
        this.metrics?.record(
          "server.dictation_audio_save_ms",
          audioSaveMs,
          this.metricTags({ language: langTag }),
        );
      } catch (err) {
        this.metrics?.record(
          "server.dictation_error",
          1,
          this.metricTags({ phase: "save", fatal: "false", error_kind: "save", language: langTag }),
        );
        console.warn("[dictation] Audio save failed:", err instanceof Error ? err.message : err);
      }
    }

    // Total finalize duration
    const finalizeMs = Math.round(performance.now() - finalizeT0);
    this.metrics?.record(
      "server.dictation_finalize_ms",
      finalizeMs,
      this.metricTags({ language: langTag }),
    );

    sendMessage(ws, {
      type: "dictation_final",
      text,
      ...(uncorrected !== undefined ? { uncorrected } : {}),
      ...(audioId !== undefined ? { audioId } : {}),
    });
  }

  // ─── STT proxy ───

  private async retranscribe(ws: WebSocket, session: DictationSession): Promise<void> {
    if (session.inflight) {
      this.metrics?.record(
        "server.dictation_retranscribe_skip",
        1,
        this.metricTags({ reason: "inflight", language: session.language ?? "unknown" }),
      );
      return;
    }
    if (session.totalBytes === 0) {
      this.metrics?.record(
        "server.dictation_retranscribe_skip",
        1,
        this.metricTags({ reason: "empty", language: session.language ?? "unknown" }),
      );
      return;
    }
    session.inflight = true;
    session.retranscribeCount++;

    const audioSeconds = session.totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE * NUM_CHANNELS);
    const t0 = performance.now();
    try {
      const text = await this.callStt(session);
      const sttMs = Math.round(performance.now() - t0);
      this.metrics?.record(
        "server.dictation_stt_ms",
        sttMs,
        this.metricTags({
          phase: "retranscribe",
          audio_seconds: String(Math.round(audioSeconds)),
          language: session.language ?? "unknown",
        }),
      );
      if (audioSeconds > 0) {
        this.metrics?.record(
          "server.dictation_stt_audio_ratio",
          Math.round((sttMs / (audioSeconds * 1000)) * 100) / 100,
          this.metricTags({ phase: "retranscribe", language: session.language ?? "unknown" }),
        );
      }
      session.version++;
      sendMessage(ws, { type: "dictation_result", text, version: session.version });
    } catch (err) {
      this.metrics?.record(
        "server.dictation_error",
        1,
        this.metricTags({
          phase: "stt",
          fatal: "false",
          error_kind: "stt",
          language: session.language ?? "unknown",
        }),
      );
      sendMessage(ws, {
        type: "dictation_error",
        error: `STT error: ${err instanceof Error ? err.message : String(err)}`,
        fatal: false,
      });
    } finally {
      session.inflight = false;
    }
  }

  private metricTags(extra: Record<string, string>): Record<string, string> {
    return {
      provider_id: this.providerId(),
      provider_kind: this.providerKind(),
      stt_backend: this.sttProvider.name,
      model: this.sttProvider.model,
      ...extra,
    };
  }

  private providerKind(): string {
    return this.sttProvider.name === "mlx-server" ? "local_server" : "cloud";
  }

  private providerId(): string {
    switch (this.sttProvider.name) {
      case "mlx-server":
        return "oppi_mlx_server";
      case "openai":
        return "openai_stt";
      case "deepgram":
        return "deepgram_stt";
      case "elevenlabs":
        return "elevenlabs_stt";
      default:
        return `stt_${this.sttProvider.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    }
  }

  /** Encode accumulated audio and send to the STT provider. */
  async callStt(session: DictationSession): Promise<string> {
    const pcm = session.audioBuffer.subarray(0, session.totalBytes);
    const wav = Buffer.concat([makeWavHeader(session.totalBytes), pcm]);
    return this.sttProvider.transcribe(wav);
  }

  // ─── LLM correction ───

  /** Run transcript through LLM for correction and dictionary maintenance. */
  async correctWithLlm(rawText: string): Promise<string | null> {
    const dictTerms =
      Object.entries(this.dictionary.corrections)
        .map(([from, to]) => `"${from}" -> "${to}"`)
        .concat(this.dictionary.domain_terms.map((t) => `"${t}"`))
        .join(", ") || "none";

    const prompt = [
      "Fix ASR errors only. Never censor, rephrase, or remove profanity. Preserve all languages verbatim.",
      "Return JSON: {corrected, new_corrections: [{original, corrected}], new_terms: []}",
      `Dictionary: ${dictTerms}`,
      `Raw: "${rawText}"`,
    ].join("\n");

    const url = `${this.config.llmEndpoint}/v1/chat/completions`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.llmModel,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LLM HTTP ${response.status}: ${body}`);
    }

    const completion = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = completion.choices?.[0]?.message?.content;
    if (!content) return null;

    // Parse JSON from the LLM response — handle markdown code fences
    const jsonStr = extractJsonFromResponse(content);
    let parsed: {
      corrected?: string;
      new_corrections?: Array<{ original: string; corrected: string }>;
      new_terms?: string[];
    };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      console.warn("[dictation] LLM returned non-JSON:", content.slice(0, 200));
      return null;
    }

    // Merge new corrections and terms into dictionary
    if (parsed.new_corrections?.length || parsed.new_terms?.length) {
      if (parsed.new_corrections) {
        for (const c of parsed.new_corrections) {
          if (c.original && c.corrected) {
            this.dictionary.corrections[c.original.toLowerCase()] = c.corrected;
          }
        }
      }
      if (parsed.new_terms) {
        const existing = new Set(this.dictionary.domain_terms);
        for (const term of parsed.new_terms) {
          if (term && !existing.has(term)) {
            this.dictionary.domain_terms.push(term);
            existing.add(term);
          }
        }
      }
      void this.saveDictionary();
    }

    return typeof parsed.corrected === "string" ? parsed.corrected : null;
  }

  // ─── Dictionary ───

  private async ensureDictionary(): Promise<void> {
    if (this.dictionaryLoaded) return;
    this.dictionaryLoaded = true;

    try {
      const raw = await readFile(this.dictionaryPath, "utf-8");
      const parsed = JSON.parse(raw) as DictationDictionary;
      if (parsed.corrections) this.dictionary.corrections = parsed.corrections;
      if (parsed.domain_terms) this.dictionary.domain_terms = parsed.domain_terms;
    } catch {
      // No dictionary yet — start fresh
    }
  }

  private async saveDictionary(): Promise<void> {
    try {
      const dir = join(this.dataDir, "dictation");
      await mkdir(dir, { recursive: true });
      await writeFile(this.dictionaryPath, JSON.stringify(this.dictionary, null, 2));
    } catch (err) {
      console.warn(
        "[dictation] Failed to save dictionary:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── Audio preservation ───

  private async saveAudio(
    session: DictationSession,
    transcript: string,
    timing?: DictationAudioMetadata["timing"],
  ): Promise<string> {
    const audioId = `dict_${randomBytes(8).toString("hex")}`;
    const now = new Date(session.startedAt);
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");

    const dir = join(this.dataDir, "dictation", year, month, day);
    await mkdir(dir, { recursive: true });

    const pcm = session.audioBuffer.subarray(0, session.totalBytes);
    const wav = Buffer.concat([makeWavHeader(session.totalBytes), pcm]);

    // Try FLAC via ffmpeg, fall back to WAV
    let audioPath: string;
    try {
      const flacData = await encodeFlac(wav);
      audioPath = join(dir, `${audioId}.flac`);
      await writeFile(audioPath, flacData);
    } catch {
      audioPath = join(dir, `${audioId}.wav`);
      await writeFile(audioPath, wav);
    }

    // Save metadata
    const durationMs = Math.round(
      (session.totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE * NUM_CHANNELS)) * 1000,
    );
    const metadata: DictationAudioMetadata = {
      audioId,
      startedAt: session.startedAt,
      durationMs,
      sampleRate: SAMPLE_RATE,
      transcript,
      language: session.language,
      model: this.sttProvider.model,
      sttEndpoint: this.sttProvider.endpoint,
      ...(timing ? { timing } : {}),
    };
    await writeFile(join(dir, `${audioId}.json`), JSON.stringify(metadata, null, 2));

    return audioId;
  }
}

// ─── Helpers ───

function sendMessage(ws: WebSocket, msg: DictationServerMessage): void {
  if (ws.readyState === 1 /* WebSocket.OPEN */) {
    ws.send(JSON.stringify(msg));
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Extract JSON from an LLM response that may be wrapped in markdown code fences
 * or prefixed with chain-of-thought text.
 */
export function extractJsonFromResponse(content: string): string {
  // Try to extract from ```json ... ``` blocks
  const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find a JSON object directly
  const braceStart = content.indexOf("{");
  const braceEnd = content.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    return content.slice(braceStart, braceEnd + 1);
  }

  // Return as-is and let JSON.parse fail with a clear error
  return content;
}

/**
 * Encode WAV buffer to FLAC via ffmpeg subprocess.
 * Resolves with the FLAC buffer, rejects if ffmpeg is unavailable.
 */
function encodeFlac(wavBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "ffmpeg",
      ["-i", "pipe:0", "-f", "flac", "-compression_level", "5", "pipe:1"],
      { maxBuffer: 50 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(Buffer.from(stdout, "binary"));
      },
    );
    proc.stdin?.write(wavBuffer);
    proc.stdin?.end();
  });
}
