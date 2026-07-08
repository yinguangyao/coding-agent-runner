import { describe, expect, it } from "vitest";
import {
  buildDefaultSpawn,
  getProviderConfig,
  listProviderConfigs,
} from "../src/index.js";

describe("provider adapter defaults", () => {
  it("matches the AI Workbench CLI commands for every supported provider", () => {
    expect(buildDefaultSpawn("codex-cli", { cwd: "/repo" })).toMatchObject({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      cwd: "/repo",
    });
    expect(getProviderConfig("claude-code-cli")).toMatchObject({
      mode: "claude-native",
      command: "claude",
    });
    expect(buildDefaultSpawn("cursor-cli", { cwd: "/repo" })).toMatchObject({
      command: "cursor-agent",
      args: ["acp"],
      cwd: "/repo",
    });
    expect(buildDefaultSpawn("opencode-cli", { cwd: "/repo" })).toMatchObject({
      command: "opencode",
      args: ["acp"],
      cwd: "/repo",
    });
    expect(buildDefaultSpawn("pi-cli", { cwd: "/repo" })).toMatchObject({
      command: "pi-acp",
      args: [],
      cwd: "/repo",
    });
  });

  it("returns immutable provider config copies", () => {
    const config = getProviderConfig("cursor-cli");
    config.args.push("mutated");
    expect(getProviderConfig("cursor-cli").args).toEqual(["acp"]);
  });

  it("lists all five public providers", () => {
    expect(listProviderConfigs().map((config) => config.id)).toEqual([
      "codex-cli",
      "claude-code-cli",
      "cursor-cli",
      "opencode-cli",
      "pi-cli",
    ]);
  });
});
