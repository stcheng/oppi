/**
 * Tests for DictationManager — audio accumulation, WAV encoding,
 * STT provider integration (streaming + HTTP adapter), LLM correction,
 * dictionary merge, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { WebSocket } from "ws";
import {
  DictationManager,
  encodeFlac,
  encodeWav,
  extractJsonFromResponse,
} from "./dictation-manager.js";

import type { DictationConfig, DictationServerMessage } from "./dictation-types.js";
import type { SttProvider } from "./stt-provider.js";

// ─── Test helpers ───

function testConfig(overrides: Partial<DictationConfig> = {}): DictationConfig {
  return {
    sttEndpoint: "http://localhost:9847",
    sttModel: "test-model",
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
  return Buffer.alloc(samples * 2);
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

/**
 * Create a mock SttProvider (streaming interface).
 * Simulates progressive token accumulation on _fireTokens().
 */
function mockSttProvider(tokens: string[]) {
  let tokenCb: ((text: string) => void) | null = null;
  const accumulated = tokens.join(" ");

  const startFn = vi.fn<() => void>();
  const feedAudioFn = vi.fn<(pcm: Buffer) => void>();
  const stopFn = vi.fn<() => Promise<string>>().mockResolvedValue(accumulated);

  const provider: SttProvider & { _fireTokens: () => void } = {
    name: "mock",
    model: "mock-model",
    start: startFn,
    feedAudio: feedAudioFn,
    onToken(cb: (text: string) => void) {
      tokenCb = cb;
    },
    stop: stopFn,
    _fireTokens() {
      let running = "";
      for (const t of tokens) {
        running += (running.length > 0 ? " " : "") + t;
        tokenCb?.(running);
      }
    },
  };
  return Object.assign(provider, { start: startFn, feedAudio: feedAudioFn, stop: stopFn });
}

/** Create a mock SttProvider whose stop() rejects. */
function failingSttProvider(error: string) {
  const startFn = vi.fn<() => void>();
  const feedAudioFn = vi.fn<(pcm: Buffer) => void>();
  const stopFn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error(error));

  const provider: SttProvider = {
    name: "mock",
    model: "mock-model",
    start: startFn,
    feedAudio: feedAudioFn,
    onToken() {},
    stop: stopFn,
  };
  return Object.assign(provider, { start: startFn, feedAudio: feedAudioFn, stop: stopFn });
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

// ─── Unit tests for standalone utilities ───

describe("encodeWav", () => {
  it("produces valid WAV header for empty audio", () => {
    const wav = encodeWav([]);
    expect(wav.length).toBe(44);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(0); // data size
  });

  it("concatenates multiple PCM chunks with correct header sizes", () => {
    const chunk1 = Buffer.alloc(1000, 0x42);
    const chunk2 = Buffer.alloc(2000, 0x43);
    const wav = encodeWav([chunk1, chunk2]);
    expect(wav.length).toBe(44 + 3000);
    expect(wav.readUInt32LE(4)).toBe(36 + 3000);
    expect(wav.readUInt32LE(40)).toBe(3000);
    expect(wav[44]).toBe(0x42);
    expect(wav[44 + 1000]).toBe(0x43);
  });

  it("handles byte rate and block align correctly", () => {
    const wav = encodeWav([]);
    expect(wav.readUInt32LE(28)).toBe(32000); // byteRate
    expect(wav.readUInt16LE(32)).toBe(2); // blockAlign
  });
});

describe("encodeFlac", () => {
  it("produces valid FLAC from WAV with correct binary round-trip", async () => {
    const sampleRate = 16000;
    const numSamples = sampleRate;
    const pcm = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
      pcm.writeInt16LE(sample, i * 2);
    }
    const wav = encodeWav([pcm]);
    const flac = await encodeFlac(wav);

    expect(flac.toString("ascii", 0, 4)).toBe("fLaC");
    expect(flac.length).toBeGreaterThan(100);

    const highBytes = Array.from(flac).filter((b) => b > 127);
    expect(highBytes.length).toBeGreaterThan(0);

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
    expect(extractJsonFromResponse("no json here")).toBe("no json here");
  });
});

// ─── DictationManager with streaming provider (native path) ───

describe("DictationManager", () => {
  let manager: DictationManager;
  let ws: FakeWebSocket;
  let provider: ReturnType<typeof mockSttProvider>;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = mockSttProvider(["hello", "world"]);
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
      const ready = messagesOfType(ws, "dictation_ready")[0];
      expect(ready.sttProvider).toBe("mock");
      expect(ready.sttModel).toBe("mock-model");
      expect(ready.llmCorrectionEnabled).toBe(false);
    });

    it("calls start() on dictation_start", () => {
      sendControl(ws, { type: "dictation_start" });
      expect(provider.start).toHaveBeenCalledTimes(1);
    });

    it("pipes audio via feedAudio()", () => {
      sendControl(ws, { type: "dictation_start" });
      const pcm = silencePcm(500);
      sendAudio(ws, pcm);
      expect(provider.feedAudio).toHaveBeenCalledWith(pcm);
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
      expect(messagesOfType(ws, "dictation_error")).toHaveLength(1);
    });

    it("sends empty dictation_final for stop with no audio", async () => {
      sendControl(ws, { type: "dictation_start" });
      sendControl(ws, { type: "dictation_stop" });
      await vi.advanceTimersByTimeAsync(10);
      const finals = messagesOfType(ws, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("");
    });

    it("handles dictation_cancel silently", () => {
      sendControl(ws, { type: "dictation_start" });
      sendControl(ws, { type: "dictation_cancel" });
      expect(messagesOfType(ws, "dictation_final")).toHaveLength(0);
      expect(provider.stop).toHaveBeenCalledTimes(1);
    });

    it("cleans up on WS close", () => {
      sendControl(ws, { type: "dictation_start" });
      ws.emit("close");
      expect(provider.stop).toHaveBeenCalledTimes(1);
    });

    it("reports unknown message types", () => {
      sendControl(ws, { type: "dictation_start" });
      sendControl(ws, { type: "bogus_type" });
      expect(messagesOfType(ws, "dictation_error")).toHaveLength(1);
    });

    it("ignores invalid JSON gracefully", () => {
      ws.emit("message", Buffer.from("not json{{{"), false);
      expect(messagesOfType(ws, "dictation_error")).toHaveLength(1);
    });
  });

  describe("token streaming", () => {
    it("sends dictation_result with accumulated text", () => {
      sendControl(ws, { type: "dictation_start" });
      sendAudio(ws, silencePcm(500));
      provider._fireTokens();

      const results = messagesOfType(ws, "dictation_result");
      expect(results).toHaveLength(2);
      expect(results[0].text).toBe("hello");
      expect(results[0].version).toBe(1);
      expect(results[1].text).toBe("hello world");
      expect(results[1].version).toBe(2);
    });

    it("ignores binary frames before dictation_start", () => {
      sendAudio(ws, silencePcm(500));
      expect(messagesOfType(ws, "dictation_error")).toHaveLength(0);
    });
  });

  describe("finalize", () => {
    it("calls stop() and returns accumulated text", async () => {
      sendControl(ws, { type: "dictation_start" });
      sendAudio(ws, silencePcm(1000));
      sendControl(ws, { type: "dictation_stop" });
      await vi.advanceTimersByTimeAsync(10);

      expect(provider.stop).toHaveBeenCalledTimes(1);
      const finals = messagesOfType(ws, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("hello world");
    });

    it("handles stop() failure with fatal error", async () => {
      const failProvider = failingSttProvider("process crashed");
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
  });

  describe("LLM correction", () => {
    it("applies LLM correction on finalize when enabled", async () => {
      const llmResponse = {
        corrected: "Hello World",
        new_corrections: [{ original: "hello world", corrected: "Hello World" }],
        new_terms: [],
      };
      const sp = mockSttProvider(["hello", "world"]);
      const llmFetch = mockLlmFetch(llmResponse);
      const mgr = new DictationManager(
        testConfig({ llmCorrectionEnabled: true }),
        "/tmp/test",
        sp,
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

    it("falls back to raw ASR text when LLM fails", async () => {
      const failLlmFetch = vi
        .fn()
        .mockRejectedValue(new Error("LLM timeout")) as unknown as typeof globalThis.fetch;

      const sp = mockSttProvider(["raw", "asr", "text"]);
      const mgr = new DictationManager(
        testConfig({ llmCorrectionEnabled: true }),
        "/tmp/test",
        sp,
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
      expect(finals[0].uncorrected).toBeUndefined();
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
    });

    it("handles LLM returning non-JSON gracefully", async () => {
      const badLlmFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "I cannot help with that" } }],
        }),
        text: async () => "",
      }) as unknown as typeof globalThis.fetch;

      const sp = mockSttProvider(["raw", "text"]);
      const mgr = new DictationManager(
        testConfig({ llmCorrectionEnabled: true }),
        "/tmp/test",
        sp,
        badLlmFetch,
      );
      const fakeWs = new FakeWebSocket();
      mgr.handleConnection(fakeWs as unknown as WebSocket);

      sendControl(fakeWs, { type: "dictation_start" });
      sendAudio(fakeWs, silencePcm(1000));
      sendControl(fakeWs, { type: "dictation_stop" });
      await vi.advanceTimersByTimeAsync(10);

      const finals = messagesOfType(fakeWs, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("raw text");
    });
  });
});
