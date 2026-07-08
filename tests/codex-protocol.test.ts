import { describe, expect, it } from "vitest";
import {
  buildThreadResumeParams,
  buildThreadStartParams,
  createOutputTracker,
} from "../src/index.js";

describe("codex app-server protocol guards", () => {
  it("builds thread/start params compatible with Codex experimental app-server", () => {
    expect(buildThreadStartParams("/repo", {
      model: "gpt-5",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      config: { mcp_servers: {} },
      developerInstructions: "system",
    })).toEqual({
      model: "gpt-5",
      modelProvider: null,
      profile: null,
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: { mcp_servers: {} },
      baseInstructions: null,
      developerInstructions: "system",
      compactPrompt: null,
      includeApplyPatchTool: null,
      experimentalRawEvents: false,
      persistFullHistory: true,
    });
  });

  it("builds thread/resume params with only explicit runtime overrides", () => {
    expect(buildThreadResumeParams("thread-1", {
      model: "gpt-5",
      sandbox: "danger-full-access",
    })).toEqual({
      threadId: "thread-1",
      model: "gpt-5",
      sandbox: "danger-full-access",
    });
  });

  it("tracks Codex output without duplicating final completed messages", () => {
    const tracker = createOutputTracker();
    tracker.onDelta("msg-1", "hel");
    tracker.onDelta("msg-1", "lo");
    tracker.onCompleted("msg-1", "hello", "final_answer");
    expect(tracker.getOutput()).toBe("hello");
  });
});
