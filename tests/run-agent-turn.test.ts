import { describe, expect, it, vi } from "vitest";
import { runAgentTurn } from "../src/index.js";

describe("runAgentTurn", () => {
  it("dispatches codex-cli through the Codex app-server runner", async () => {
    const runCodexTurn = vi.fn(async () => ({
      status: "completed" as const,
      output: "ok",
      threadId: "thread-1",
      errorMessage: null,
      stderrTail: "",
    }));

    const result = await runAgentTurn({
      provider: "codex-cli",
      cwd: "/repo",
      model: "gpt-5.5",
      systemPrompt: "You are a strict reviewer.",
      mcpServers: [{
        name: "docs",
        command: "node",
        args: ["/repo/tools/docs-mcp.js"],
        env: { DOCS_TOKEN: "token", EMPTY: undefined },
      }],
      skills: [{ name: "code-review", path: "/repo/.agents/skills/code-review" }],
      prompt: "hello",
      deps: { runCodexTurn },
    });

    expect(result).toMatchObject({
      provider: "codex-cli",
      status: "completed",
      output: "ok",
      sessionId: "thread-1",
    });
    expect(runCodexTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "hello",
      spawn: {
        command: "codex",
        args: ["app-server", "--listen", "stdio://"],
        cwd: "/repo",
      },
      threadStartParams: {
        model: "gpt-5.5",
        developerInstructions: "You are a strict reviewer.",
        config: {
          mcp_servers: {
            docs: {
              command: "node",
              args: ["/repo/tools/docs-mcp.js"],
              env: { DOCS_TOKEN: "token" },
            },
          },
        },
      },
      input: [
        { type: "skill", name: "code-review", path: "/repo/.agents/skills/code-review" },
        { type: "text", text: "hello", text_elements: [] },
      ],
    }));
  });

  it("dispatches claude-code-cli through the native Claude runner", async () => {
    const runClaudeNative = vi.fn(async () => ({
      ok: true,
      output: "ok",
      emittedSessionId: "claude-session",
      errorCode: null,
      errorMessage: null,
    }));

    const result = await runAgentTurn({
      provider: "claude-code-cli",
      cwd: "/repo",
      model: "claude-sonnet-4-5",
      systemPrompt: "You are a strict reviewer.",
      mcpServers: [{
        name: "docs",
        command: "node",
        args: ["/repo/tools/docs-mcp.js"],
        env: { DOCS_TOKEN: "token", EMPTY: undefined },
      }],
      skills: [{ name: "code-review", path: "/repo/.agents/skills/code-review" }],
      prompt: "hello",
      deps: { runClaudeNative },
    });

    expect(result).toMatchObject({
      provider: "claude-code-cli",
      status: "completed",
      output: "ok",
      sessionId: "claude-session",
    });
    expect(runClaudeNative).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "hello",
      cwd: "/repo",
      model: "claude-sonnet-4-5",
      appendSystemPrompt: expect.stringContaining("You are a strict reviewer."),
      mcpServers: [{
        name: "docs",
        command: "node",
        args: ["/repo/tools/docs-mcp.js"],
        env: { DOCS_TOKEN: "token" },
      }],
    }));
    expect(runClaudeNative.mock.calls[0]?.[0].appendSystemPrompt).toContain(
      "Available skills",
    );
    expect(runClaudeNative.mock.calls[0]?.[0].appendSystemPrompt).toContain(
      "code-review: /repo/.agents/skills/code-review",
    );
  });

  it("dispatches ACP providers through AcpConnection", async () => {
    const ensureSession = vi.fn(async () => "acp-session");
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const, crashReason: null }));
    const close = vi.fn(async () => undefined);
    const spawnAcpConnection = vi.fn(async () => ({ ensureSession, prompt, close }));

    const result = await runAgentTurn({
      provider: "cursor-cli",
      cwd: "/repo",
      mcpServers: [{
        name: "docs",
        command: "node",
        args: ["/repo/tools/docs-mcp.js"],
        env: { DOCS_TOKEN: "token", EMPTY: undefined },
      }],
      prompt: "hello",
      deps: { spawnAcpConnection },
    });

    expect(result).toMatchObject({
      provider: "cursor-cli",
      status: "completed",
      sessionId: "acp-session",
    });
    expect(spawnAcpConnection).toHaveBeenCalledWith(expect.objectContaining({
      spawnParams: { label: "cursor-cli", command: "cursor-agent", args: ["acp"] },
      cwd: "/repo",
    }));
    expect(ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: [{
        name: "docs",
        command: "node",
        args: ["/repo/tools/docs-mcp.js"],
        env: [{ name: "DOCS_TOKEN", value: "token" }],
      }],
    }));
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      acpSessionId: "acp-session",
      prompt: "hello",
    }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("applies system prompt fallback for ACP providers", async () => {
    const ensureSession = vi.fn(async () => "acp-session");
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const, crashReason: null }));
    const close = vi.fn(async () => undefined);
    const spawnAcpConnection = vi.fn(async () => ({ ensureSession, prompt, close }));

    await runAgentTurn({
      provider: "cursor-cli",
      cwd: "/repo",
      systemPrompt: "You are a strict reviewer.",
      skills: [{ name: "code-review", path: "/repo/.agents/skills/code-review" }],
      prompt: "hello",
      deps: { spawnAcpConnection },
    });

    const acpPrompt = prompt.mock.calls[0]?.[0].prompt;
    expect(acpPrompt).toContain("<system>");
    expect(acpPrompt).toContain("You are a strict reviewer.");
    expect(acpPrompt).toContain("Available skills");
    expect(acpPrompt).toContain("code-review: /repo/.agents/skills/code-review");
    expect(acpPrompt).toContain("<user>\nhello\n</user>");
  });

  it("does not prompt an ACP provider when the signal aborts during session setup", async () => {
    const controller = new AbortController();
    const ensureSession = vi.fn(async () => {
      controller.abort(new Error("setup cancelled"));
      return "acp-session";
    });
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const, crashReason: null }));
    const close = vi.fn(async () => undefined);
    const spawnAcpConnection = vi.fn(async () => ({ ensureSession, prompt, close }));

    const result = await runAgentTurn({
      provider: "cursor-cli",
      cwd: "/repo",
      prompt: "hello",
      signal: controller.signal,
      deps: { spawnAcpConnection },
    });

    expect(result).toMatchObject({
      provider: "cursor-cli",
      status: "cancelled",
      output: "",
      sessionId: "acp-session",
      errorMessage: "setup cancelled",
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
