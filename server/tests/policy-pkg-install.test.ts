import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../src/policy.js";
import type { GateRequest } from "../src/policy-types.js";
import type { Rule } from "../src/rules.js";
import { defaultPresetRules } from "../src/policy-presets.js";

// ─── Helpers ─────────────────────────────────────────────────────────

let counter = 0;
function bash(command: string): GateRequest {
  return { tool: "bash", input: { command }, toolCallId: `tc-pkg-${counter++}` };
}

function makeRule(overrides: Partial<Rule> & { tool: string; decision: Rule["decision"] }): Rule {
  return {
    id: `rule-pkg-${counter++}`,
    scope: "global",
    createdAt: Date.now(),
    ...overrides,
  };
}

const SID = "pkg-session";
const WID = "pkg-workspace";

// ─── Host mode: install commands require approval ────────────────────

describe("host policy: package install commands require approval", () => {
  const host = new PolicyEngine("default");

  const installCommands = [
    // npm
    { cmd: "npm install", label: "npm install (bare)" },
    { cmd: "npm install express", label: "npm install <pkg>" },
    { cmd: "npm install --save-dev typescript", label: "npm install --save-dev" },
    { cmd: "npm install -D @types/node", label: "npm install -D" },
    { cmd: "npm install --global prettier", label: "npm install --global" },
    { cmd: "npm i", label: "npm i (bare)" },
    { cmd: "npm i express", label: "npm i <pkg>" },
    { cmd: "npm i -D typescript", label: "npm i -D" },
    { cmd: "npm ci", label: "npm ci" },
    { cmd: "npm ci --legacy-peer-deps", label: "npm ci with flags" },
    { cmd: "npm add lodash", label: "npm add" },

    // yarn
    { cmd: "yarn install", label: "yarn install" },
    { cmd: "yarn install --frozen-lockfile", label: "yarn install --frozen-lockfile" },
    { cmd: "yarn add express", label: "yarn add <pkg>" },
    { cmd: "yarn add -D typescript", label: "yarn add -D" },

    // pnpm
    { cmd: "pnpm install", label: "pnpm install" },
    { cmd: "pnpm i", label: "pnpm i" },
    { cmd: "pnpm i express", label: "pnpm i <pkg>" },
    { cmd: "pnpm add express", label: "pnpm add" },
    { cmd: "pnpm add -D typescript", label: "pnpm add -D" },

    // bun
    { cmd: "bun install", label: "bun install" },
    { cmd: "bun i", label: "bun i" },
    { cmd: "bun i express", label: "bun i <pkg>" },
    { cmd: "bun add express", label: "bun add" },
    { cmd: "bun add -D typescript", label: "bun add -D" },

    // pip
    { cmd: "pip install requests", label: "pip install <pkg>" },
    { cmd: "pip install -r requirements.txt", label: "pip install -r" },
    { cmd: "pip install --upgrade pip", label: "pip install --upgrade" },
    { cmd: "pip3 install flask", label: "pip3 install" },
    { cmd: "pip3 install -e .", label: "pip3 install -e ." },

    // uv
    { cmd: "uv pip install requests", label: "uv pip install" },
    { cmd: "uv pip install -r requirements.txt", label: "uv pip install -r" },
    { cmd: "uv add requests", label: "uv add" },
    { cmd: "uv add --dev pytest", label: "uv add --dev" },

    // pipx
    { cmd: "pipx install black", label: "pipx install" },
    { cmd: "pipx install --python 3.12 ruff", label: "pipx install with flags" },

    // brew
    { cmd: "brew install node", label: "brew install" },
    { cmd: "brew install --cask firefox", label: "brew install --cask" },
    { cmd: "brew install --HEAD neovim", label: "brew install --HEAD" },
    { cmd: "brew reinstall node", label: "brew reinstall" },

    // apt / apt-get
    { cmd: "apt install curl", label: "apt install" },
    { cmd: "apt install -y curl", label: "apt install -y" },
    { cmd: "apt-get install curl", label: "apt-get install" },
    { cmd: "apt-get install -y --no-install-recommends curl", label: "apt-get install complex" },

    // apk
    { cmd: "apk add curl", label: "apk add" },
    { cmd: "apk add --no-cache curl git", label: "apk add --no-cache" },

    // cargo
    { cmd: "cargo install ripgrep", label: "cargo install" },
    { cmd: "cargo install --locked cargo-watch", label: "cargo install --locked" },
    { cmd: "cargo add serde", label: "cargo add" },
    { cmd: "cargo add --features derive serde", label: "cargo add --features" },

    // go
    { cmd: "go install golang.org/x/tools/gopls@latest", label: "go install" },
    { cmd: "go get golang.org/x/text", label: "go get" },
    { cmd: "go get -u ./...", label: "go get -u" },

    // gem
    { cmd: "gem install bundler", label: "gem install" },
    { cmd: "gem install rails --version 7.1", label: "gem install --version" },

    // composer
    { cmd: "composer require laravel/framework", label: "composer require" },
    { cmd: "composer require --dev phpunit/phpunit", label: "composer require --dev" },
    { cmd: "composer install", label: "composer install" },
    { cmd: "composer install --no-dev", label: "composer install --no-dev" },
  ];

  for (const { cmd, label } of installCommands) {
    it(`asks for: ${label} (${cmd})`, () => {
      const d = host.evaluate(bash(cmd));
      expect(d.action).toBe("ask");
    });
  }
});

// ─── Container mode: install commands are allowed ────────────────────

describe("container policy: package install commands are allowed (Docker exempt)", () => {
  const container = new PolicyEngine("container");

  const installCommands = [
    "npm install express",
    "npm i -D typescript",
    "npm ci",
    "npm add lodash",
    "yarn install",
    "yarn add express",
    "pnpm install",
    "pnpm add express",
    "bun install",
    "bun add express",
    "pip install requests",
    "pip3 install flask",
    "uv pip install requests",
    "uv add requests",
    "pipx install black",
    "brew install node",
    "apt install curl",
    "apt-get install -y curl",
    "apk add curl",
    "cargo install ripgrep",
    "cargo add serde",
    "go install golang.org/x/tools/gopls@latest",
    "go get golang.org/x/text",
    "gem install bundler",
    "composer require laravel/framework",
    "composer install",
  ];

  for (const cmd of installCommands) {
    it(`allows: ${cmd}`, () => {
      const d = container.evaluate(bash(cmd));
      expect(d.action).toBe("allow");
    });
  }
});

// ─── Non-install commands stay allowed on host ───────────────────────

describe("host policy: non-install commands for same executables stay allowed", () => {
  const host = new PolicyEngine("default");

  const safeCommands = [
    // npm
    "npm test",
    "npm run build",
    "npm start",
    "npm run dev",
    "npm ls",
    "npm outdated",
    "npm run lint",
    "npm version patch",
    "npm pack",

    // yarn
    "yarn test",
    "yarn run build",
    "yarn dlx create-react-app my-app",

    // pnpm
    "pnpm test",
    "pnpm run build",
    "pnpm dlx create-react-app my-app",

    // bun
    "bun run build",
    "bun test",
    "bun run dev",
    "bun scripts/foo.ts",

    // pip
    "pip list",
    "pip show requests",
    "pip freeze",
    "pip check",
    "pip3 list",
    "pip3 show flask",

    // uv
    "uv run python script.py",
    "uv sync",
    "uv pip list",
    "uv pip show requests",

    // brew
    "brew search node",
    "brew list",
    "brew info node",
    "brew update",
    "brew upgrade",
    "brew doctor",

    // apt
    "apt list --installed",
    "apt search curl",
    "apt show curl",
    "apt-get update",
    "apt-get upgrade",

    // cargo
    "cargo build",
    "cargo test",
    "cargo run",
    "cargo check",
    "cargo fmt",
    "cargo clippy",

    // go
    "go build",
    "go test ./...",
    "go run main.go",
    "go fmt ./...",
    "go vet ./...",
    "go mod tidy",

    // gem
    "gem list",
    "gem search rails",
    "gem env",

    // composer
    "composer update",
    "composer dump-autoload",
    "composer show",
  ];

  for (const cmd of safeCommands) {
    it(`allows: ${cmd}`, () => {
      const d = host.evaluate(bash(cmd));
      expect(d.action).toBe("allow");
    });
  }
});

// ─── Fuzzy: flag ordering and variations ─────────────────────────────

describe("host policy: fuzzy matching catches flag variations", () => {
  const host = new PolicyEngine("default");

  const fuzzyInstalls = [
    // npm with version specifier
    "npm install express@latest",
    "npm install express@^4.0.0",
    // npm with save flags in various positions
    "npm install --save express",
    "npm install --save-exact express@4.18.2",
    // npm i variants
    "npm i --legacy-peer-deps",
    // pip with constraints
    "pip install 'requests>=2.28.0'",
    "pip install requests==2.31.0",
    // brew with tap prefix
    "brew install hashicorp/tap/terraform",
    // cargo from git
    "cargo install --git https://github.com/user/repo",
    // go with version suffix
    "go install github.com/golangci/golangci-lint/cmd/golangci-lint@v1.55.2",
    "go get -u github.com/gorilla/mux",
    // apt with recommended flags
    "apt install --reinstall curl",
    "apt-get install --allow-downgrades libssl-dev",
    // apk with virtual package
    "apk add --virtual .build-deps gcc musl-dev",
    // gem with no-doc
    "gem install rails --no-document",
  ];

  for (const cmd of fuzzyInstalls) {
    it(`catches fuzzy variant: ${cmd}`, () => {
      const d = host.evaluate(bash(cmd));
      expect(d.action).toBe("ask");
    });
  }
});

// ─── Compound commands with install segments ─────────────────────────

describe("host policy: compound commands with install segments", () => {
  const host = new PolicyEngine("default");

  const compoundInstalls = [
    "cd /tmp/project && npm install",
    "cd /tmp/project && npm install && npm run build",
    "git clone https://github.com/user/repo && cd repo && npm install",
    "npm install && npm test",
    "pip install -r requirements.txt && python main.py",
    "brew update && brew install node",
    "apt-get update && apt-get install -y curl",
    "cd project && cargo add serde && cargo build",
    "echo installing && npm ci && echo done",
  ];

  for (const cmd of compoundInstalls) {
    it(`catches install in compound: ${cmd.slice(0, 60)}...`, () => {
      const d = host.evaluate(bash(cmd));
      expect(d.action).toBe("ask");
    });
  }

  // Compound commands with ONLY safe segments should still pass
  const safeCompounds = [
    "npm test && npm run build",
    "cargo build && cargo test",
    "go build && go test ./...",
    "pip list && pip show requests",
    "brew list && brew doctor",
    "cd project && npm run dev",
  ];

  for (const cmd of safeCompounds) {
    it(`allows safe compound: ${cmd}`, () => {
      const d = host.evaluate(bash(cmd));
      expect(d.action).toBe("allow");
    });
  }
});

// ─── evaluateWithRules: preset rules catch installs ──────────────────

describe("evaluateWithRules: default preset rules catch package installs", () => {
  const engine = new PolicyEngine("default");

  // Simulate the seeded default rules (same as what RuleStore gets on first run)
  const presetRules: Rule[] = defaultPresetRules().map((input, idx) => ({
    id: `preset-${idx}`,
    tool: input.tool || "*",
    decision: input.decision || "allow",
    pattern: input.pattern,
    executable: input.executable,
    label: input.label,
    scope: input.scope || "global",
    createdAt: Date.now(),
  }));

  const installTests = [
    { cmd: "npm install express", pkg: "npm" },
    { cmd: "npm i -D typescript", pkg: "npm" },
    { cmd: "npm ci", pkg: "npm ci" },
    { cmd: "yarn add react", pkg: "yarn" },
    { cmd: "pnpm add express", pkg: "pnpm" },
    { cmd: "bun add hono", pkg: "bun" },
    { cmd: "pip install requests", pkg: "pip" },
    { cmd: "pip3 install flask", pkg: "pip" },
    { cmd: "uv add requests", pkg: "uv" },
    { cmd: "brew install node", pkg: "brew" },
    { cmd: "cargo add serde", pkg: "cargo" },
    { cmd: "go install golang.org/x/tools/gopls@latest", pkg: "go" },
    { cmd: "gem install bundler", pkg: "gem" },
    { cmd: "composer require laravel/framework", pkg: "composer" },
  ];

  for (const { cmd, pkg } of installTests) {
    it(`asks via rules: ${cmd}`, () => {
      const result = engine.evaluateWithRules(bash(cmd), presetRules, SID, WID);
      expect(result.action).toBe("ask");
      expect(result.ruleLabel).toContain(pkg);
    });
  }

  // Safe commands should pass through rules too
  const safeTests = [
    "npm test",
    "npm run build",
    "cargo build",
    "go test ./...",
    "pip list",
    "brew list",
  ];

  for (const cmd of safeTests) {
    it(`allows via rules: ${cmd}`, () => {
      const result = engine.evaluateWithRules(bash(cmd), presetRules, SID, WID);
      expect(result.action).toBe("allow");
    });
  }
});

// ─── Fuzz: randomized install commands in compound chains ────────────

describe("fuzz: randomized install commands in compound chains", () => {
  const host = new PolicyEngine("default");

  const safeSegments = [
    "cd /tmp",
    "echo building",
    "ls -la",
    "cat README.md",
    "npm test",
    "npm run build",
    "cargo build",
    "go test ./...",
    "pip list",
    "brew list",
    "git status",
    "pwd",
    "true",
  ];

  const installSegments = [
    "npm install express",
    "npm i -D typescript",
    "npm ci",
    "yarn add react",
    "yarn install",
    "pnpm install",
    "pnpm add express",
    "bun install",
    "bun add hono",
    "pip install requests",
    "pip3 install flask",
    "uv pip install requests",
    "uv add pytest",
    "pipx install black",
    "brew install node",
    "brew install --cask firefox",
    "apt install curl",
    "apt-get install -y curl",
    "apk add curl",
    "cargo install ripgrep",
    "cargo add serde",
    "go install golang.org/x/tools/gopls@latest",
    "go get golang.org/x/text",
    "gem install bundler",
    "composer require laravel/framework",
    "composer install",
  ];

  // Seeded PRNG for reproducibility
  function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };
  }

  const rand = seededRandom(1337);
  function pick<T>(arr: T[]): T {
    return arr[Math.floor(rand() * arr.length)];
  }

  // 150 random compound commands with at least one install segment
  for (let i = 0; i < 150; i++) {
    const numSafe = Math.floor(rand() * 3);
    const segments: string[] = [];
    for (let j = 0; j < numSafe; j++) segments.push(pick(safeSegments));

    const install = pick(installSegments);
    const insertAt = Math.floor(rand() * (segments.length + 1));
    segments.splice(insertAt, 0, install);

    if (rand() > 0.5) segments.push(pick(safeSegments));

    const sep = pick([" && ", " && ", "; "]);
    const cmd = segments.join(sep);

    it(`fuzz #${i}: install at pos ${insertAt}/${segments.length} -> ask`, () => {
      const d = host.evaluate(bash(cmd));
      expect(d.action).toBe("ask");
    });
  }

  // 80 safe-only compounds should all pass
  for (let i = 0; i < 80; i++) {
    const numSegments = 1 + Math.floor(rand() * 3);
    const segments: string[] = [];
    for (let j = 0; j < numSegments; j++) segments.push(pick(safeSegments));
    const cmd = segments.join(pick([" && ", "; "]));

    it(`fuzz safe #${i}: ${numSegments} segments -> allow`, () => {
      const d = host.evaluate(bash(cmd));
      expect(d.action).toBe("allow");
    });
  }
});
