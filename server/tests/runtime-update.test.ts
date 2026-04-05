import { describe, expect, it } from "vitest";

import { RuntimeUpdateManager } from "../src/runtime-update.js";

describe("RuntimeUpdateManager", () => {
  it("reports current version", async () => {
    const manager = new RuntimeUpdateManager({
      currentVersion: "0.62.0",
    });

    const status = await manager.getStatus();

    expect(status.currentVersion).toBe("0.62.0");
    expect(status.updateAvailable).toBe(false);
    expect(status.checking).toBe(false);
  });

  it("returns error when runtime dir not found", async () => {
    // Override HOME so resolveRuntimeDir() can't find ~/.config/oppi/server-runtime
    const origHome = process.env.HOME;
    const origArgv1 = process.argv[1];
    try {
      process.env.HOME = "/tmp/nonexistent-oppi-test";
      process.argv[1] = "/tmp/nonexistent-oppi-test/cli.js";

      const manager = new RuntimeUpdateManager({
        currentVersion: "0.62.0",
      });

      const result = await manager.updateRuntime();

      expect(result.ok).toBe(false);
      expect(result.restartRequired).toBe(false);
    } finally {
      process.env.HOME = origHome;
      process.argv[1] = origArgv1;
    }
  });

  it("uses custom package name", async () => {
    const manager = new RuntimeUpdateManager({
      packageName: "@custom/agent",
      currentVersion: "1.0.0",
    });

    const status = await manager.getStatus();
    expect(status.packageName).toBe("@custom/agent");
  });
});
