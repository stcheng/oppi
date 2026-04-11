import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../src/sessions.js";
import { buildSessionContext } from "../src/trace.js";
import type { GateServer } from "../src/gate.js";
import type { Storage } from "../src/storage.js";
import type { ServerConfig, Session, Workspace } from "../src/types.js";

const TEST_CONFIG: ServerConfig = {
  port: 7749,
  host: "127.0.0.1",
  dataDir: "/tmp/oppi-fork-lineage-poc",
  defaultModel: "anthropic/claude-sonnet-4-0",
  sessionTimeout: 600_000,
  sessionIdleTimeoutMs: 600_000,
  workspaceIdleTimeoutMs: 1_800_000,
  maxSessionsPerWorkspace: 10,
  maxSessionsGlobal: 20,
};

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id: overrides.id ?? "s1",
    workspaceId: "w1",
    workspaceName: "Test Workspace",
    status: "ready",
    createdAt: now,
    lastActivity: now,
    messageCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    model: "anthropic/claude-sonnet-4-0",
    ...overrides,
  };
}

function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function messageEntry(
  id: string,
  parentId: string | null,
  role: string,
  content: string,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-04-10T00:00:00Z",
    message: { role, content },
  };
}

function parseEntries(content: string): Array<Record<string, unknown>> {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function activePath(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const id = entry.id;
    if (typeof id === "string" && id.length > 0) {
      byId.set(id, entry);
    }
  }

  let leaf: Record<string, unknown> | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const id = entry.id;
    if (entry.type !== "session" && typeof id === "string" && id.length > 0) {
      leaf = entry;
      break;
    }
  }

  const path: Array<Record<string, unknown>> = [];
  let current = leaf;
  while (current) {
    path.unshift(current);
    const parentId = current.parentId;
    current = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }

  return path;
}

function sliceActivePathAfterEntry(content: string, entryId: string): Array<Record<string, unknown>> {
  const path = activePath(parseEntries(content));
  const idx = path.findIndex((entry) => entry.id === entryId);
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function makeHarness(parentSessionFile: string): {
  manager: SessionManager;
  storage: Storage;
  sessions: Map<string, Session>;
  workspace: Workspace;
} {
  const workspace: Workspace = {
    id: "w1",
    name: "Test Workspace",
    skills: [],
    systemPromptMode: "append",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    defaultModel: "anthropic/claude-sonnet-4-0",
    hostMount: "/tmp/oppi-fork-lineage-poc-workspace",
  };

  const parent = makeSession({
    id: "parent-1",
    piSessionFile: parentSessionFile,
    piSessionFiles: [parentSessionFile],
  });

  const sessions = new Map<string, Session>([[parent.id, parent]]);
  let childSeq = 0;

  const storage = {
    getConfig: vi.fn(() => TEST_CONFIG),
    getSession: vi.fn((id: string) => sessions.get(id)),
    getWorkspace: vi.fn((id: string) => (id === workspace.id ? workspace : undefined)),
    createSession: vi.fn((name?: string, model?: string) => {
      childSeq += 1;
      return makeSession({
        id: `child-${childSeq}`,
        name,
        model,
        status: "starting",
      });
    }),
    saveSession: vi.fn((session: Session) => {
      sessions.set(session.id, session);
    }),
  } as unknown as Storage;

  const gate = {
    destroySessionGuard: vi.fn(),
    getGuardState: vi.fn(() => "guarded"),
  } as unknown as GateServer;

  const manager = new SessionManager(storage, gate);

  vi.spyOn(manager, "startSession").mockImplementation(async (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    return session;
  });
  vi.spyOn(manager, "refreshSessionState").mockResolvedValue({
    sessionFile: parentSessionFile,
    sessionId: "pi-session-test",
  });
  vi.spyOn(manager, "runCommand").mockResolvedValue({ ok: true });
  vi.spyOn(manager, "sendPrompt").mockResolvedValue();
  vi.spyOn(manager, "broadcast").mockImplementation(() => {});
  vi.spyOn(manager, "stopSession").mockResolvedValue();
  vi.spyOn(manager, "forwardClientCommand").mockResolvedValue();

  return { manager, storage, sessions, workspace };
}

describe("fork lineage POC", () => {
  it("spawnChildSession(fork:true) persists lineage and calls native fork at latest user entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oppi-fork-lineage-"));
    const parentSessionFile = join(dir, "parent.jsonl");
    writeFileSync(
      parentSessionFile,
      jsonl([
        messageEntry("u1", null, "user", "Investigate duplication"),
        messageEntry("a1", "u1", "assistant", "Initial analysis"),
        messageEntry("u2", "a1", "user", "Implement the fix"),
        messageEntry("a2", "u2", "assistant", "Plan the patch"),
      ]),
    );

    try {
      const { manager, sessions } = makeHarness(parentSessionFile);

      const child = await manager.spawnChildSession("parent-1", {
        prompt: "Make the patch",
        fork: true,
      });

      expect(child.parentSessionId).toBe("parent-1");
      expect(child.forkedFromSessionId).toBe("parent-1");
      expect(child.forkPointEntryId).toBe("u2");
      expect(child.rootSessionId).toBe("parent-1");
      expect(child.knowledgeFamilyId).toBe("parent-1");
      expect(child.piSessionFile).toBe(parentSessionFile);

      expect(manager.runCommand).toHaveBeenCalledWith(child.id, {
        type: "fork",
        entryId: "u2",
      });
      expect(manager.sendPrompt).toHaveBeenCalledWith(child.id, "Make the patch");

      const persistedChild = sessions.get(child.id);
      expect(persistedChild?.forkPointEntryId).toBe("u2");
      expect(persistedChild?.knowledgeFamilyId).toBe("parent-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explicit entryId overrides auto-selected fork point", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oppi-fork-lineage-"));
    const parentSessionFile = join(dir, "parent.jsonl");
    writeFileSync(
      parentSessionFile,
      jsonl([
        messageEntry("u1", null, "user", "Root request"),
        messageEntry("a1", "u1", "assistant", "Ack"),
        messageEntry("u2", "a1", "user", "Latest request"),
      ]),
    );

    try {
      const { manager } = makeHarness(parentSessionFile);

      const child = await manager.spawnChildSession("parent-1", {
        prompt: "Branch from the earlier point",
        fork: true,
        entryId: "u1",
      });

      expect(child.forkPointEntryId).toBe("u1");
      expect(manager.runCommand).toHaveBeenCalledWith(child.id, {
        type: "fork",
        entryId: "u1",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POC delta extraction can slice inherited context away after forkPointEntryId", () => {
    const childTrace = jsonl([
      messageEntry("u1", null, "user", "Investigate duplication"),
      messageEntry("a1", "u1", "assistant", "Initial analysis"),
      messageEntry("u2", "a1", "user", "Implement the fix"),
      messageEntry("u-side", "a1", "user", "Old side branch"),
      messageEntry("a-child-1", "u2", "assistant", "Use native fork(entryId)"),
      messageEntry("u-child-2", "a-child-1", "user", "Also persist lineage metadata"),
      messageEntry("a-child-2", "u-child-2", "assistant", "Done"),
    ]);

    const deltaEntries = sliceActivePathAfterEntry(childTrace, "u2");
    const deltaEvents = buildSessionContext(deltaEntries as never);

    expect(deltaEntries.map((entry) => entry.id)).toEqual([
      "a-child-1",
      "u-child-2",
      "a-child-2",
    ]);
    expect(deltaEvents.map((event) => event.text)).toEqual([
      "Use native fork(entryId)",
      "Also persist lineage metadata",
      "Done",
    ]);
    expect(deltaEvents.some((event) => event.text?.includes("Investigate duplication"))).toBe(
      false,
    );
  });
});
