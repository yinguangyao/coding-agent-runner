import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AcpConnection } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("AcpConnection", () => {
  it("authenticates once when an ACP adapter requires auth before session creation", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = join(__dirname, "fixtures", "auth-required-acp-agent.mjs");
    const conn = await AcpConnection.spawn({
      spawnParams: { label: "cursor-cli", command: process.execPath, args: [fixture] },
      cwd: process.cwd(),
    });

    try {
      const sessionId = await conn.ensureSession({
        workbenchSessionId: "default",
        cwd: process.cwd(),
      });

      expect(sessionId).toBe("session-authenticated");
      expect(consoleError.mock.calls.flat().join("\n")).not.toContain("Failed to parse JSON message");
    } finally {
      consoleError.mockRestore();
      await conn.close();
    }
  });

  it("loads an existing ACP session when the adapter supports session load", async () => {
    const fixture = join(__dirname, "fixtures", "auth-required-acp-agent.mjs");
    const conn = await AcpConnection.spawn({
      spawnParams: { label: "cursor-cli", command: process.execPath, args: [fixture] },
      cwd: process.cwd(),
    });

    try {
      const sessionId = await conn.ensureSession({
        workbenchSessionId: "existing-session",
        cwd: process.cwd(),
      });

      expect(sessionId).toBe("existing-session");
    } finally {
      await conn.close();
    }
  });
});
