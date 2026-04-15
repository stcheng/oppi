import { randomUUID } from "node:crypto";
import { rmSync, utimesSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SearchIndex } from "./search-index.js";
import type { Session } from "./types.js";

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

function writeSummary(baseDir: string, piSessionId: string, body: Record<string, unknown>): string {
  const path = join(baseDir, `${piSessionId}.summary.json`);
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

describe("SearchIndex decouples from continuation summaries", () => {
  it("ignores continuation summary-only text and indexes transcript content", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "search-index-"));
    cleanupPaths.add(dataDir);

    const piSessionId = randomUUID();
    const jsonlPath = join(dataDir, "session.jsonl");
    writeJsonl(
      jsonlPath,
      "Investigate search ranking",
      "The transcript mentions zebra transcript clue but not the external blocker phrase.",
    );

    const summaryPath = writeSummary(dataDir, piSessionId, {
      title: "Search summary indexing",
      thread: "Memory discovery",
      goal: "Make continuation summaries searchable",
      status: "blocked",
      blockers: ["walrus token blocker in continuation summary"],
    });
    cleanupPaths.add(summaryPath);

    const session = makeSession({ id: "sess-summary", piSessionId, piSessionFile: jsonlPath });
    const sessions = new Map([[session.id, session]]);
    const index = new SearchIndex(dataDir, (id) => sessions.get(id));
    cleanupPaths.add(join(dataDir, "session-search.db"));

    try {
      index.sync([session]);

      const transcriptResults = index.search("zebra transcript clue", "ws-1", 10);
      expect(transcriptResults).toHaveLength(1);
      expect(transcriptResults[0]?.sessionId).toBe(session.id);

      const summaryOnlyResults = index.search("walrus token blocker", "ws-1", 10);
      expect(summaryOnlyResults).toHaveLength(0);
    } finally {
      index.close();
    }
  });

  it("does not reindex when only an ignored continuation summary changes", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "search-index-"));
    cleanupPaths.add(dataDir);

    const piSessionId = randomUUID();
    const jsonlPath = join(dataDir, "session.jsonl");
    writeJsonl(
      jsonlPath,
      "Keep transcript stable",
      "This transcript never mentions the changing blocker keywords.",
    );

    const summaryPath = writeSummary(dataDir, piSessionId, {
      title: "Initial blocker",
      goal: "Prove summary is ignored by core index",
      status: "blocked",
      blockers: ["otter blocker"],
    });
    cleanupPaths.add(summaryPath);

    const session = makeSession({ id: "sess-reindex", piSessionId, piSessionFile: jsonlPath });
    const sessions = new Map([[session.id, session]]);
    const index = new SearchIndex(dataDir, (id) => sessions.get(id));
    cleanupPaths.add(join(dataDir, "session-search.db"));

    try {
      const first = index.sync([session]);
      expect(first.added).toBe(1);
      expect(index.search("otter blocker", "ws-1", 10)).toHaveLength(0);

      writeSummary(dataDir, piSessionId, {
        title: "Updated blocker",
        goal: "Prove summary is ignored by core index",
        status: "blocked",
        blockers: ["penguin blocker"],
      });
      const future = new Date(Date.now() + 5_000);
      utimesSync(summaryPath, future, future);

      const second = index.sync([session]);
      expect(second.reindexed).toBe(0);
      expect(second.skipped).toBe(1);
      expect(index.search("penguin blocker", "ws-1", 10)).toHaveLength(0);
    } finally {
      index.close();
    }
  });
});
