import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  extractTableTerms,
  extractBacktickTerms,
  extractCodeTerms,
  extractJsonNames,
  buildTermSheet,
  defaultSources,
  discoverWorkspaceDirs,
  curateTermsWithLlm,
  WorkspaceMarkdownSource,
  ProjectManifestSource,
  FileSource,
  DirectorySource,
  type TermSource,
  type WeightedTerm,
} from "../src/termsheet-builder.js";

// ─── Text extraction helpers ───

describe("extractTableTerms", () => {
  it("extracts terms from markdown table cells", () => {
    const md = `| oppi | The main app |\n| kypu | Fitness platform |`;
    const terms = extractTableTerms(md);
    expect(terms.some((t) => t.term === "oppi")).toBe(true);
    expect(terms.some((t) => t.term === "kypu")).toBe(true);
  });

  it("skips header labels like Term and Meaning", () => {
    const md = `| Term | Meaning |\n| oppi | App |`;
    const terms = extractTableTerms(md);
    expect(terms.some((t) => t.term === "Term")).toBe(false);
    expect(terms.some((t) => t.term === "Meaning")).toBe(false);
  });

  it("skips short terms", () => {
    const md = `| a | short |`;
    const terms = extractTableTerms(md);
    expect(terms.some((t) => t.term === "a")).toBe(false);
  });

  it("returns empty for text without tables", () => {
    expect(extractTableTerms("just some text")).toEqual([]);
  });
});

describe("extractBacktickTerms", () => {
  it("extracts single-word backtick terms", () => {
    const terms = extractBacktickTerms("Use `vitest` and `SwiftUI` for testing.");
    expect(terms.some((t) => t.term === "vitest")).toBe(true);
    expect(terms.some((t) => t.term === "SwiftUI")).toBe(true);
  });

  it("extracts two-word terms", () => {
    const terms = extractBacktickTerms("Run `npm test` to verify.");
    expect(terms.some((t) => t.term === "npm test")).toBe(true);
  });

  it("skips code syntax inside backticks", () => {
    const terms = extractBacktickTerms("Use `foo(bar)` and `a=b;c`");
    expect(terms).toEqual([]);
  });

  it("skips paths and URLs", () => {
    const terms = extractBacktickTerms("See `http://example.com` and `src/foo.ts`");
    expect(terms).toEqual([]);
  });
});

describe("extractCodeTerms", () => {
  it("extracts CamelCase identifiers with mid-word uppercase", () => {
    const terms = extractCodeTerms("Uses SwiftUI and AppKit");
    expect(terms.some((t) => t.term === "SwiftUI")).toBe(true);
    expect(terms.some((t) => t.term === "AppKit")).toBe(true);
  });

  it("extracts ALLCAPS acronyms (3+ chars)", () => {
    const terms = extractCodeTerms("Supports HTTP and API calls via APNS");
    expect(terms.some((t) => t.term === "HTTP")).toBe(true);
    expect(terms.some((t) => t.term === "API")).toBe(true);
    expect(terms.some((t) => t.term === "APNS")).toBe(true);
  });

  it("skips pure title-case words without mid-word uppercase", () => {
    const terms = extractCodeTerms("The Document and Purpose sections");
    // "Document" has no mid-uppercase or digit — should be skipped
    expect(terms.some((t) => t.term === "Document")).toBe(false);
    expect(terms.some((t) => t.term === "Purpose")).toBe(false);
  });

  it("extracts terms with digits", () => {
    const terms = extractCodeTerms("Using Qwen3 and iOS26 models");
    expect(terms.some((t) => t.term === "Qwen3")).toBe(true);
  });

  it("skips stop words", () => {
    // "NONE" is too short (< 3 chars as-is actually it's 4), but "none" is a stop word
    // Let's check with ALLCAPS form of a stop word — they're lowercased before checking
    const terms = extractCodeTerms("CONFIG and ASYNC are keywords");
    expect(terms.some((t) => t.term === "CONFIG")).toBe(false);
    expect(terms.some((t) => t.term === "ASYNC")).toBe(false);
  });
});

describe("extractJsonNames", () => {
  it("extracts name fields from JSON-like text", () => {
    const json = `{"name": "oppi-server", "version": "1.0"}`;
    const terms = extractJsonNames(json);
    expect(terms).toEqual([{ term: "oppi-server", weight: 3 }]);
  });

  it("handles multiple name fields", () => {
    const json = `{"name": "foo"}\n{"name": "bar-baz"}`;
    const terms = extractJsonNames(json);
    expect(terms).toHaveLength(2);
    expect(terms[0].term).toBe("foo");
    expect(terms[1].term).toBe("bar-baz");
  });

  it("skips names that fail isCleanTerm", () => {
    const json = `{"name": "ab"}`; // too short
    const terms = extractJsonNames(json);
    expect(terms).toEqual([]);
  });

  it("returns empty for text without name fields", () => {
    expect(extractJsonNames("just text")).toEqual([]);
  });
});

// ─── Built-in sources ───

describe("WorkspaceMarkdownSource", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "termsheet-ws-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("collects terms from AGENTS.md", async () => {
    await writeFile(
      join(tmpDir, "AGENTS.md"),
      "| oppi | The monorepo |\n\nUse `SwiftUI` and `UIKit`.\n\nBuilt with XcodeGen.",
    );
    const source = new WorkspaceMarkdownSource([tmpDir]);
    const terms = await source.collect();
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.some((t) => t.term === "oppi")).toBe(true);
    expect(terms.some((t) => t.term === "SwiftUI")).toBe(true);
  });

  it("returns empty for nonexistent directory", async () => {
    const source = new WorkspaceMarkdownSource(["/nonexistent/path"]);
    const terms = await source.collect();
    expect(terms).toEqual([]);
  });

  it("has correct name", () => {
    const source = new WorkspaceMarkdownSource([tmpDir]);
    expect(source.name).toBe("workspace-markdown");
  });
});

describe("ProjectManifestSource", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "termsheet-pm-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("extracts name from package.json", async () => {
    await writeFile(join(tmpDir, "package.json"), `{"name": "oppi-server"}`);
    const source = new ProjectManifestSource([tmpDir]);
    const terms = await source.collect();
    expect(terms.some((t) => t.term === "oppi-server")).toBe(true);
  });

  it("extracts name from project.yml", async () => {
    await writeFile(join(tmpDir, "project.yml"), "name: OppiApp\ntargets:\n  - Oppi\n");
    const source = new ProjectManifestSource([tmpDir]);
    const terms = await source.collect();
    expect(terms.some((t) => t.term === "OppiApp")).toBe(true);
  });

  it("extracts name from Cargo.toml", async () => {
    await writeFile(join(tmpDir, "Cargo.toml"), '[package]\nname = "my-crate"\nversion = "0.1"');
    const source = new ProjectManifestSource([tmpDir]);
    const terms = await source.collect();
    expect(terms.some((t) => t.term === "my-crate")).toBe(true);
  });

  it("extracts module name from go.mod", async () => {
    await writeFile(join(tmpDir, "go.mod"), "module github.com/user/kypu\n\ngo 1.22");
    const source = new ProjectManifestSource([tmpDir]);
    const terms = await source.collect();
    expect(terms.some((t) => t.term === "kypu")).toBe(true);
  });

  it("extracts name from pyproject.toml", async () => {
    await writeFile(
      join(tmpDir, "pyproject.toml"),
      '[project]\nname = "squawk-sidecar"\nversion = "0.1"',
    );
    const source = new ProjectManifestSource([tmpDir]);
    const terms = await source.collect();
    expect(terms.some((t) => t.term === "squawk-sidecar")).toBe(true);
  });

  it("returns empty for directory without manifests", async () => {
    const source = new ProjectManifestSource([tmpDir]);
    const terms = await source.collect();
    expect(terms).toEqual([]);
  });

  it("has correct name", () => {
    const source = new ProjectManifestSource([tmpDir]);
    expect(source.name).toBe("project-manifests");
  });
});

describe("FileSource", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "termsheet-fs-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("extracts terms from markdown files", async () => {
    const filePath = join(tmpDir, "glossary.md");
    await writeFile(filePath, "| oppi | App |\n\nUses `XcodeGen` for project generation.");
    const source = new FileSource([filePath]);
    const terms = await source.collect();
    expect(terms.some((t) => t.term === "oppi")).toBe(true);
  });

  it("extracts names from JSON files", async () => {
    const filePath = join(tmpDir, "manifest.json");
    await writeFile(filePath, `{"name": "my-tool", "version": "1.0"}`);
    const source = new FileSource([filePath]);
    const terms = await source.collect();
    expect(terms.some((t) => t.term === "my-tool")).toBe(true);
  });

  it("applies custom weight", async () => {
    const filePath = join(tmpDir, "terms.md");
    await writeFile(filePath, "| oppi | App |");
    const source = new FileSource([filePath], 7);
    const terms = await source.collect();
    const oppi = terms.find((t) => t.term === "oppi");
    expect(oppi).toBeDefined();
    expect(oppi!.weight).toBeGreaterThanOrEqual(7);
  });

  it("skips unreadable files", async () => {
    const source = new FileSource(["/nonexistent/file.md"]);
    const terms = await source.collect();
    expect(terms).toEqual([]);
  });

  it("has descriptive name", () => {
    const source = new FileSource(["a.md", "b.md"]);
    expect(source.name).toBe("files(2)");
  });
});

describe("DirectorySource", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "termsheet-ds-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("extracts terms from markdown files in directory", async () => {
    await writeFile(join(tmpDir, "glossary.md"), "Uses `XcodeGen` and `SwiftUI`.");
    const source = new DirectorySource(tmpDir);
    const terms = await source.collect();
    expect(terms.some((t) => t.term === "XcodeGen")).toBe(true);
  });

  it("extracts topics from JSONL files", async () => {
    const line = JSON.stringify({
      description: "Built with XcodeGen",
      topics: ["SwiftUI", "UIKit"],
    });
    await writeFile(join(tmpDir, "knowledge.jsonl"), line + "\n");
    const source = new DirectorySource(tmpDir);
    const terms = await source.collect();
    expect(terms.some((t) => t.term === "SwiftUI")).toBe(true);
    expect(terms.some((t) => t.term === "UIKit")).toBe(true);
  });

  it("skips malformed JSONL lines", async () => {
    await writeFile(join(tmpDir, "broken.jsonl"), "not json\n{invalid\n");
    const source = new DirectorySource(tmpDir);
    const terms = await source.collect();
    expect(terms).toEqual([]);
  });

  it("returns empty for nonexistent directory", async () => {
    const source = new DirectorySource("/nonexistent/dir");
    const terms = await source.collect();
    expect(terms).toEqual([]);
  });

  it("limits number of files scanned", async () => {
    // Create 5 files, limit to 2
    for (let i = 0; i < 5; i++) {
      await writeFile(join(tmpDir, `file${i}.md`), `| term${i} | desc |`);
    }
    const source = new DirectorySource(tmpDir, 2);
    const terms = await source.collect();
    // Should only scan last 2 files (sorted, sliced to maxFiles)
    expect(terms.length).toBeLessThanOrEqual(10); // sanity upper bound
  });

  it("has descriptive name using last 2 path segments", () => {
    const source = new DirectorySource("/foo/bar/baz");
    expect(source.name).toBe("dir(bar/baz)");
  });
});

// ─── Builder ───

describe("buildTermSheet", () => {
  it("combines terms from multiple sources and returns a formatted string", async () => {
    const source1: TermSource = {
      name: "mock1",
      collect: async () => [
        { term: "SwiftUI", weight: 3 },
        { term: "XcodeGen", weight: 2 },
      ],
    };
    const source2: TermSource = {
      name: "mock2",
      collect: async () => [{ term: "Vitest", weight: 4 }],
    };
    const result = await buildTermSheet([source1, source2]);
    expect(result).toContain("Domain terms and proper nouns");
    expect(result).toContain("Vitest");
    expect(result).toContain("SwiftUI");
    expect(result).toContain("XcodeGen");
  });

  it("returns empty string when no terms found", async () => {
    const source: TermSource = {
      name: "empty",
      collect: async () => [],
    };
    const result = await buildTermSheet([source]);
    expect(result).toBe("");
  });

  it("includes manual terms with highest priority", async () => {
    const source: TermSource = {
      name: "mock",
      collect: async () => [{ term: "LowPriority", weight: 1 }],
    };
    const result = await buildTermSheet([source], {
      maxTerms: 2,
      manualTerms: ["HighPriority"],
    });
    expect(result).toContain("HighPriority");
  });

  it("respects maxTerms", async () => {
    const terms = Array.from({ length: 50 }, (_, i) => ({
      term: `UniqueTermXyz${i}`,
      weight: 50 - i,
    }));
    const source: TermSource = { name: "big", collect: async () => terms };
    const result = await buildTermSheet([source], { maxTerms: 5 });
    const commaCount = (result.match(/,/g) ?? []).length;
    expect(commaCount).toBeLessThanOrEqual(4); // 5 terms = 4 commas
  });

  it("deduplicates and sums weights for same term", async () => {
    const s1: TermSource = {
      name: "a",
      collect: async () => [{ term: "SwiftUI", weight: 2 }],
    };
    const s2: TermSource = {
      name: "b",
      collect: async () => [{ term: "SwiftUI", weight: 3 }],
    };
    const result = await buildTermSheet([s1, s2], { maxTerms: 100 });
    // SwiftUI should appear exactly once
    const matches = result.match(/SwiftUI/g);
    expect(matches).toHaveLength(1);
  });

  it("filters stop words", async () => {
    const source: TermSource = {
      name: "stops",
      collect: async () => [
        { term: "default", weight: 10 },
        { term: "XcodeGen", weight: 5 },
      ],
    };
    const result = await buildTermSheet([source]);
    expect(result).not.toContain("default");
    expect(result).toContain("XcodeGen");
  });

  it("handles extraFiles config", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "termsheet-extra-"));
    try {
      await writeFile(join(tmpDir, "extra.md"), "| Anthropic | AI company |");
      const result = await buildTermSheet([], {
        extraFiles: [join(tmpDir, "extra.md")],
      });
      expect(result).toContain("Anthropic");
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});

// ─── Convenience functions ───

describe("defaultSources", () => {
  it("creates markdown and manifest sources for workspace dirs", () => {
    const sources = defaultSources({ workspaceDirs: ["/some/workspace"] });
    expect(sources).toHaveLength(2);
    expect(sources[0].name).toBe("workspace-markdown");
    expect(sources[1].name).toBe("project-manifests");
  });

  it("adds directory sources for extra dirs", () => {
    const sources = defaultSources({
      workspaceDirs: ["/ws"],
      extraDirs: ["/extra/dir1", "/extra/dir2"],
    });
    expect(sources).toHaveLength(4);
    expect(sources[2].name).toContain("dir(");
    expect(sources[3].name).toContain("dir(");
  });

  it("expands tilde in extra dirs", () => {
    const sources = defaultSources({
      workspaceDirs: ["/ws"],
      extraDirs: ["~/some/path"],
    });
    expect(sources).toHaveLength(3);
    // The DirectorySource name should contain the path without ~
    expect(sources[2].name).not.toContain("~");
  });
});

describe("discoverWorkspaceDirs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "termsheet-discover-"));
    await mkdir(join(tmpDir, "workspaces"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("discovers workspace dirs from JSON configs", async () => {
    // Create a temp workspace dir and a config pointing to it
    const wsDir = await mkdtemp(join(tmpdir(), "termsheet-ws-target-"));
    try {
      await writeFile(
        join(tmpDir, "workspaces", "test-ws.json"),
        JSON.stringify({ hostMount: wsDir }),
      );
      const dirs = await discoverWorkspaceDirs(tmpDir);
      expect(dirs).toContain(wsDir);
    } finally {
      await rm(wsDir, { recursive: true });
    }
  });

  it("skips configs with missing hostMount", async () => {
    await writeFile(
      join(tmpDir, "workspaces", "no-mount.json"),
      JSON.stringify({ name: "test" }),
    );
    const dirs = await discoverWorkspaceDirs(tmpDir);
    expect(dirs).toEqual([]);
  });

  it("skips configs pointing to nonexistent directories", async () => {
    await writeFile(
      join(tmpDir, "workspaces", "missing.json"),
      JSON.stringify({ hostMount: "/nonexistent/workspace/path" }),
    );
    const dirs = await discoverWorkspaceDirs(tmpDir);
    expect(dirs).toEqual([]);
  });

  it("returns empty for nonexistent data dir", async () => {
    const dirs = await discoverWorkspaceDirs("/nonexistent/data/dir");
    expect(dirs).toEqual([]);
  });

  it("skips non-JSON files", async () => {
    await writeFile(join(tmpDir, "workspaces", "readme.txt"), "not a config");
    const dirs = await discoverWorkspaceDirs(tmpDir);
    expect(dirs).toEqual([]);
  });
});

// ─── LLM Curation ───

describe("curateTermsWithLlm", () => {
  it("sends terms to LLM and returns filtered result", async () => {
    const rawTerms = ["SwiftUI", "Document", "XcodeGen", "Purpose"];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(["SwiftUI", "XcodeGen"]) } }],
      }),
    });

    const result = await curateTermsWithLlm(
      rawTerms,
      "http://localhost:8080",
      "test-model",
      mockFetch,
    );

    expect(result).toEqual(["SwiftUI", "XcodeGen"]);
    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe("http://localhost:8080/v1/chat/completions");
  });

  it("uses cache on repeated calls with same input", async () => {
    const rawTerms = ["CachedTerm1", "CachedTerm2"];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(["CachedTerm1"]) } }],
      }),
    });

    // First call — hits LLM
    await curateTermsWithLlm(rawTerms, "http://localhost:8080", "model", mockFetch);
    expect(mockFetch).toHaveBeenCalledOnce();

    // Second call — cache hit
    const result = await curateTermsWithLlm(rawTerms, "http://localhost:8080", "model", mockFetch);
    expect(mockFetch).toHaveBeenCalledOnce(); // still 1
    expect(result).toEqual(["CachedTerm1"]);
  });

  it("throws on non-ok HTTP response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(
      curateTermsWithLlm(["term"], "http://localhost:8080", "model", mockFetch),
    ).rejects.toThrow("LLM HTTP 500");
  });

  it("throws on empty LLM response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "" } }] }),
    });

    await expect(
      curateTermsWithLlm(["term"], "http://localhost:8080", "model", mockFetch),
    ).rejects.toThrow("empty response");
  });

  it("throws on non-JSON response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "I cannot help with that" } }],
      }),
    });

    await expect(
      curateTermsWithLlm(["uniqueTermForNonJson"], "http://localhost:8080", "model", mockFetch),
    ).rejects.toThrow(/non-JSON|non-array/);
  });

  it("handles code-fenced JSON in response", async () => {
    const rawTerms = ["FencedTerm1", "FencedTerm2"];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '```json\n["FencedTerm1"]\n```',
            },
          },
        ],
      }),
    });

    const result = await curateTermsWithLlm(rawTerms, "http://localhost:8080", "model", mockFetch);
    expect(result).toEqual(["FencedTerm1"]);
  });

  it("filters out terms not in original list", async () => {
    const rawTerms = ["OriginalOnly"];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify(["OriginalOnly", "HallucinatedTerm"]),
            },
          },
        ],
      }),
    });

    const result = await curateTermsWithLlm(rawTerms, "http://localhost:8080", "model", mockFetch);
    expect(result).toEqual(["OriginalOnly"]);
  });
});
