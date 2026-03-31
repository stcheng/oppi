import { describe, expect, it } from "vitest";

import { RuntimeUpdateManager } from "../src/runtime-update.js";

describe("RuntimeUpdateManager", () => {
  it("reports current version and no update available", async () => {
    const manager = new RuntimeUpdateManager({
      currentVersion: "0.62.0",
    });

    const status = await manager.getStatus();

    expect(status.currentVersion).toBe("0.62.0");
    expect(status.canUpdate).toBe(false);
    expect(status.updateAvailable).toBe(false);
    expect(status.checking).toBe(false);
  });

  it("returns not-ok for updateRuntime (managed by Mac app)", async () => {
    const manager = new RuntimeUpdateManager({
      currentVersion: "0.62.0",
    });

    const result = await manager.updateRuntime();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Mac app");
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
