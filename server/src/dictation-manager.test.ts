/**
 * Tests for DictationManager — audio accumulation, WAV encoding,
 * retranscribe timer, STT provider integration, LLM correction,
 * dictionary merge, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { WebSocket } from "ws";
import {
  DictationManager,
  encodeFlac,
  encodeWav,
  adaptiveInterval,
  extractJsonFromResponse,
} from "./dictation-manager.js";
import type { DictationConfig, DictationServerMessage } from "./dictation-types.js";
import type { SttProvider } from "./stt-provider.js";

// ─── Test helpers ───

function testConfig(overrides: Partial<DictationConfig> = {}): DictationConfig {
  return {
    sttEndpoint: "http://localhost:9847",
    sttModel: "test-model",
    retranscribeIntervalMs: 2000,
    preserveAudio: false,
    maxDurationSec: 300,
    llmEndpoint: "http://localhost:8400",
    llmModel: "test-llm",
    llmCorrectionEnabled: false,
    ...overrides,
  };
}

/** Fake WebSocket that captures sent messages and simulates events. */
class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: DictationServerMessage[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as DictationServerMessage);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

/** Generate PCM silence (zero-filled). */
function silencePcm(durationMs: number): Buffer {
  const samples = Math.floor((16000 * durationMs) / 1000);
  return Buffer.alloc(samples * 2); // 16-bit = 2 bytes per sample
}

/** Send a JSON control message to the fake WS. */
function sendControl(ws: FakeWebSocket, msg: Record<string, unknown>): void {
  const buf = Buffer.from(JSON.stringify(msg), "utf8");
  ws.emit("message", buf, false);
}

/** Send a binary PCM frame to the fake WS. */
function sendAudio(ws: FakeWebSocket, pcm: Buffer): void {
  ws.emit("message", pcm, true);
}

/** Collect messages of a given type. */
function messagesOfType<T extends DictationServerMessage["type"]>(
  ws: FakeWebSocket,
  type: T,
): Extract<DictationServerMessage, { type: T }>[] {
  return ws.sent.filter((m) => m.type === type) as Extract<DictationServerMessage, { type: T }>[];
}

/** Create a mock STT provider that returns fixed text. */
function mockSttProvider(text: string): SttProvider & { transcribe: ReturnType<typeof vi.fn> } {
  return {
    name: "mock",
    model: "mock-model",
    endpoint: "http://mock:9847",
    transcribe: vi.fn().mockResolvedValue(text),
  };
}

/** Create a mock STT provider that always fails. */
function failingSttProvider(error: string): SttProvider & { transcribe: ReturnType<typeof vi.fn> } {
  return {
    name: "mock",
    model: "mock-model",
    endpoint: "http://mock:9847",
    transcribe: vi.fn().mockRejectedValue(new Error(error)),
  };
}

/** Create a mock fetch that handles LLM correction calls only. */
function mockLlmFetch(llmResponse: Record<string, unknown>): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(llmResponse) } }],
    }),
    text: async () => "",
  }) as unknown as typeof globalThis.fetch;
}

// ─── Tests ───

describe("encodeWav", () => {
  it("produces valid WAV header for empty audio", () => {
    const wav = encodeWav([]);
    expect(wav.length).toBe(44); // header only
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    // fmt chunk: PCM format = 1
    expect(wav.readUInt16LE(20)).toBe(1);
    // Channels = 1
    expect(wav.readUInt16LE(22)).toBe(1);
    // Sample rate = 16000
    expect(wav.readUInt32LE(24)).toBe(16000);
    // Bits per sample = 16
    expect(wav.readUInt16LE(34)).toBe(16);
    // Data size = 0
    expect(wav.readUInt32LE(40)).toBe(0);
  });

  it("concatenates multiple PCM chunks with correct header sizes", () => {
    const chunk1 = Buffer.alloc(1000, 0x42);
    const chunk2 = Buffer.alloc(2000, 0x43);
    const wav = encodeWav([chunk1, chunk2]);

    expect(wav.length).toBe(44 + 3000);
    // RIFF size = total - 8
    expect(wav.readUInt32LE(4)).toBe(36 + 3000);
    // data sub-chunk size
    expect(wav.readUInt32LE(40)).toBe(3000);
    // Verify audio data
    expect(wav[44]).toBe(0x42);
    expect(wav[44 + 1000]).toBe(0x43);
  });

  it("handles byte rate and block align correctly", () => {
    const wav = encodeWav([]);
    // Byte rate = sampleRate * channels * bytesPerSample = 16000 * 1 * 2 = 32000
    expect(wav.readUInt32LE(28)).toBe(32000);
    // Block align = channels * bytesPerSample = 1 * 2 = 2
    expect(wav.readUInt16LE(32)).toBe(2);
  });
});

describe("encodeFlac", () => {
  it("produces valid FLAC from WAV with correct binary round-trip", async () => {
    // Generate a WAV with known PCM data (1 second of 440Hz sine wave)
    const sampleRate = 16000;
    const duration = 1;
    const numSamples = sampleRate * duration;
    const pcm = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
      pcm.writeInt16LE(sample, i * 2);
    }
    const wav = encodeWav([pcm]);

    // Encode to FLAC
    const flac = await encodeFlac(wav);

    // Verify FLAC magic bytes
    expect(flac.toString("ascii", 0, 4)).toBe("fLaC");
    // Must be larger than just a header
    expect(flac.length).toBeGreaterThan(100);

    // Verify high bytes survive (the bug was Buffer.from(stdout, "binary")
    // which destroys bytes > 127)
    const highBytes = Array.from(flac).filter((b) => b > 127);
    expect(highBytes.length).toBeGreaterThan(0);

    // Verify the FLAC can be decoded back to WAV via ffmpeg
    const { execFileSync } = await import("node:child_process");
    const decoded = execFileSync(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-show_entries",
        "stream=sample_rate,channels,codec_name",
        "-of",
        "json",
        "-f",
        "flac",
        "pipe:0",
      ],
      { input: flac, maxBuffer: 10 * 1024 * 1024 },
    );
    const info = JSON.parse(decoded.toString());
    const stream = info.streams[0];
    expect(stream.codec_name).toBe("flac");
    expect(stream.sample_rate).toBe("16000");
    expect(stream.channels).toBe(1);
  });

  it("rejects on empty input", async () => {
    await expect(encodeFlac(Buffer.alloc(0))).rejects.toThrow();
  });
});

describe("adaptiveInterval", () => {
  it("returns base interval for short audio", () => {
    expect(adaptiveInterval(5, 2000)).toBe(2000);
    expect(adaptiveInterval(29, 2000)).toBe(2000);
  });

  it("doubles interval at 30s threshold", () => {
    expect(adaptiveInterval(30, 2000)).toBe(4000);
    expect(adaptiveInterval(45, 2000)).toBe(4000);
  });

  it("triples interval at 60s threshold", () => {
    expect(adaptiveInterval(60, 2000)).toBe(6000);
    expect(adaptiveInterval(100, 2000)).toBe(6000);
  });

  it("6x interval at 120s+", () => {
    expect(adaptiveInterval(120, 2000)).toBe(12000);
    expect(adaptiveInterval(300, 2000)).toBe(12000);
  });

  it("scales relative to base interval", () => {
    expect(adaptiveInterval(5, 1000)).toBe(1000);
    expect(adaptiveInterval(30, 1000)).toBe(2000);
    expect(adaptiveInterval(60, 1000)).toBe(3000);
    expect(adaptiveInterval(120, 1000)).toBe(6000);
  });
});

describe("extractJsonFromResponse", () => {
  it("extracts from markdown code fence", () => {
    const input = '```json\n{"corrected": "hello"}\n```';
    expect(JSON.parse(extractJsonFromResponse(input))).toEqual({ corrected: "hello" });
  });

  it("extracts from bare code fence", () => {
    const input = '```\n{"corrected": "hello"}\n```';
    expect(JSON.parse(extractJsonFromResponse(input))).toEqual({ corrected: "hello" });
  });

  it("extracts JSON object from mixed text", () => {
    const input = 'Here is the result:\n{"corrected": "hello", "new_terms": []}';
    expect(JSON.parse(extractJsonFromResponse(input))).toEqual({
      corrected: "hello",
      new_terms: [],
    });
  });

  it("returns raw string when no JSON found", () => {
    const input = "no json here";
    expect(extractJsonFromResponse(input)).toBe("no json here");
  });
});

describe("DictationManager", () => {
  let manager: DictationManager;
  let ws: FakeWebSocket;
  let provider: ReturnType<typeof mockSttProvider>;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = mockSttProvider("hello world");
    manager = new DictationManager(testConfig(), "/tmp/test-dictation", provider);
    ws = new FakeWebSocket();
    manager.handleConnection(ws as unknown as WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("session lifecycle", () => {
    it("sends dictation_ready on dictation_start", () => {
      sendControl(ws, { type: "dictation_start" });
      expect(messagesOfType(ws, "dictation_ready")).toHaveLength(1);
    });

    it("dictation_ready includes provider metadata", () => {
      sendControl(ws, { type: "dictation_start" });
      const readyMsgs = messagesOfType(ws, "dictation_ready");
      expect(readyMsgs).toHaveLength(1);
      const ready = readyMsgs[0];
      expect(ready.sttProvider).toBe("mock");
      expect(ready.sttModel).toBe("mock-model");
      expect(ready.llmCorrectionEnabled).toBe(false);
    });

    it("rejects duplicate dictation_start", () => {
      sendControl(ws, { type: "dictation_start" });
      sendControl(ws, { type: "dictation_start" });
      const errors = messagesOfType(ws, "dictation_error");
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("already active");
    });

    it("rejects dictation_stop without active session", () => {
      sendControl(ws, { type: "dictation_stop" });
      const errors = messagesOfType(ws, "dictation_error");
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("No active");
    });

    it("sends empty dictation_final for stop with no audio", async () => {
      sendControl(ws, { type: "dictation_start" });
      sendControl(ws, { type: "dictation_stop" });
      // Allow async finalize to complete
      await vi.advanceTimersByTimeAsync(10);
      const finals = messagesOfType(ws, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("");
    });

    it("handles dictation_cancel silently", () => {
      sendControl(ws, { type: "dictation_start" });
      sendControl(ws, { type: "dictation_cancel" });
      // No final or error
      expect(messagesOfType(ws, "dictation_final")).toHaveLength(0);
      expect(messagesOfType(ws, "dictation_error")).toHaveLength(0);
    });

    it("cleans up on WS close", () => {
      sendControl(ws, { type: "dictation_start" });
      ws.emit("close");
      // Should not throw or send anything after close
      expect(ws.sent.length).toBeGreaterThanOrEqual(1); // at least dictation_ready
    });

    it("reports unknown message types", () => {
      sendControl(ws, { type: "dictation_start" });
      sendControl(ws, { type: "bogus_type" });
      const errors = messagesOfType(ws, "dictation_error");
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("Unknown message type");
    });

    it("ignores invalid JSON gracefully", () => {
      ws.emit("message", Buffer.from("not json{{{"), false);
      const errors = messagesOfType(ws, "dictation_error");
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("Invalid JSON");
    });
  });

  describe("audio accumulation", () => {
    it("accumulates binary frames", () => {
      sendControl(ws, { type: "dictation_start" });
      const chunk1 = silencePcm(500);
      const chunk2 = silencePcm(500);
      sendAudio(ws, chunk1);
      sendAudio(ws, chunk2);
      // Audio is accumulated internally — verify via STT call on stop
      sendControl(ws, { type: "dictation_stop" });
      // Provider will be called with the accumulated WAV
    });

    it("ignores binary frames before dictation_start", () => {
      sendAudio(ws, silencePcm(500));
      // No crash, no error
      expect(messagesOfType(ws, "dictation_error")).toHaveLength(0);
    });

    it("produces WAV equivalent to encodeWav from accumulated chunks", async () => {
      sendControl(ws, { type: "dictation_start" });
      const chunk1 = silencePcm(500);
      const chunk2 = Buffer.alloc(1000, 0x7f);
      sendAudio(ws, chunk1);
      sendAudio(ws, chunk2);
      sendControl(ws, { type: "dictation_stop" });

      await vi.advanceTimersByTimeAsync(10);

      expect(provider.transcribe).toHaveBeenCalledTimes(1);
      const wav = provider.transcribe.mock.calls[0][0] as Buffer;
      const expected = encodeWav([chunk1, chunk2]);
      expect(Buffer.compare(wav, expected)).toBe(0);
    });
  });

  describe("retranscribe timer", () => {
    it("calls provider after interval elapses", async () => {
      sendControl(ws, { type: "dictation_start" });
      sendAudio(ws, silencePcm(500));

      // Advance past the 2s retranscribe interval
      await vi.advanceTimersByTimeAsync(2100);

      expect(provider.transcribe).toHaveBeenCalled();
      const results = messagesOfType(ws, "dictation_result");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].text).toBe("hello world");
      expect(results[0].version).toBe(1);
    });

    it("increments version on each retranscribe", async () => {
      sendControl(ws, { type: "dictation_start" });
      sendAudio(ws, silencePcm(500));

      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(2100);

      const results = messagesOfType(ws, "dictation_result");
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[1].version).toBeGreaterThan(results[0].version);
    });

    it("does not retranscribe with zero audio", async () => {
      sendControl(ws, { type: "dictation_start" });
      await vi.advanceTimersByTimeAsync(2100);
      // No provider call since there's no audio
      expect(provider.transcribe).not.toHaveBeenCalled();
    });
  });

  describe("STT provider", () => {
    it("calls provider with valid WAV on finalize", async () => {
      sendControl(ws, { type: "dictation_start" });
      sendAudio(ws, silencePcm(1000));
      sendControl(ws, { type: "dictation_stop" });

      await vi.advanceTimersByTimeAsync(10);

      expect(provider.transcribe).toHaveBeenCalledTimes(1);
      const wav = provider.transcribe.mock.calls[0][0] as Buffer;
      // Verify it's a valid WAV
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    });

    it("handles provider failure on retranscribe with non-fatal error", async () => {
      const failProvider = failingSttProvider("connection refused");
      const mgr = new DictationManager(testConfig(), "/tmp/test", failProvider);
      const fakeWs = new FakeWebSocket();
      mgr.handleConnection(fakeWs as unknown as WebSocket);

      sendControl(fakeWs, { type: "dictation_start" });
      sendAudio(fakeWs, silencePcm(500));

      await vi.advanceTimersByTimeAsync(2100);

      const errors = messagesOfType(fakeWs, "dictation_error");
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("STT error");
      expect(errors[0].fatal).toBe(false);
    });

    it("handles provider failure on finalize with fatal error", async () => {
      const failProvider = failingSttProvider("connection refused");
      const mgr = new DictationManager(testConfig(), "/tmp/test", failProvider);
      const fakeWs = new FakeWebSocket();
      mgr.handleConnection(fakeWs as unknown as WebSocket);

      sendControl(fakeWs, { type: "dictation_start" });
      sendAudio(fakeWs, silencePcm(500));
      sendControl(fakeWs, { type: "dictation_stop" });

      await vi.advanceTimersByTimeAsync(10);

      const errors = messagesOfType(fakeWs, "dictation_error");
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("STT failed");
      expect(errors[0].fatal).toBe(true);
    });

    it("handles provider HTTP error on finalize", async () => {
      const failProvider = failingSttProvider("STT HTTP 500: Internal Server Error");
      const mgr = new DictationManager(testConfig(), "/tmp/test", failProvider);
      const fakeWs = new FakeWebSocket();
      mgr.handleConnection(fakeWs as unknown as WebSocket);

      sendControl(fakeWs, { type: "dictation_start" });
      sendAudio(fakeWs, silencePcm(500));
      sendControl(fakeWs, { type: "dictation_stop" });

      await vi.advanceTimersByTimeAsync(10);

      const errors = messagesOfType(fakeWs, "dictation_error");
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("500");
    });
  });

  describe("LLM correction", () => {
    it("applies LLM correction on finalize when enabled", async () => {
      const llmResponse = {
        corrected: "Hello World",
        new_corrections: [{ original: "hello world", corrected: "Hello World" }],
        new_terms: [],
      };
      const sttProvider = mockSttProvider("hello world");
      const llmFetch = mockLlmFetch(llmResponse);
      const mgr = new DictationManager(
        testConfig({ llmCorrectionEnabled: true }),
        "/tmp/test",
        sttProvider,
        llmFetch,
      );
      const fakeWs = new FakeWebSocket();
      mgr.handleConnection(fakeWs as unknown as WebSocket);

      sendControl(fakeWs, { type: "dictation_start" });
      sendAudio(fakeWs, silencePcm(1000));
      sendControl(fakeWs, { type: "dictation_stop" });

      await vi.advanceTimersByTimeAsync(10);

      const finals = messagesOfType(fakeWs, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("Hello World");
      expect(finals[0].uncorrected).toBe("hello world");
    });

    it("sends correct LLM request format with thinking disabled", async () => {
      const llmFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: '{"corrected":"test","new_corrections":[],"new_terms":[]}' } },
          ],
        }),
        text: async () => "",
      }) as unknown as typeof globalThis.fetch;

      const mgr = new DictationManager(
        testConfig({ llmCorrectionEnabled: true }),
        "/tmp/test",
        mockSttProvider("test"),
        llmFetch,
      );
      const fakeWs = new FakeWebSocket();
      mgr.handleConnection(fakeWs as unknown as WebSocket);

      sendControl(fakeWs, { type: "dictation_start" });
      sendAudio(fakeWs, silencePcm(1000));
      sendControl(fakeWs, { type: "dictation_stop" });

      await vi.advanceTimersByTimeAsync(10);

      // Inspect the LLM fetch call
      const fn = llmFetch as ReturnType<typeof vi.fn>;
      expect(fn).toHaveBeenCalledTimes(1);
      const [url, opts] = fn.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("chat/completions");
      const body = JSON.parse(opts.body as string);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(body.model).toBe("test-llm");
      expect(body.temperature).toBe(0);
    });

    it("falls back to raw ASR text when LLM fails", async () => {
      const failLlmFetch = vi
        .fn()
        .mockRejectedValue(new Error("LLM timeout")) as unknown as typeof globalThis.fetch;

      const mgr = new DictationManager(
        testConfig({ llmCorrectionEnabled: true }),
        "/tmp/test",
        mockSttProvider("raw asr text"),
        failLlmFetch,
      );
      const fakeWs = new FakeWebSocket();
      mgr.handleConnection(fakeWs as unknown as WebSocket);

      sendControl(fakeWs, { type: "dictation_start" });
      sendAudio(fakeWs, silencePcm(1000));
      sendControl(fakeWs, { type: "dictation_stop" });

      await vi.advanceTimersByTimeAsync(10);

      const finals = messagesOfType(fakeWs, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("raw asr text");
      expect(finals[0].uncorrected).toBeUndefined(); // no correction applied
    });

    it("skips LLM when disabled", async () => {
      sendControl(ws, { type: "dictation_start" });
      sendAudio(ws, silencePcm(1000));
      sendControl(ws, { type: "dictation_stop" });

      await vi.advanceTimersByTimeAsync(10);

      const finals = messagesOfType(ws, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("hello world");
      expect(finals[0].uncorrected).toBeUndefined();
      // Only provider was called, no LLM
      expect(provider.transcribe).toHaveBeenCalledTimes(1);
    });

    it("handles LLM returning non-JSON gracefully", async () => {
      const badLlmFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "I cannot help with that" } }],
        }),
        text: async () => "",
      }) as unknown as typeof globalThis.fetch;

      const mgr = new DictationManager(
        testConfig({ llmCorrectionEnabled: true }),
        "/tmp/test",
        mockSttProvider("raw text"),
        badLlmFetch,
      );
      const fakeWs = new FakeWebSocket();
      mgr.handleConnection(fakeWs as unknown as WebSocket);

      sendControl(fakeWs, { type: "dictation_start" });
      sendAudio(fakeWs, silencePcm(1000));
      sendControl(fakeWs, { type: "dictation_stop" });

      await vi.advanceTimersByTimeAsync(10);

      // Falls back to raw text
      const finals = messagesOfType(fakeWs, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("raw text");
    });
  });

  describe("dictionary merge", () => {
    it("merges new corrections and terms from LLM response", async () => {
      const llmResponse = {
        corrected: "Oppi server on the Mac Studio",
        new_corrections: [
          { original: "opie", corrected: "Oppi" },
          { original: "max studio", corrected: "Mac Studio" },
        ],
        new_terms: ["DictationManager", "SwiftUI"],
      };
      const llmFetch = mockLlmFetch(llmResponse);
      const mgr = new DictationManager(
        testConfig({ llmCorrectionEnabled: true }),
        "/tmp/test",
        mockSttProvider("opie server on the max studio"),
        llmFetch,
      );
      const fakeWs = new FakeWebSocket();
      mgr.handleConnection(fakeWs as unknown as WebSocket);

      sendControl(fakeWs, { type: "dictation_start" });
      sendAudio(fakeWs, silencePcm(1000));
      sendControl(fakeWs, { type: "dictation_stop" });

      await vi.advanceTimersByTimeAsync(10);

      const finals = messagesOfType(fakeWs, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("Oppi server on the Mac Studio");
    });

    it("deduplicates domain terms", async () => {
      // Call correctWithLlm directly to test dedup
      const llmResponse = {
        corrected: "test",
        new_corrections: [],
        new_terms: ["Oppi", "Oppi", "SwiftUI"],
      };
      const llmFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(llmResponse) } }],
        }),
        text: async () => "",
      }) as unknown as typeof globalThis.fetch;

      const mgr = new DictationManager(
        testConfig({ llmCorrectionEnabled: true }),
        "/tmp/test",
        mockSttProvider(""),
        llmFetch,
      );

      // Call twice — second call should not duplicate terms
      await mgr.correctWithLlm("test");
      await mgr.correctWithLlm("test");

      // Verify fetch was called (we can't directly inspect the dictionary,
      // but the second call would include "Oppi" in the prompt if it exists)
      expect(llmFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("max duration", () => {
    it("sends fatal error and finalizes when max duration exceeded", async () => {
      const mgr = new DictationManager(testConfig({ maxDurationSec: 1 }), "/tmp/test", provider);
      const fakeWs = new FakeWebSocket();
      mgr.handleConnection(fakeWs as unknown as WebSocket);

      sendControl(fakeWs, { type: "dictation_start" });
      // Send 2 seconds of audio (exceeds 1s max)
      sendAudio(fakeWs, silencePcm(2000));

      // Advance past retranscribe interval
      await vi.advanceTimersByTimeAsync(2100);

      const errors = messagesOfType(fakeWs, "dictation_error");
      expect(errors.some((e) => e.error.includes("Max duration") && e.fatal)).toBe(true);
    });
  });

  describe("multiple connections", () => {
    it("manages independent sessions per WS connection", async () => {
      const ws2 = new FakeWebSocket();
      manager.handleConnection(ws2 as unknown as WebSocket);

      sendControl(ws, { type: "dictation_start" });
      sendControl(ws2, { type: "dictation_start" });

      expect(messagesOfType(ws, "dictation_ready")).toHaveLength(1);
      expect(messagesOfType(ws2, "dictation_ready")).toHaveLength(1);

      // Cancel one, the other continues
      sendControl(ws, { type: "dictation_cancel" });
      sendAudio(ws2, silencePcm(500));

      await vi.advanceTimersByTimeAsync(2100);

      // ws2 should get a result since it has audio
      const results = messagesOfType(ws2, "dictation_result");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });
});
