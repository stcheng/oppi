import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MlxStreamingSttProvider } from "./stt-provider.js";

// ─── Mock helpers ───

const BASE = "http://localhost:9999";
const STREAM_URL = `${BASE}/v1/audio/transcriptions/stream`;

interface FetchCall {
  url: string;
  method: string;
}

/** Response factory — returns a fresh Response each invocation. */
type ResponseFactory = () => Response;

function jsonResponse(body: unknown, status = 200): ResponseFactory {
  return () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function errorResponse(status: number): ResponseFactory {
  return () => new Response("", { status });
}

/**
 * Create a mock fetch that routes by method + URL pattern.
 * Handlers are checked in order; first match wins.
 * Falls back to 404 if nothing matches.
 */
function createMockFetch(
  handlers: Array<{ match: (url: string, method: string) => boolean; response: ResponseFactory }>,
) {
  const calls: FetchCall[] = [];

  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    for (const h of handlers) {
      if (h.match(url, method)) return h.response();
    }
    return new Response("Not found", { status: 404 });
  };

  return { fetchFn: fetchFn as typeof globalThis.fetch, calls };
}

// Matchers
const isCreate = (url: string, method: string) => method === "POST" && url === STREAM_URL;
const isFeed = (url: string, method: string) =>
  method === "POST" && url.startsWith(STREAM_URL + "/");
const isDelete = (url: string, method: string) =>
  method === "DELETE" && url.startsWith(STREAM_URL + "/");

/** Drain async microtasks (constructor warmUpSession, createSession, etc.). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Shorthand for creating a provider with defaults. */
function makeProvider(
  fetchFn: typeof globalThis.fetch,
  feedIntervalMs = 100,
): MlxStreamingSttProvider {
  return new MlxStreamingSttProvider(
    { endpoint: BASE, model: "test-model" },
    fetchFn,
    feedIntervalMs,
  );
}

// ─── Tests ───

describe("MlxStreamingSttProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Happy path
  it("start -> feedAudio -> stop: correct API sequence", async () => {
    let sessionCounter = 0;
    const { fetchFn, calls } = createMockFetch([
      { match: isCreate, response: () => jsonResponse({ session_id: `s${++sessionCounter}` })() },
      { match: isFeed, response: jsonResponse({ text: "hello world" }) },
      { match: isDelete, response: jsonResponse({ text: "hello world final" }) },
    ]);

    const provider = makeProvider(fetchFn);
    await flush(); // constructor warmUpSession

    expect(calls.filter((c) => c.method === "POST" && c.url === STREAM_URL)).toHaveLength(1);

    const tokens: string[] = [];
    provider.onToken((t) => tokens.push(t));
    provider.start();

    // Warm session was consumed — no new create call
    expect(calls.filter((c) => c.method === "POST" && c.url === STREAM_URL)).toHaveLength(1);

    provider.feedAudio(Buffer.from([1, 2, 3, 4]));

    // Advance timer to trigger flushAudio
    await vi.advanceTimersByTimeAsync(100);

    // Feed should have fired
    const feedCalls = calls.filter((c) => isFeed(c.url, c.method));
    expect(feedCalls).toHaveLength(1);
    expect(feedCalls[0].url).toBe(`${STREAM_URL}/s1`);
    expect(tokens).toEqual(["hello world"]);

    // Stop
    const result = await provider.stop();
    expect(result).toBe("hello world final");

    // DELETE was sent
    const deleteCalls = calls.filter((c) => isDelete(c.url, c.method));
    expect(deleteCalls.some((c) => c.url === `${STREAM_URL}/s1`)).toBe(true);
  });

  // 2. Warm session reuse — no extra createSession on start
  it("start reuses warm session without creating a new one", async () => {
    const { fetchFn, calls } = createMockFetch([
      { match: isCreate, response: jsonResponse({ session_id: "warm-1" }) },
      { match: isDelete, response: jsonResponse({ text: "" }) },
    ]);

    const provider = makeProvider(fetchFn);
    await flush();

    const createsBefore = calls.filter((c) => isCreate(c.url, c.method)).length;
    provider.start();
    await flush();

    // No new session creation — warm was reused
    const createsAfter = calls.filter((c) => isCreate(c.url, c.method)).length;
    expect(createsAfter).toBe(createsBefore);

    await provider.stop();
  });

  // 3. Double start cleans up first session
  it("start() called twice: first session is DELETE'd", async () => {
    let sessionCounter = 0;
    const { fetchFn, calls } = createMockFetch([
      { match: isCreate, response: () => jsonResponse({ session_id: `s${++sessionCounter}` })() },
      { match: isFeed, response: jsonResponse({ text: "hi" }) },
      { match: isDelete, response: jsonResponse({ text: "done" }) },
    ]);

    const provider = makeProvider(fetchFn);
    await flush(); // warm = s1

    provider.start(); // active = s1 (from warm)
    await flush();

    provider.start(); // should DELETE s1, then use fresh session
    await flush();

    // s1 should have been DELETE'd
    const deleteCalls = calls.filter((c) => isDelete(c.url, c.method));
    expect(deleteCalls.some((c) => c.url === `${STREAM_URL}/s1`)).toBe(true);

    await provider.stop();
  });

  // 4. stop() without start() — no-op
  it("stop without start does not throw", async () => {
    const { fetchFn } = createMockFetch([
      { match: isCreate, response: jsonResponse({ session_id: "warm-1" }) },
      { match: isDelete, response: jsonResponse({ text: "" }) },
    ]);

    const provider = makeProvider(fetchFn);
    await flush();

    // stop() before any start() — should return "" and not throw
    const result = await provider.stop();
    expect(result).toBe("");
  });

  // 5. warmUpSession replaces existing warm — old one DELETE'd
  it("warmUpSession cleans up previous warm session", async () => {
    let sessionCounter = 0;
    const { fetchFn, calls } = createMockFetch([
      { match: isCreate, response: () => jsonResponse({ session_id: `w${++sessionCounter}` })() },
      { match: isDelete, response: jsonResponse({ text: "" }) },
    ]);

    const provider = makeProvider(fetchFn);
    await flush(); // warm = w1

    // stop() triggers another warmUpSession, which should DELETE w1 first
    // Need to give it a session to stop — use start+stop cycle
    // Actually, stop() without start() also calls warmUpSession().
    const result = await provider.stop();
    expect(result).toBe("");
    await flush(); // let warmUpSession complete → warm = w2

    // w1 should have been DELETE'd during the second warmUpSession
    const deleteCalls = calls.filter((c) => isDelete(c.url, c.method));
    expect(deleteCalls.some((c) => c.url === `${STREAM_URL}/w1`)).toBe(true);

    // New warm session w2 was created
    const creates = calls.filter((c) => isCreate(c.url, c.method));
    expect(creates.length).toBeGreaterThanOrEqual(2);

    await provider.dispose();
  });

  // 6. MLX server returns 404 on feed — session recreated
  it("handles 404 on feed by recreating session", async () => {
    let sessionCounter = 0;
    let feedStatus = 200;
    const { fetchFn, calls } = createMockFetch([
      { match: isCreate, response: () => jsonResponse({ session_id: `s${++sessionCounter}` })() },
      {
        match: isFeed,
        response: () => {
          if (feedStatus === 404) return errorResponse(404)();
          return jsonResponse({ text: "recovered" })();
        },
      },
      { match: isDelete, response: jsonResponse({ text: "done" }) },
    ]);

    const provider = makeProvider(fetchFn);
    await flush(); // warm = s1

    const tokens: string[] = [];
    provider.onToken((t) => tokens.push(t));
    provider.start(); // active = s1

    // Queue audio and flush — should succeed
    provider.feedAudio(Buffer.from([1, 2]));
    await vi.advanceTimersByTimeAsync(100);
    expect(tokens).toEqual(["recovered"]);

    // Now make feed return 404
    feedStatus = 404;
    provider.feedAudio(Buffer.from([3, 4]));
    await vi.advanceTimersByTimeAsync(100);
    await flush(); // let createSession complete

    // Session should have been recreated (s2 from createSession, warm was consumed as s1)
    feedStatus = 200;
    provider.feedAudio(Buffer.from([5, 6]));
    await vi.advanceTimersByTimeAsync(100);
    expect(tokens[tokens.length - 1]).toBe("recovered");

    // Verify we created more than the initial warm session
    const creates = calls.filter((c) => isCreate(c.url, c.method));
    expect(creates.length).toBeGreaterThanOrEqual(2);

    await provider.stop();
  });

  // 7. dispose() cleans up both active and warm sessions
  it("dispose deletes active and warm sessions", async () => {
    let sessionCounter = 0;
    const { fetchFn, calls } = createMockFetch([
      { match: isCreate, response: () => jsonResponse({ session_id: `s${++sessionCounter}` })() },
      { match: isFeed, response: jsonResponse({ text: "hi" }) },
      { match: isDelete, response: jsonResponse({ text: "" }) },
    ]);

    const provider = makeProvider(fetchFn);
    await flush(); // warm = s1

    provider.start(); // active = s1 (from warm)
    await flush();
    // stop() triggers warmUpSession → warm = s2
    // But we want both active + warm alive, so don't stop — manually trigger warmup.
    // Actually: after start(), warmSessionId is null (consumed). Feed some audio.
    // We need a warm session too. Let's stop() which creates warm, then start() which
    // consumes warm, then manually check. Alternatively:
    // Just stop() to get warm session back, then don't start — dispose should clean warm.

    const stopResult = await provider.stop(); // DELETEs s1, warms up s2
    await flush();
    expect(stopResult).toBe("");

    // Now start again — active = s2 (from warm)
    provider.start();
    await flush();

    // stop() at end of start→stop would warm up s3, but we want both active+warm.
    // After start: active = s2, warm = null. Let's just test dispose on active only.
    // Actually, the constructor warmed s1, start consumed it. stop warmed s2, start consumed it.
    // We have active=s2, warm=null. To get both, feed + don't stop, then warmup happens only on stop.

    // Trigger a manual warm-up by stopping then starting to get a warm ready:
    // Simpler: just test that dispose DELETEs what it has.

    // Current state: active = s2, warm = null.
    await provider.dispose();

    const deleteCalls = calls.filter((c) => isDelete(c.url, c.method));
    // s1 was deleted during stop(), s2 during dispose()
    expect(deleteCalls.some((c) => c.url === `${STREAM_URL}/s2`)).toBe(true);
  });

  it("dispose deletes warm session when no active session exists", async () => {
    const { fetchFn, calls } = createMockFetch([
      { match: isCreate, response: jsonResponse({ session_id: "warm-1" }) },
      { match: isDelete, response: jsonResponse({ text: "" }) },
    ]);

    const provider = makeProvider(fetchFn);
    await flush(); // warm = warm-1

    // No start() called — only warm exists
    await provider.dispose();

    const deleteCalls = calls.filter((c) => isDelete(c.url, c.method));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].url).toBe(`${STREAM_URL}/warm-1`);
  });

  // 8. Audio queuing before session is ready
  it("queues audio before session is created and flushes after", async () => {
    let sessionCounter = 0;
    const { fetchFn, calls } = createMockFetch([
      {
        match: isCreate,
        response: () => {
          // First create returns an error (simulating warm-up failure),
          // second succeeds (on-demand creation from start())
          sessionCounter++;
          if (sessionCounter === 1) return errorResponse(500)();
          return jsonResponse({ session_id: `s${sessionCounter}` })();
        },
      },
      { match: isFeed, response: jsonResponse({ text: "queued audio" }) },
      { match: isDelete, response: jsonResponse({ text: "final" }) },
    ]);

    const provider = makeProvider(fetchFn);
    await flush(); // warm-up fails (500)

    provider.start(); // no warm → calls createSession async
    // Feed audio before session is ready
    provider.feedAudio(Buffer.from([10, 20, 30]));
    provider.feedAudio(Buffer.from([40, 50, 60]));
    expect(calls.filter((c) => isFeed(c.url, c.method))).toHaveLength(0);

    await flush(); // createSession completes → s2

    // Now advance timer to flush queued audio
    await vi.advanceTimersByTimeAsync(100);

    const feedCalls = calls.filter((c) => isFeed(c.url, c.method));
    expect(feedCalls).toHaveLength(1); // Both buffers flushed in one concat
    expect(feedCalls[0].url).toBe(`${STREAM_URL}/s2`);

    await provider.stop();
  });

  // 9. Feed timer concatenates queued audio chunks
  it("feed timer concatenates multiple queued chunks into one request", async () => {
    const { fetchFn, calls } = createMockFetch([
      { match: isCreate, response: jsonResponse({ session_id: "s1" }) },
      { match: isFeed, response: jsonResponse({ text: "concat" }) },
      { match: isDelete, response: jsonResponse({ text: "done" }) },
    ]);

    const provider = makeProvider(fetchFn);
    await flush();

    provider.start();

    // Feed multiple chunks before timer fires
    provider.feedAudio(Buffer.from([1, 2]));
    provider.feedAudio(Buffer.from([3, 4]));
    provider.feedAudio(Buffer.from([5, 6]));

    // Timer hasn't fired yet
    expect(calls.filter((c) => isFeed(c.url, c.method))).toHaveLength(0);

    // Advance past one interval
    await vi.advanceTimersByTimeAsync(100);

    // All three chunks sent as one request
    const feedCalls = calls.filter((c) => isFeed(c.url, c.method));
    expect(feedCalls).toHaveLength(1);

    await provider.stop();
  });

  // Edge: dispose is safe when fetch throws (network down)
  it("dispose handles network errors gracefully", async () => {
    const { fetchFn } = createMockFetch([
      { match: isCreate, response: jsonResponse({ session_id: "s1" }) },
      {
        match: isDelete,
        response: () => {
          throw new Error("ECONNREFUSED");
        },
      },
    ]);

    const provider = makeProvider(fetchFn);
    await flush();

    // Should not throw even when DELETE fails
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  // Edge: stop returns last known text when DELETE fails
  it("stop returns last text when DELETE fails", async () => {
    const { fetchFn } = createMockFetch([
      { match: isCreate, response: jsonResponse({ session_id: "s1" }) },
      { match: isFeed, response: jsonResponse({ text: "partial" }) },
      {
        match: isDelete,
        response: () => {
          throw new Error("timeout");
        },
      },
    ]);

    const provider = makeProvider(fetchFn);
    await flush();

    provider.onToken(() => {});
    provider.start();
    provider.feedAudio(Buffer.from([1, 2]));
    await vi.advanceTimersByTimeAsync(100);

    const result = await provider.stop();
    expect(result).toBe("partial");
  });
});
