/**
 * Dictation pipeline manager.
 *
 * Handles per-connection lifecycle: audio accumulation for FLAC
 * preservation, forwarding audio to the SttProvider, relaying transcript
 * updates to the client, and audio archival.
 *
 * Final transcript correctness now lives in the upstream streaming STT
 * service (Yuwp segment-commit). Oppi forwards streaming updates and the
 * provider's final text instead of re-running a second whole-audio batch pass.
 *
 * All STT providers implement the same streaming interface (SttProvider).
 * DictationManager has one code path — no branching on provider type.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type {
  DictationConfig,
  DictationClientMessage,
  DictationServerMessage,
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

/** Initial audio buffer capacity (64 KB ≈ 2s of 16kHz mono 16-bit). */
const INITIAL_AUDIO_BUFFER_SIZE = 64 * 1024;

// ─── Per-connection session state ───

interface DictationSession {
  /** Accumulated raw PCM audio for FLAC preservation (amortized doubling). */
  audioBuffer: Buffer;
  /** Valid byte count within audioBuffer. */
  totalBytes: number;
  /** ISO timestamp when dictation started. */
  startedAt: string;
  /** High-res monotonic start time for latency measurement. */
  startHrMs: number;
  /** Set to true once dictation_stop is received. */
  stopping: boolean;
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

// ─── DictationManager ───

/** Callback for sending dictation responses through the transport layer. */
export type DictationSendFn = (msg: DictationServerMessage) => void;

export class DictationManager {
  private config: DictationConfig;
  private dataDir: string;

  private sttProvider: SttProvider;

  /** Optional metrics collector for pipeline telemetry. */
  private metrics: ServerMetricCollector | null;

  /** Active dictation session state. */
  private session: DictationSession | null = null;

  /** Callback for sending messages to the client. Set by handleControlMessage. */
  private sendFn: DictationSendFn | null = null;

  constructor(
    config: DictationConfig,
    dataDir: string,
    sttProvider: SttProvider,
    metrics?: ServerMetricCollector,
  ) {
    this.config = config;
    this.dataDir = dataDir;
    this.sttProvider = sttProvider;
    this.metrics = metrics ?? null;
  }

  // ─── Public API ───

  /** Handle a parsed dictation control message from the transport layer. */
  handleControlMessage(msg: DictationClientMessage, send: DictationSendFn): void {
    this.sendFn = send;

    switch (msg.type) {
      case "dictation_start":
        if (this.session) {
          this.send({
            type: "dictation_error",
            error: "Dictation already active",
            fatal: false,
          });
          return;
        }
        this.session = {
          audioBuffer: Buffer.alloc(INITIAL_AUDIO_BUFFER_SIZE),
          totalBytes: 0,
          startedAt: new Date().toISOString(),
          startHrMs: performance.now(),
          stopping: false,
        };
        this.startSession();
        break;

      case "dictation_stop":
        if (!this.session) {
          this.send({
            type: "dictation_error",
            error: "No active dictation session",
            fatal: false,
          });
          return;
        }
        this.session.stopping = true;
        {
          const sessionToFinalize = this.session;
          this.session = null;
          this.finalizeSession(sessionToFinalize);
        }
        break;

      case "dictation_cancel":
        if (this.session) {
          this.cancelSession();
          this.session = null;
        }
        break;

      default:
        this.send({
          type: "dictation_error",
          error: `Unknown message type: ${(msg as { type: string }).type}`,
          fatal: false,
        });
    }
  }

  /** Handle an incoming binary audio frame. */
  handleAudioData(buf: Buffer): void {
    if (!this.session) return;

    // Accumulate for FLAC preservation
    const needed = this.session.totalBytes + buf.length;
    if (needed > this.session.audioBuffer.length) {
      const newCap = Math.max(this.session.audioBuffer.length * 2, needed);
      const newBuf = Buffer.alloc(newCap);
      this.session.audioBuffer.copy(newBuf, 0, 0, this.session.totalBytes);
      this.session.audioBuffer = newBuf;
    }
    buf.copy(this.session.audioBuffer, this.session.totalBytes);
    this.session.totalBytes += buf.length;

    // Feed to STT provider
    this.sttProvider.feedAudio(buf);
  }

  /** Clean up on transport disconnect. */
  handleDisconnect(): void {
    if (this.session) {
      this.cancelSession();
      this.session = null;
    }
    this.sendFn = null;
  }

  // ─── Private send ───

  /** Send a dictation message through the stored transport callback. */
  private send(msg: DictationServerMessage): void {
    this.sendFn?.(msg);
  }

  // ─── Session lifecycle ───

  private startSession(): void {
    // Start the STT provider (async — validates backend is reachable).
    // Only send dictation_ready after the session is confirmed.
    void this.startSttAndSignalReady();
  }

  private async startSttAndSignalReady(): Promise<void> {
    try {
      await this.sttProvider.start();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[stt] Failed to start session:", errorMsg);
      this.send({
        type: "dictation_error",
        error: `STT failed to start: ${errorMsg}`,
        fatal: true,
      });
      // Clear the session so the manager knows dictation is not active
      this.session = null;
      return;
    }

    // STT session is confirmed — now tell the client
    this.send({
      type: "dictation_ready",
      sttProvider: this.sttProvider.name,
      sttModel: this.sttProvider.model,
    });

    // Forward transcript updates to the client
    this.sttProvider.onToken((text: string, opts?: { snap?: boolean }) => {
      if (!this.session || this.session.stopping) return;
      this.send({
        type: "dictation_result",
        text,
        ...(opts?.snap ? { snap: true } : {}),
      });
    });
  }

  private cancelSession(): void {
    void this.sttProvider.stop().catch(() => {});
  }

  private async finalizeSession(session: DictationSession): Promise<void> {
    const finalizeT0 = performance.now();
    const langTag = "auto";

    // Emit session-level metrics
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

    if (session.totalBytes === 0) {
      await this.sttProvider.stop().catch(() => {});
      this.send({ type: "dictation_final", text: "" });
      return;
    }

    // Final STT — close audio stream, get final text
    const audioSeconds = session.totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE * NUM_CHANNELS);
    let text: string;
    let finalSttMs = 0;
    const sttT0 = performance.now();
    try {
      text = await this.sttProvider.stop();
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
      this.send({ type: "dictation_error", error: `STT failed: ${errorMsg}`, fatal: true });
      return;
    }

    // Audio preservation
    // Segment-commit Yuwp already batch-corrects on pause/finalize, so the
    // provider's final text is the source of truth.
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
        audioSaveMs: 0,
        finalizeMs: 0,
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

    const finalizeMs = Math.round(performance.now() - finalizeT0);
    this.metrics?.record(
      "server.dictation_finalize_ms",
      finalizeMs,
      this.metricTags({ language: langTag }),
    );

    this.send({
      type: "dictation_final",
      text,
      ...(audioId !== undefined ? { audioId } : {}),
    });
  }

  // ─── Metrics ───

  private metricTags(extra: Record<string, string>): Record<string, string> {
    return {
      provider_id: `stt_${this.sttProvider.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
      stt_backend: this.sttProvider.name,
      model: this.sttProvider.model,
      ...extra,
    };
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

    let audioPath: string;
    try {
      const flacData = await encodeFlac(wav);
      audioPath = join(dir, `${audioId}.flac`);
      await writeFile(audioPath, flacData);
    } catch {
      audioPath = join(dir, `${audioId}.wav`);
      await writeFile(audioPath, wav);
    }

    const durationMs = Math.round(
      (session.totalBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE * NUM_CHANNELS)) * 1000,
    );
    const sttEndpoint =
      "endpoint" in this.sttProvider
        ? (this.sttProvider as { endpoint: string }).endpoint
        : "local";
    const metadata: DictationAudioMetadata = {
      audioId,
      startedAt: session.startedAt,
      durationMs,
      sampleRate: SAMPLE_RATE,
      transcript,
      model: this.sttProvider.model,
      sttEndpoint,
      ...(timing ? { timing } : {}),
    };
    await writeFile(join(dir, `${audioId}.json`), JSON.stringify(metadata, null, 2));

    return audioId;
  }
}

// ─── Helpers ───

/**
 * Encode WAV buffer to FLAC via ffmpeg subprocess.
 */
export async function encodeFlac(wavBuffer: Buffer): Promise<Buffer> {
  // Write to a temp file instead of stdout so ffmpeg can seek back and write
  // the correct total_samples into the FLAC STREAMINFO block. Piping to
  // stdout produces FLAC with a corrupt STREAMINFO (wrong sample_rate /
  // total_samples) because ffmpeg cannot seek on a non-seekable pipe.
  const tmp = join("/tmp", `oppi_flac_${randomBytes(6).toString("hex")}.flac`);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "ffmpeg",
        ["-i", "pipe:0", "-f", "flac", "-compression_level", "5", "-y", tmp],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      proc.on("close", (code) => {
        if (code !== 0) reject(new Error(`ffmpeg exited with code ${code}`));
        else resolve();
      });
      proc.on("error", reject);
      proc.stdin.write(wavBuffer);
      proc.stdin.end();
    });
    return await readFile(tmp);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
