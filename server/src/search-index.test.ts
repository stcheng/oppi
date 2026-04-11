import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SearchIndex } from "./search-index.js";
import type { Session } from "./types.js";

const CONTINUATION_SUMMARY_DIR = join(homedir(), ".pi", "agent", "continuation", "sessions");

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    workspaceId: "ws-1",
    name: "Search test session",
    status: "stopped",
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    ...overrides,
  };
}

function writeJsonl(path: string, userText: string, assistantText: string): void {
  const lines = [
    JSON.stringify({
      type: "session",
      id: randomUUID(),
      cwd: "/tmp/search-test",
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: userText }] },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
    }),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
}

function writeSummary(piSessionId: string, body: Record<string, unknown>): string {
  mkdirSync(CONTINUATION_SUMMARY_DIR, { recursive: true });
  const path = join(CONTINUATION_SUMMARY_DIR, `${piSessionId}.json`);
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  return path;
}

const cleanupPaths = new Set<string>();

afterEach(() => {
  for (const path of cleanupPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe("SearchIndex continuation summaries", () => {
  it("indexes continuation summary text so summary-only queries are discoverable", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "search-index-"));
    cleanupPaths.add(dataDir);

    const piSessionId = randomUUID();
    const jsonlPath = join(dataDir, "session.jsonl");
    writeJsonl(
      jsonlPath,
      "Investigate search ranking",
      "I checked the transcript, but the unique blocker phrase is not mentioned here.",
    );

    const summaryPath = writeSummary(piSessionId, {
      title: "Search summary indexing",
      thread: "Memory discovery",
      goal: "Make continuation summaries searchable",
      status: "blocked",
      blockers: ["walrus token blocker in continuation summary"],
      remaining: ["Wire the summary fields into the search index"],
      learnings: ["Transcript text alone is not enough for fast discovery"],
    });
    cleanupPaths.add(summaryPath);

    const session = makeSession({ id: "sess-summary", piSessionId, piSessionFile: jsonlPath });
    const sessions = new Map([[session.id, session]]);
    const index = new SearchIndex(dataDir, (id) => sessions.get(id));
    cleanupPaths.add(join(dataDir, "session-search.db"));

    try {
      index.sync([session]);
      const results = index.search("walrus token blocker", "ws-1", 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.sessionId).toBe(session.id);
      expect(results[0]?.snippet.toLowerCase()).toContain("walrus");
    } finally {
      index.close();
    }
  });

  it("reindexes when the continuation summary changes even if the transcript file is unchanged", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "search-index-"));
    cleanupPaths.add(dataDir);

    const piSessionId = randomUUID();
    const jsonlPath = join(dataDir, "session.jsonl");
    writeJsonl(
      jsonlPath,
      "Keep transcript stable",
      "This transcript never mentions the changing blocker keywords.",
    );

    const summaryPath = writeSummary(piSessionId, {
      title: "Initial blocker",
      goal: "Prove summary-aware invalidation",
      status: "blocked",
      blockers: ["otter blocker"],
    });
    cleanupPaths.add(summaryPath);

    const session = makeSession({ id: "sess-reindex", piSessionId, piSessionFile: jsonlPath });
    const sessions = new Map([[session.id, session]]);
    const index = new SearchIndex(dataDir, (id) => sessions.get(id));
    cleanupPaths.add(join(dataDir, "session-search.db"));

    try {
      index.sync([session]);
      expect(index.search("otter blocker", "ws-1", 10)).toHaveLength(1);
      expect(index.search("penguin blocker", "ws-1", 10)).toHaveLength(0);

      writeSummary(piSessionId, {
        title: "Updated blocker",
        goal: "Prove summary-aware invalidation",
        status: "blocked",
        blockers: ["penguin blocker"],
      });
      const future = new Date(Date.now() + 5_000);
      utimesSync(summaryPath, future, future);

      index.sync([session]);
      expect(index.search("penguin blocker", "ws-1", 10)).toHaveLength(1);
      expect(index.search("otter blocker", "ws-1", 10)).toHaveLength(0);
    } finally {
      index.close();
    }
  });
});
