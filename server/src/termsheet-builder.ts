/**
 * ASR term sheet builder.
 *
 * Produces a compact system_prompt fragment for ASR models by scanning
 * workspace context for domain-specific proper nouns and technical terms.
 *
 * Architecture:
 *   - TermSource: pluggable interface — anything that yields weighted terms
 *   - Built-in sources: workspace files (AGENTS.md, README, package.json, etc.)
 *   - Optional sources: knowledge index, dictation dictionary, custom glob
 *   - Config: sources list in DictationConfig (asr.termSheetSources)
 *
 * Built-in sources run by default with zero config. They scan standard
 * project files that any workspace is likely to have.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ─── Types ───

export interface WeightedTerm {
  term: string;
  weight: number;
}

/**
 * A source of domain terms. Implementations scan a specific kind of
 * resource and return weighted terms.
 */
export interface TermSource {
  /** Human-readable name for logging. */
  readonly name: string;
  /** Collect terms. Should not throw — return [] on failure. */
  collect(): Promise<WeightedTerm[]>;
}

export interface TermSheetConfig {
  /** Maximum terms in the output. Default: 80. */
  maxTerms?: number;
  /** Additional manually-specified terms (highest priority). */
  manualTerms?: string[];
  /** Extra TermSource paths to scan (globs or absolute paths to files). */
  extraFiles?: string[];
  /** When set, filter regex candidates through this LLM before output. */
  llmCuration?: {
    endpoint: string;
    model: string;
  };
}

// ─── Constants ───

const DEFAULT_MAX_TERMS = 80;
const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 30;

/** Common words to exclude — these never help ASR. */
const STOP_WORDS = new Set([
  // English function words
  "the",
  "this",
  "that",
  "when",
  "with",
  "from",
  "into",
  "use",
  "for",
  "not",
  "but",
  "and",
  "has",
  "get",
  "set",
  "new",
  "run",
  "all",
  "any",
  "each",
  "only",
  "also",
  "must",
  "will",
  "can",
  "may",
  "should",
  "could",
  "would",
  "does",
  "did",
  "was",
  "were",
  "are",
  "its",
  "our",
  "per",
  "via",
  "using",
  "keep",
  "make",
  "like",
  "just",
  "same",
  "more",
  "less",
  "than",
  "then",
  "here",
  "there",
  "where",
  "what",
  "which",
  "about",
  "been",
  "being",
  "have",
  "having",
  "other",
  "before",
  "after",
  "some",
  "every",
  "used",
  "based",
  "want",
  "need",
  "take",
  "give",
  "well",
  // Generic programming terms (too common to help ASR)
  "default",
  "string",
  "none",
  "true",
  "false",
  "error",
  "returns",
  "optional",
  "function",
  "object",
  "array",
  "buffer",
  "promise",
  "async",
  "config",
  "type",
  "class",
  "protocol",
  "struct",
  "enum",
  "int",
  "bool",
  "float",
  "double",
  "void",
  "server",
  "client",
  "session",
  "model",
  "view",
  "test",
  "file",
  "data",
  "path",
  "name",
  "list",
  "item",
  "index",
  "value",
  "state",
  "event",
  "action",
  "result",
  "status",
  "message",
  "request",
  "response",
  "handler",
  "manager",
  "provider",
  "service",
  "update",
  "create",
  "delete",
  "start",
  "stop",
  "open",
  "close",
  "read",
  "write",
  "send",
  "check",
  "build",
  "note",
  "prefer",
  "always",
  "never",
  "code",
  "command",
  "content",
  "directory",
  "document",
  "example",
  "feature",
  "guide",
  "install",
  "library",
  "notes",
  "output",
  "overview",
  "private",
  "production",
  "public",
  "quick",
  "reference",
  "running",
  "setup",
  "shared",
  "structure",
  "testing",
  "version",
  // Markdown heading words (extracted by CamelCase regex from Title Case)
  "description",
  "development",
  "documentation",
  "getting",
  "purpose",
  "requirements",
  "usage",
  "visible",
  "available",
  "commands",
  "configuration",
  "contributing",
  "deployment",
  "frontend",
  "architecture",
  "platform",
  "design",
  "skill",
  "trail",
  "club",
  "committee",
  "hold",
  "post",
  "used",
  "tip",
]);

// ─── Text extraction helpers ───

/** Extract `| term |` entries from markdown tables (e.g., shorthand tables). */
export function extractTableTerms(text: string): WeightedTerm[] {
  const terms: WeightedTerm[] = [];
  const re = /\|\s*(\w+)\s*\|/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const w = m[1];
    if (w.length > MIN_TERM_LENGTH && !["Term", "Meaning", "Name", "Description"].includes(w)) {
      terms.push({ term: w, weight: 5 });
    }
  }
  return terms;
}

/** Extract backtick-delimited terms from markdown. */
export function extractBacktickTerms(text: string): WeightedTerm[] {
  const terms: WeightedTerm[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[1].trim();
    if (isCleanTerm(t) && t.split(" ").length <= 2) {
      terms.push({ term: t, weight: 2 });
    }
  }
  return terms;
}

/**
 * Extract CamelCase identifiers and ALLCAPS acronyms.
 * Requires mixed case (e.g., SwiftUI, XcodeGen) to filter out
 * title-cased English words from markdown headings.
 */
export function extractCodeTerms(text: string): WeightedTerm[] {
  const terms: WeightedTerm[] = [];
  // True CamelCase: must have at least one uppercase->lowercase transition
  // after the first char (e.g., SwiftUI, AppKit) OR contain digits (Qwen3)
  const camelRe = /\b[A-Z][a-zA-Z0-9]{2,30}\b/g;
  let m: RegExpExecArray | null;
  while ((m = camelRe.exec(text)) !== null) {
    const word = m[0];
    // Skip pure title-case words ("Document", "Purpose") — require either:
    // - A mid-word uppercase (SwiftUI, XcodeGen, AppKit)
    // - A digit (Qwen3, iOS26)
    // - All uppercase prefix 2+ (UIKit, APNS — caught by caps regex below)
    const hasMidUpperOrDigit = /[a-z][A-Z]|[A-Z]{2}|\d/.test(word);
    if (hasMidUpperOrDigit && !STOP_WORDS.has(word.toLowerCase())) {
      terms.push({ term: word, weight: 1 });
    }
  }
  // ALLCAPS acronyms (3+ chars): API, CLI, HTTP, APNS
  const capsRe = /\b[A-Z]{3,10}\b/g;
  while ((m = capsRe.exec(text)) !== null) {
    if (!STOP_WORDS.has(m[0].toLowerCase())) {
      terms.push({ term: m[0], weight: 1 });
    }
  }
  return terms;
}

/** Extract `"name": "value"` from JSON-like text. */
export function extractJsonNames(text: string): WeightedTerm[] {
  const terms: WeightedTerm[] = [];
  const re = /"name"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[1].trim();
    if (isCleanTerm(t)) {
      terms.push({ term: t, weight: 3 });
    }
  }
  return terms;
}

function isCleanTerm(t: string): boolean {
  return (
    t.length > MIN_TERM_LENGTH &&
    t.length < MAX_TERM_LENGTH &&
    !/^[-/.#@$*]/.test(t) && // no paths, markdown bold
    !/[(){}=;|&*]/.test(t) && // no code syntax
    !/^\d+$/.test(t) && // no pure numbers
    !/\//.test(t) && // no paths (content/, docs/)
    !/:$/.test(t) && // no labels (chore:, feat:)
    !/^http/.test(t) // no URLs
  );
}

// ─── Built-in sources ───

/**
 * Scan markdown files (AGENTS.md, README.md, CLAUDE.md, CONTRIBUTING.md)
 * in workspace roots. These are high-signal — they're curated documentation
 * that contains project-specific vocabulary.
 */
export class WorkspaceMarkdownSource implements TermSource {
  readonly name = "workspace-markdown";
  private dirs: string[];

  constructor(workspaceDirs: string[]) {
    this.dirs = workspaceDirs;
  }

  async collect(): Promise<WeightedTerm[]> {
    const terms: WeightedTerm[] = [];
    const filenames = [
      "AGENTS.md",
      "README.md",
      "CLAUDE.md",
      "CONTRIBUTING.md",
      "docs/AGENTS.md",
      "docs/README.md",
    ];
    for (const dir of this.dirs) {
      for (const filename of filenames) {
        try {
          const text = await readFile(join(dir, filename), "utf-8");
          terms.push(...extractTableTerms(text));
          terms.push(...extractBacktickTerms(text));
          terms.push(...extractCodeTerms(text));
        } catch {
          /* file doesn't exist */
        }
      }
    }
    return terms;
  }
}

/**
 * Scan package manifests (package.json, project.yml, Cargo.toml, go.mod,
 * pyproject.toml) for project names and dependency names.
 */
export class ProjectManifestSource implements TermSource {
  readonly name = "project-manifests";
  private dirs: string[];

  constructor(workspaceDirs: string[]) {
    this.dirs = workspaceDirs;
  }

  async collect(): Promise<WeightedTerm[]> {
    const terms: WeightedTerm[] = [];
    for (const dir of this.dirs) {
      // package.json
      try {
        const text = await readFile(join(dir, "package.json"), "utf-8");
        terms.push(...extractJsonNames(text));
      } catch {
        /* skip */
      }

      // project.yml (Xcode)
      try {
        const yml = await readFile(join(dir, "project.yml"), "utf-8");
        const nameMatch = yml.match(/^name:\s*(.+)$/m);
        if (nameMatch) {
          const n = nameMatch[1].trim();
          if (isCleanTerm(n)) terms.push({ term: n, weight: 4 });
        }
      } catch {
        /* skip */
      }

      // Cargo.toml
      try {
        const toml = await readFile(join(dir, "Cargo.toml"), "utf-8");
        const nameMatch = toml.match(/^name\s*=\s*"([^"]+)"/m);
        if (nameMatch) {
          const n = nameMatch[1].trim();
          if (isCleanTerm(n)) terms.push({ term: n, weight: 4 });
        }
      } catch {
        /* skip */
      }

      // go.mod
      try {
        const mod = await readFile(join(dir, "go.mod"), "utf-8");
        const modMatch = mod.match(/^module\s+(\S+)/m);
        if (modMatch) {
          const parts = modMatch[1].split("/");
          const n = parts[parts.length - 1];
          if (isCleanTerm(n)) terms.push({ term: n, weight: 4 });
        }
      } catch {
        /* skip */
      }

      // pyproject.toml
      try {
        const toml = await readFile(join(dir, "pyproject.toml"), "utf-8");
        const nameMatch = toml.match(/^name\s*=\s*"([^"]+)"/m);
        if (nameMatch) {
          const n = nameMatch[1].trim();
          if (isCleanTerm(n)) terms.push({ term: n, weight: 4 });
        }
      } catch {
        /* skip */
      }
    }
    return terms;
  }
}

/**
 * Scan arbitrary files for terms. For users who want to point at
 * specific files (e.g., a glossary, a custom dictionary).
 */
export class FileSource implements TermSource {
  readonly name: string;
  private paths: string[];
  private weight: number;

  constructor(paths: string[], weight = 4) {
    this.name = `files(${paths.length})`;
    this.paths = paths;
    this.weight = weight;
  }

  async collect(): Promise<WeightedTerm[]> {
    const terms: WeightedTerm[] = [];
    for (const p of this.paths) {
      try {
        const text = await readFile(p, "utf-8");
        // If it looks like JSON, extract names
        if (p.endsWith(".json")) {
          terms.push(...extractJsonNames(text));
        }
        // Always extract markdown-style and code terms
        terms.push(...extractTableTerms(text));
        terms.push(...extractBacktickTerms(text));
        terms.push(...extractCodeTerms(text));
      } catch {
        /* skip unreadable files */
      }
    }
    return terms.map((t) => ({ ...t, weight: Math.max(t.weight, this.weight) }));
  }
}

/**
 * Scan a directory for text/JSONL files and extract terms.
 * For JSONL, extracts topic tags and CamelCase from description fields.
 * For other text files, extracts backtick, table, and CamelCase terms.
 * Generic — works for knowledge indexes, glossaries, or any text dir.
 */
export class DirectorySource implements TermSource {
  readonly name: string;
  private dir: string;
  private maxFiles: number;

  constructor(dir: string, maxFiles = 20) {
    this.name = `dir(${dir.split("/").slice(-2).join("/")})`;
    this.dir = dir;
    this.maxFiles = maxFiles;
  }

  async collect(): Promise<WeightedTerm[]> {
    const terms: WeightedTerm[] = [];
    try {
      const files = await readdir(this.dir);
      const textFiles = files
        .filter((f) => f.endsWith(".jsonl") || f.endsWith(".txt") || f.endsWith(".md"))
        .sort()
        .slice(-this.maxFiles);
      for (const file of textFiles) {
        try {
          const content = await readFile(join(this.dir, file), "utf-8");
          if (file.endsWith(".jsonl")) {
            for (const line of content.split("\n")) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line) as { description?: string; topics?: string[] };
                if (entry.topics) {
                  for (const topic of entry.topics) {
                    if (topic.length > MIN_TERM_LENGTH) {
                      terms.push({ term: topic, weight: 3 });
                    }
                  }
                }
                if (entry.description) {
                  terms.push(...extractCodeTerms(entry.description));
                }
              } catch {
                /* malformed line */
              }
            }
          } else {
            terms.push(...extractTableTerms(content));
            terms.push(...extractBacktickTerms(content));
            terms.push(...extractCodeTerms(content));
          }
        } catch {
          /* unreadable file */
        }
      }
    } catch {
      /* directory doesn't exist */
    }
    return terms;
  }
}

// ─── Builder ───

/**
 * Build an ASR term sheet from multiple sources.
 *
 * Returns a compact string for injection into the ASR system_prompt,
 * or empty string if no terms were found.
 */
export async function buildTermSheet(
  sources: TermSource[],
  config?: TermSheetConfig,
): Promise<string> {
  const maxTerms = config?.maxTerms ?? DEFAULT_MAX_TERMS;
  const weightMap = new Map<string, number>();

  function add(term: string, weight: number): void {
    const existing = weightMap.get(term) ?? 0;
    weightMap.set(term, existing + weight);
  }

  // Manual terms first (highest priority)
  if (config?.manualTerms) {
    for (const t of config.manualTerms) {
      add(t, 8);
    }
  }

  // Collect from all sources in parallel
  const results = await Promise.all(sources.map((s) => s.collect()));
  for (const terms of results) {
    for (const { term, weight } of terms) {
      add(term, weight);
    }
  }

  // Extra files
  if (config?.extraFiles?.length) {
    const fileSource = new FileSource(config.extraFiles, 4);
    const terms = await fileSource.collect();
    for (const { term, weight } of terms) {
      add(term, weight);
    }
  }

  // Filter, sort, truncate
  let sorted = [...weightMap.entries()]
    .filter(
      ([term]) =>
        term.length > MIN_TERM_LENGTH &&
        term.length < MAX_TERM_LENGTH &&
        !STOP_WORDS.has(term.toLowerCase()) &&
        !/^\d+$/.test(term) && // no pure numbers (port numbers etc.)
        !/^[*_]/.test(term) && // no markdown formatting
        !/[:/]$/.test(term) && // no path/label suffixes
        !/^http/.test(term) && // no URLs
        isCleanTerm(term),
    )
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([term]) => term);

  // Optional LLM curation — filter noise through a local model
  if (config?.llmCuration && sorted.length > 0) {
    try {
      const curated = await curateTermsWithLlm(
        sorted,
        config.llmCuration.endpoint,
        config.llmCuration.model,
      );
      if (curated.length > 0) {
        sorted = curated;
      }
    } catch (err) {
      console.warn(
        "[termsheet] LLM curation failed, using raw terms:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (sorted.length === 0) return "";
  return `Domain terms and proper nouns (transcribe exactly): ${sorted.join(", ")}`;
}

// ─── Convenience: default source assembly ───

/**
 * Build the default set of sources for a given workspace setup.
 * Works out of the box with zero config — just needs workspace directories.
 *
 * Optional extras (extra dirs, dictionary path) are added if provided
 * but don't fail if missing.
 */
export function defaultSources(opts: {
  workspaceDirs: string[];
  extraDirs?: string[];
}): TermSource[] {
  const sources: TermSource[] = [
    new WorkspaceMarkdownSource(opts.workspaceDirs),
    new ProjectManifestSource(opts.workspaceDirs),
  ];
  if (opts.extraDirs) {
    for (const dir of opts.extraDirs) {
      sources.push(new DirectorySource(expandTilde(dir)));
    }
  }
  return sources;
}

/** Resolve ~ to home directory. */
function expandTilde(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Discover workspace directories from Oppi data dir.
 * Reads workspace JSON configs to find hostMount paths.
 */
export async function discoverWorkspaceDirs(dataDir: string): Promise<string[]> {
  const dirs: string[] = [];
  const workspacesDir = join(dataDir, "workspaces");
  try {
    const entries = await readdir(workspacesDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const config = JSON.parse(await readFile(join(workspacesDir, entry), "utf-8")) as {
          hostMount?: string;
        };
        if (config.hostMount) {
          const resolved = expandTilde(config.hostMount);
          const s = await stat(resolved);
          if (s.isDirectory()) {
            dirs.push(resolved);
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no workspaces dir */
  }
  return dirs;
}

// ─── LLM Curation ───

/** In-memory cache: hash of raw candidates → curated result. */
let curationCache: { hash: string; terms: string[] } | null = null;

/**
 * Filter regex-extracted term candidates through a local LLM.
 *
 * Sends the raw term list to the model with instructions to keep only
 * terms that an ASR model would likely mishear or not know. Returns
 * the filtered list. Results are cached by input hash — repeated calls
 * with the same candidates skip the LLM.
 */
export async function curateTermsWithLlm(
  rawTerms: string[],
  endpoint: string,
  model: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  const hash = createHash("sha256").update(rawTerms.join("\n")).digest("hex");
  if (curationCache?.hash === hash) {
    console.log("[termsheet] LLM curation cache hit", { terms: curationCache.terms.length });
    return curationCache.terms;
  }

  const prompt = [
    "You are filtering a list of candidate terms for a speech recognition system prompt.",
    "The goal: keep only terms the model needs help with. Remove noise.",
    "",
    "KEEP:",
    "- Names of people, places, projects, products, organizations",
    "- Technology acronyms relevant to software development",
    "- Technical terms: library names, tool names, framework names, CLI commands",
    "- Non-English words",
    "",
    "REMOVE:",
    "- Ordinary English words that happen to be capitalized or extracted from headings",
    "- Non-technology acronyms that are common abbreviations or unrelated to software",
    "  (e.g. CFO, BBQ, CMS when it means content management, SPC, DOVER)",
    "- File/doc convention names: README, LICENSE, CONTRIBUTING, CHANGELOG, AGENTS",
    "- Date/time placeholders and template patterns",
    "- Multi-word phrases that are normal English sentences, not domain terms",
    "- Generic programming concepts that are common English words (e.g. Reducer, Secretary)",
    "",
    "Return ONLY a JSON array of the terms to keep. No explanation.",
    "",
    `Terms: ${JSON.stringify(rawTerms)}`,
  ].join("\n");

  const url = `${endpoint}/v1/chat/completions`;
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const completion = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response");
  }

  // Parse JSON array from response (may be wrapped in code fences)
  const jsonStr = extractJsonArray(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`LLM returned non-JSON: ${content.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`LLM returned non-array: ${typeof parsed}`);
  }

  // Validate: only keep strings that were in the original list
  const rawSet = new Set(rawTerms);
  const curated = (parsed as unknown[]).filter(
    (t): t is string => typeof t === "string" && rawSet.has(t),
  );

  curationCache = { hash, terms: curated };
  console.log("[termsheet] LLM curation", { candidates: rawTerms.length, kept: curated.length });
  return curated;
}

/** Extract a JSON array from an LLM response (handles code fences). */
function extractJsonArray(content: string): string {
  const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const bracketStart = content.indexOf("[");
  const bracketEnd = content.lastIndexOf("]");
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    return content.slice(bracketStart, bracketEnd + 1);
  }

  return content;
}
