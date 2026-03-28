import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RuntimeUpdateStatus {
  packageName: string;
  currentVersion: string;
  latestVersion?: string;
  pendingVersion?: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  checking: boolean;
  updateInProgress: boolean;
  restartRequired: boolean;
  lastCheckedAt?: number;
  checkError?: string;
  lastUpdatedAt?: number;
  lastUpdateError?: string;
  /** The runtime directory where node_modules live. */
  runtimeDir?: string;
}

export interface RuntimeUpdateResult {
  ok: boolean;
  message: string;
  latestVersion?: string;
  pendingVersion?: string;
  restartRequired: boolean;
  error?: string;
}

type CommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>;

interface RuntimeUpdateManagerOptions {
  packageName?: string;
  currentVersion: string;
  /** Path to bun or npm binary. Default: "bun", falls back to "npm". */
  executable?: string;
  /** Working directory for install (the decoupled runtime dir). */
  cwd?: string;
  checkIntervalMs?: number;
  checkTimeoutMs?: number;
  updateTimeoutMs?: number;
  commandRunner?: CommandRunner;
  now?: () => number;
}

function normalizeVersion(raw: string): string | undefined {
  const match = raw.trim().match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : undefined;
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }

  return [major, minor, patch];
}

function isVersionNewer(candidate: string, current: string): boolean {
  const candidateSemver = parseSemver(candidate);
  const currentSemver = parseSemver(current);

  if (!candidateSemver || !currentSemver) {
    return false;
  }

  for (let i = 0; i < 3; i += 1) {
    if (candidateSemver[i] > currentSemver[i]) {
      return true;
    }
    if (candidateSemver[i] < currentSemver[i]) {
      return false;
    }
  }

  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Manages update checks + apply flow for the server runtime package.
 *
 * The server runtime is decoupled from the app binary:
 * - App bundle ships a seed (dist + node_modules) in Resources/server-seed/
 * - On first launch, the Mac app copies the seed to ~/.config/oppi/server-runtime/
 * - This manager runs `bun install` (or npm) in that writable runtime dir to update deps
 *
 * Strategy:
 * - check latest version via `npm view <package> version` (works with both bun and npm)
 * - apply update via `<executable> install <package>@latest` in the runtime dir
 * - mark restartRequired after successful install
 */
export class RuntimeUpdateManager {
  private readonly packageName: string;
  private readonly currentVersion: string;
  private readonly executable: string;
  private readonly cwd: string | undefined;
  private readonly checkIntervalMs: number;
  private readonly checkTimeoutMs: number;
  private readonly updateTimeoutMs: number;
  private readonly commandRunner: CommandRunner;
  private readonly now: () => number;

  private executableAvailable: boolean | undefined;

  private status: RuntimeUpdateStatus;

  constructor(options: RuntimeUpdateManagerOptions) {
    this.packageName = options.packageName || "@mariozechner/pi-coding-agent";
    this.currentVersion = options.currentVersion;
    this.executable = options.executable || "bun";
    this.cwd = options.cwd;
    this.checkIntervalMs = options.checkIntervalMs ?? 6 * 60 * 60 * 1000;
    this.checkTimeoutMs = options.checkTimeoutMs ?? 4_000;
    this.updateTimeoutMs = options.updateTimeoutMs ?? 3 * 60 * 1000;
    this.commandRunner = options.commandRunner || this.defaultCommandRunner;
    this.now = options.now || Date.now;

    this.status = {
      packageName: this.packageName,
      currentVersion: this.currentVersion,
      updateAvailable: false,
      canUpdate: false,
      checking: false,
      updateInProgress: false,
      restartRequired: false,
      runtimeDir: this.cwd,
    };
  }

  private readonly defaultCommandRunner: CommandRunner = async (file, args, timeoutMs) => {
    const result = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      cwd: this.cwd,
    });

    return result.stdout;
  };

  private snapshot(): RuntimeUpdateStatus {
    return { ...this.status };
  }

  private async ensureExecutableAvailability(): Promise<void> {
    if (this.executableAvailable !== undefined) {
      this.status.canUpdate = this.executableAvailable;
      return;
    }

    try {
      await this.commandRunner(this.executable, ["--version"], this.checkTimeoutMs);
      this.executableAvailable = true;
      this.status.canUpdate = true;
      this.status.checkError = undefined;
    } catch {
      this.executableAvailable = false;
      this.status.canUpdate = false;
      this.status.checkError = `Package manager "${this.executable}" is unavailable`;
    }
  }

  async getStatus(options?: { force?: boolean }): Promise<RuntimeUpdateStatus> {
    await this.ensureExecutableAvailability();

    const force = options?.force === true;
    const now = this.now();
    const stale =
      this.status.lastCheckedAt === undefined ||
      now - this.status.lastCheckedAt >= this.checkIntervalMs;

    if (!force && (!stale || this.status.checking || this.status.updateInProgress)) {
      return this.snapshot();
    }

    this.status.checking = true;
    this.status.lastCheckedAt = now;

    try {
      if (!this.status.canUpdate) {
        this.status.latestVersion = undefined;
        this.status.updateAvailable = false;
        return this.snapshot();
      }

      // Use npm view for version check (works with both bun and npm as executables)
      const viewExecutable = this.executable.endsWith("bun") ? this.executable : "npm";
      const output = await this.commandRunner(
        viewExecutable,
        ["view", this.packageName, "version"],
        this.checkTimeoutMs,
      );
      const latest = normalizeVersion(output);

      if (!latest) {
        this.status.latestVersion = undefined;
        this.status.updateAvailable = false;
        this.status.checkError = `Unable to parse version from registry response for ${this.packageName}`;
        return this.snapshot();
      }

      this.status.latestVersion = latest;
      this.status.checkError = undefined;
      this.status.updateAvailable =
        this.status.pendingVersion === latest ? false : isVersionNewer(latest, this.currentVersion);

      return this.snapshot();
    } catch (err: unknown) {
      this.status.latestVersion = undefined;
      this.status.updateAvailable = false;
      this.status.checkError = errorMessage(err);
      return this.snapshot();
    } finally {
      this.status.checking = false;
    }
  }

  async updateRuntime(): Promise<RuntimeUpdateResult> {
    await this.ensureExecutableAvailability();

    if (!this.status.canUpdate) {
      const message = `Runtime updates require a package manager (${this.executable} not found)`;
      this.status.lastUpdateError = message;
      return {
        ok: false,
        message,
        error: message,
        restartRequired: this.status.restartRequired,
      };
    }

    if (this.status.updateInProgress) {
      const message = "Runtime update already in progress";
      return {
        ok: false,
        message,
        error: message,
        restartRequired: this.status.restartRequired,
      };
    }

    this.status.updateInProgress = true;

    try {
      const checked = await this.getStatus({ force: true });
      const expectedVersion = checked.latestVersion;

      // Install in the decoupled runtime directory
      await this.commandRunner(
        this.executable,
        ["install", `${this.packageName}@latest`],
        this.updateTimeoutMs,
      );

      const refreshed = await this.getStatus({ force: true });
      const pendingVersion = refreshed.latestVersion || expectedVersion;

      this.status.pendingVersion = pendingVersion;
      this.status.lastUpdatedAt = this.now();
      this.status.lastUpdateError = undefined;
      this.status.restartRequired = true;
      this.status.updateAvailable = false;

      const message = pendingVersion
        ? `Installed ${this.packageName}@${pendingVersion}. Restart server to apply.`
        : `Installed latest ${this.packageName}. Restart server to apply.`;

      return {
        ok: true,
        message,
        latestVersion: refreshed.latestVersion,
        pendingVersion,
        restartRequired: true,
      };
    } catch (err: unknown) {
      const message = `Runtime update failed: ${errorMessage(err)}`;
      this.status.lastUpdateError = message;

      return {
        ok: false,
        message,
        error: message,
        latestVersion: this.status.latestVersion,
        pendingVersion: this.status.pendingVersion,
        restartRequired: this.status.restartRequired,
      };
    } finally {
      this.status.updateInProgress = false;
    }
  }
}
