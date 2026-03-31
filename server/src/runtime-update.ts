/**
 * Runtime version reporter.
 *
 * The pi runtime ships bundled inside the Mac app. Updates are delivered
 * through Sparkle (Mac app auto-updater), which re-seeds the runtime
 * directory on launch when the version changes. There is no separate
 * npm-based update mechanism.
 *
 * This class provides the status shape that `/server/runtime/status`
 * and `/server/info` return so the iOS client can display the current
 * version.
 */

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
}

export interface RuntimeUpdateResult {
  ok: boolean;
  message: string;
  latestVersion?: string;
  pendingVersion?: string;
  restartRequired: boolean;
  error?: string;
}

interface RuntimeUpdateManagerOptions {
  packageName?: string;
  currentVersion: string;
}

/**
 * Minimal runtime status reporter.
 *
 * Reports the current pi runtime version. Updates are managed by the
 * Mac app via Sparkle — the server has no self-update capability.
 */
export class RuntimeUpdateManager {
  private readonly packageName: string;
  private readonly currentVersion: string;

  constructor(options: RuntimeUpdateManagerOptions) {
    this.packageName = options.packageName || "@mariozechner/pi-coding-agent";
    this.currentVersion = options.currentVersion;
  }

  async getStatus(_options?: { force?: boolean }): Promise<RuntimeUpdateStatus> {
    return {
      packageName: this.packageName,
      currentVersion: this.currentVersion,
      updateAvailable: false,
      canUpdate: false,
      checking: false,
      updateInProgress: false,
      restartRequired: false,
    };
  }

  async updateRuntime(): Promise<RuntimeUpdateResult> {
    return {
      ok: false,
      message: "Runtime updates are managed by the Mac app (Sparkle auto-updater)",
      restartRequired: false,
    };
  }
}
