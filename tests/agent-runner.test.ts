import { describe, expect, it, vi } from "vitest";
import {
  createCodingAgentRunner,
  runCliAgent,
  streamCliAgent,
} from "../src/index.js";

describe("friendly public runner api", () => {
  it("runCliAgent returns final output for a public provider id", async () => {
    const runAgentTurn = vi.fn(async ({ onEvent }: any) => {
      onEvent?.({ type: "message_delta", text: "hello" });
      return {
        provider: "codex-cli",
        status: "completed",
        output: "hello",
        sessionId: "thread-1",
        errorMessage: null,
      };
    });

    await expect(runCliAgent({
      provider: "codex",
      cwd: "/repo",
      model: "gpt-5",
      prompt: "hi",
      deps: { runAgentTurn },
    })).resolves.toMatchObject({
      ok: true,
      output: "hello",
      provider: "codex",
      sessionId: "thread-1",
    });
    expect(runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5",
    }));
  });

  it("streamCliAgent maps low-level event names to public event names", async () => {
    const runAgentTurn = vi.fn(async ({ onEvent }: any) => {
      onEvent?.({ type: "message_delta", text: "hello" });
      onEvent?.({ type: "thinking_delta", text: "thinking" });
      onEvent?.({ type: "tool_start", id: "tool-1", name: "shell", input: { command: "npm test" } });
      return {
        provider: "codex-cli",
        status: "completed",
        output: "hello",
        sessionId: "thread-1",
        errorMessage: null,
      };
    });

    const events = [];
    for await (const event of streamCliAgent({
      provider: "codex",
      cwd: "/repo",
      prompt: "hi",
      deps: { runAgentTurn },
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "thinking_delta", text: "thinking" },
      { type: "tool_start", id: "tool-1", name: "shell", input: { command: "npm test" } },
      { type: "done", output: "hello", sessionId: "thread-1", stopReason: "completed" },
    ]);
  });

  it("createCodingAgentRunner reuses the previous session id", async () => {
    const runAgentTurn = vi.fn(async () => ({
      provider: "claude-code-cli",
      status: "completed",
      output: "ok",
      sessionId: "session-next",
      errorMessage: null,
    }));
    const runner = await createCodingAgentRunner({
      provider: "claude",
      cwd: "/repo",
      deps: { runAgentTurn },
    });

    for await (const _event of runner.stream({ prompt: "first" })) {
      // consume stream
    }
    for await (const _event of runner.stream({ prompt: "second" })) {
      // consume stream
    }

    expect(runAgentTurn.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-code-cli",
      sessionId: null,
    });
    expect(runAgentTurn.mock.calls[1]?.[0]).toMatchObject({
      provider: "claude-code-cli",
      sessionId: "session-next",
    });
    expect(runner.sessionId).toBe("session-next");
    await runner.close();
  });

  it("runCliAgent throws when the provider returns a failed turn", async () => {
    const runAgentTurn = vi.fn(async () => ({
      provider: "opencode-cli",
      status: "failed",
      output: "",
      sessionId: null,
      errorMessage: "provider failed",
    }));

    await expect(runCliAgent({
      provider: "opencode",
      cwd: "/repo",
      prompt: "hi",
      deps: { runAgentTurn },
    })).rejects.toThrow("provider failed");
  });
});
