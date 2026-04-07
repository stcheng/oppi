/**
 * Tests for DictationManager — audio accumulation, WAV encoding,
 * STT provider integration (streaming + HTTP adapter), LLM correction,
 * dictionary merge, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DictationManager,
  encodeFlac,
  encodeWav,
  extractJsonFromResponse,
  type DictationSendFn,
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

/** Drain pending microtasks (multiple levels for chained async). */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Generate PCM silence (zero-filled). */
function silencePcm(durationMs: number): Buffer {
  const samples = Math.floor((16000 * durationMs) / 1000);
  return Buffer.alloc(samples * 2);
}

/** Collect messages of a given type from a sent message array. */
function messagesOfType<T extends DictationServerMessage["type"]>(
  sent: DictationServerMessage[],
  type: T,
): Extract<DictationServerMessage, { type: T }>[] {
  return sent.filter((m) => m.type === type) as Extract<DictationServerMessage, { type: T }>[];
}

/**
 * Create a mock SttProvider (streaming interface).
 * Simulates progressive token accumulation on _fireTokens().
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function mockSttProvider(tokens: string[]) {
  let tokenCb: ((text: string) => void) | null = null;
  const accumulated = tokens.join(" ");

  const startFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
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
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function failingSttProvider(error: string) {
  const startFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
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
  let sent: DictationServerMessage[];
  let sendFn: (msg: DictationServerMessage) => void;
  let provider: ReturnType<typeof mockSttProvider>;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = mockSttProvider(["hello", "world"]);
    manager = new DictationManager(testConfig(), "/tmp/test-dictation", provider);
    sent = [];
    sendFn = (msg: DictationServerMessage) => sent.push(msg);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("session lifecycle", () => {
    it("sends dictation_ready on dictation_start", async () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();
      expect(messagesOfType(sent, "dictation_ready")).toHaveLength(1);
    });

    it("dictation_ready includes provider metadata", async () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();
      const ready = messagesOfType(sent, "dictation_ready")[0];
      expect(ready.sttProvider).toBe("mock");
      expect(ready.sttModel).toBe("mock-model");
      expect(ready.llmCorrectionEnabled).toBe(false);
    });

    it("calls start() on dictation_start", async () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();
      expect(provider.start).toHaveBeenCalledTimes(1);
    });

    it("pipes audio via feedAudio()", async () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();
      const pcm = silencePcm(500);
      manager.handleAudioData(pcm);
      expect(provider.feedAudio).toHaveBeenCalledWith(pcm);
    });

    it("rejects duplicate dictation_start", () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      const errors = messagesOfType(sent, "dictation_error");
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain("already active");
    });

    it("rejects dictation_stop without active session", () => {
      manager.handleControlMessage({ type: "dictation_stop" }, sendFn);
      expect(messagesOfType(sent, "dictation_error")).toHaveLength(1);
    });

    it("sends empty dictation_final for stop with no audio", async () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      manager.handleControlMessage({ type: "dictation_stop" }, sendFn);
      vi.advanceTimersByTime(10);
      await drain();
      const finals = messagesOfType(sent, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("");
    });

    it("handles dictation_cancel silently", () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      manager.handleControlMessage({ type: "dictation_cancel" }, sendFn);
      expect(messagesOfType(sent, "dictation_final")).toHaveLength(0);
      expect(provider.stop).toHaveBeenCalledTimes(1);
    });

    it("cleans up on disconnect", () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      manager.handleDisconnect();
      expect(provider.stop).toHaveBeenCalledTimes(1);
    });

    it("reports unknown message types", () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      manager.handleControlMessage(
        { type: "bogus_type" } as unknown as Parameters<typeof manager.handleControlMessage>[0],
        sendFn,
      );
      expect(messagesOfType(sent, "dictation_error")).toHaveLength(1);
    });

    it("allows new session after disconnect", async () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();
      manager.handleDisconnect();

      // Reset sent messages and start a fresh session
      sent.length = 0;
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();

      const readyMsgs = messagesOfType(sent, "dictation_ready");
      expect(readyMsgs).toHaveLength(1);
      expect(provider.start).toHaveBeenCalledTimes(2);
    });

    it("allows new session after cancel", async () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();
      manager.handleControlMessage({ type: "dictation_cancel" }, sendFn);

      sent.length = 0;
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();

      expect(messagesOfType(sent, "dictation_ready")).toHaveLength(1);
    });

    it("persists send callback across multiple sessions", async () => {
      // The send function is set per-call. Verify each session gets
      // its messages routed to the callback provided with that call.
      const sent1: DictationServerMessage[] = [];
      const sent2: DictationServerMessage[] = [];
      manager.handleControlMessage({ type: "dictation_start" }, (m) => sent1.push(m));
      await drain();
      manager.handleDisconnect();
      manager.handleControlMessage({ type: "dictation_start" }, (m) => sent2.push(m));
      await drain();

      expect(sent1).toHaveLength(1); // dictation_ready
      expect(sent2).toHaveLength(1); // dictation_ready
    });

    it("sends fatal error when STT backend is unreachable", async () => {
      const failStartProvider = mockSttProvider(["test"]);
      failStartProvider.start.mockRejectedValue(new Error("STT backend unreachable"));
      const mgr = new DictationManager(testConfig(), "/tmp/test", failStartProvider);
      const mgrSent: DictationServerMessage[] = [];

      mgr.handleControlMessage({ type: "dictation_start" }, (m) => mgrSent.push(m));
      await drain();

      const errors = messagesOfType(mgrSent, "dictation_error");
      expect(errors).toHaveLength(1);
      expect(errors[0].fatal).toBe(true);
      expect(errors[0].error).toContain("STT failed to start");
      // No dictation_ready should have been sent
      expect(messagesOfType(mgrSent, "dictation_ready")).toHaveLength(0);
    });
  });

  describe("token streaming", () => {
    it("sends dictation_result with accumulated text", async () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();
      manager.handleAudioData(silencePcm(500));
      provider._fireTokens();

      const results = messagesOfType(sent, "dictation_result");
      expect(results).toHaveLength(2);
      expect(results[0].text).toBe("hello");
      expect(results[1].text).toBe("hello world");
    });

    it("ignores audio data before dictation_start", () => {
      manager.handleAudioData(silencePcm(500));
      expect(messagesOfType(sent, "dictation_error")).toHaveLength(0);
    });
  });

  describe("finalize", () => {
    it("calls stop() and returns accumulated text", async () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();
      manager.handleAudioData(silencePcm(1000));
      manager.handleControlMessage({ type: "dictation_stop" }, sendFn);
      vi.advanceTimersByTime(10);
      await drain();

      expect(provider.stop).toHaveBeenCalledTimes(1);
      const finals = messagesOfType(sent, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("hello world");
    });

    it("handles stop() failure with fatal error", async () => {
      const failProvider = failingSttProvider("process crashed");
      const mgr = new DictationManager(testConfig(), "/tmp/test", failProvider);
      const mgrSent: DictationServerMessage[] = [];
      const mgrSendFn: DictationSendFn = (msg) => {
        mgrSent.push(msg);
      };

      mgr.handleControlMessage({ type: "dictation_start" }, mgrSendFn);
      await drain();
      mgr.handleAudioData(silencePcm(500));
      mgr.handleControlMessage({ type: "dictation_stop" }, mgrSendFn);
      vi.advanceTimersByTime(10);
      await drain();

      const errors = messagesOfType(mgrSent, "dictation_error");
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
      const mgrSent: DictationServerMessage[] = [];
      const mgrSendFn: DictationSendFn = (msg) => {
        mgrSent.push(msg);
      };

      mgr.handleControlMessage({ type: "dictation_start" }, mgrSendFn);
      await drain();
      mgr.handleAudioData(silencePcm(1000));
      mgr.handleControlMessage({ type: "dictation_stop" }, mgrSendFn);
      vi.advanceTimersByTime(10);
      await drain();

      const finals = messagesOfType(mgrSent, "dictation_final");
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
      const mgrSent: DictationServerMessage[] = [];
      const mgrSendFn: DictationSendFn = (msg) => {
        mgrSent.push(msg);
      };

      mgr.handleControlMessage({ type: "dictation_start" }, mgrSendFn);
      await drain();
      mgr.handleAudioData(silencePcm(1000));
      mgr.handleControlMessage({ type: "dictation_stop" }, mgrSendFn);
      vi.advanceTimersByTime(10);
      await drain();

      const finals = messagesOfType(mgrSent, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("raw asr text");
      expect(finals[0].uncorrected).toBeUndefined();
    });

    it("skips LLM when disabled", async () => {
      manager.handleControlMessage({ type: "dictation_start" }, sendFn);
      await drain();
      manager.handleAudioData(silencePcm(1000));
      manager.handleControlMessage({ type: "dictation_stop" }, sendFn);
      vi.advanceTimersByTime(10);
      await drain();

      const finals = messagesOfType(sent, "dictation_final");
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
      const mgrSent: DictationServerMessage[] = [];
      const mgrSendFn: DictationSendFn = (msg) => {
        mgrSent.push(msg);
      };

      mgr.handleControlMessage({ type: "dictation_start" }, mgrSendFn);
      await drain();
      mgr.handleAudioData(silencePcm(1000));
      mgr.handleControlMessage({ type: "dictation_stop" }, mgrSendFn);
      vi.advanceTimersByTime(10);
      await drain();

      const finals = messagesOfType(mgrSent, "dictation_final");
      expect(finals).toHaveLength(1);
      expect(finals[0].text).toBe("raw text");
    });
  });
});
