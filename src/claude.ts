/** Native Claude Code stream-json runner. */
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mapStreamEventToAgentEvents } from "./events.js";
import type { AgentStreamEvent, ProcessWrapper, TimingHandler } from "./types.js";

/** Stdio MCP server exposed to Claude Code. */
export interface ClaudeMcpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Active Claude turn handle for live steering. */
export interface ClaudeActiveTurnHandle {
  provider: "claude-code-cli";
  sessionId: string | null;
  steer: (text: string) => Promise<void>;
}

/** Claude runner options. */
export interface ClaudeNativeParams {
  prompt: string;
  appendSystemPrompt?: string;
  cwd?: string;
  sessionId?: string;
  resumeSessionId?: string | null;
  onSessionId?: (sessionId: string) => void;
  model?: string | null;
  signal?: AbortSignal;
  onLine?: (event: unknown) => void;
  onEvent?: (event: AgentStreamEvent) => void;
  wrapper?: ProcessWrapper;
  env?: Record<string, string | undefined>;
  mcpServers?: ClaudeMcpServerSpec[];
  disableSlashCommands?: boolean;
  dangerouslySkipPermissions?: boolean;
  onTiming?: TimingHandler;
  onActiveTurn?: (turn: ClaudeActiveTurnHandle) => void;
  onActiveTurnClosed?: () => void;
}

/** Claude runner result. */
export interface ClaudeNativeResult {
  ok: boolean;
  output: string;
  emittedSessionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface ClaudeSpawnSpec {
  spawnCommand: string;
  spawnArgs: string[];
  requestedSessionId: string | null;
}

/** Run one Claude Code stream-json turn. */
export async function runClaudeNative(params: ClaudeNativeParams): Promise<ClaudeNativeResult> {
  if (params.signal?.aborted) return cancelledClaudeResult(null);
  const { spawnCommand, spawnArgs, requestedSessionId } = buildClaudeSpawnSpec(params);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let buffer = "";
    let output = "";
    let stderr = "";
    let emittedSessionId: string | null = null;
    let sessionReported = false;
    let inputClosed = false;
    let firstByte = false;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    params.onTiming?.("spawn", Date.now() - startedAt, { command: spawnCommand });

    const closeInput = (): void => {
      if (inputClosed) return;
      inputClosed = true;
      try {
        child.stdin?.end();
      } catch {
        // best effort
      }
      try {
        params.onActiveTurnClosed?.();
      } catch {
        // callback is best effort
      }
    };
    const writeInput = (text: string): Promise<void> => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || inputClosed) return Promise.reject(new Error("Claude input stream is closed"));
      return new Promise((resolveWrite, rejectWrite) => {
        stdin.write(`${JSON.stringify(buildClaudeUserInput(text))}\n`, (err) => {
          if (err) rejectWrite(err);
          else resolveWrite();
        });
      });
    };
    writeInput(params.prompt).catch((err) => {
      stderr += `\nFailed to write Claude stream-json input: ${err instanceof Error ? err.message : String(err)}`;
      killChildProcess(child, "SIGTERM");
    });
    params.onActiveTurn?.({ provider: "claude-code-cli", sessionId: requestedSessionId, steer: writeInput });

    const abortKillTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    const onAbort = (): void => {
      killChildProcess(child, "SIGTERM");
      abortKillTimer.current = setTimeout(() => killChildProcess(child, "SIGKILL"), 2000);
      abortKillTimer.current.unref?.();
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (data: Buffer) => {
      if (!firstByte) {
        firstByte = true;
        params.onTiming?.("ttfb", Date.now() - startedAt);
      }
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          output += `${trimmed}\n`;
          params.onEvent?.({ type: "message_delta", text: trimmed });
          continue;
        }
        const sid = (event as { session_id?: unknown }).session_id;
        if (typeof sid === "string" && sid && !emittedSessionId) {
          emittedSessionId = sid;
          if (!inputClosed) params.onActiveTurn?.({ provider: "claude-code-cli", sessionId: sid, steer: writeInput });
          if (!sessionReported) {
            sessionReported = true;
            params.onSessionId?.(sid);
          }
        }
        params.onLine?.(event);
        for (const mapped of mapStreamEventToAgentEvents(event)) params.onEvent?.(mapped);
        output = accumulateClaudeOutput(event, output);
        if ((event as { type?: unknown }).type === "result") closeInput();
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("close", (code, signal) => {
      params.signal?.removeEventListener("abort", onAbort);
      closeInput();
      if (abortKillTimer.current) clearTimeout(abortKillTimer.current);
      params.onTiming?.("total", Date.now() - startedAt, { code, signal });
      if (params.signal?.aborted) {
        resolve(cancelledClaudeResult(emittedSessionId));
        return;
      }
      const ok = code === 0;
      const reportedSessionId =
        !ok && requestedSessionId && emittedSessionId && emittedSessionId !== requestedSessionId
          ? null
          : emittedSessionId;
      resolve({
        ok,
        output,
        emittedSessionId: reportedSessionId,
        errorCode: ok ? null : classifyClaudeError(stderr, code, output),
        errorMessage: ok ? null : stderr.trim().slice(-800) || output.trim().slice(-800) || `claude exited with code ${code}`,
      });
    });
    child.on("error", (err) => {
      params.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

/** Build Claude Code command and args. */
export function buildClaudeSpawnSpec(params: Pick<
  ClaudeNativeParams,
  | "model"
  | "disableSlashCommands"
  | "dangerouslySkipPermissions"
  | "resumeSessionId"
  | "sessionId"
  | "appendSystemPrompt"
  | "mcpServers"
  | "wrapper"
>): ClaudeSpawnSpec {
  const claudeArgs = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--disallowedTools", "AskUserQuestion",
  ];
  if (params.dangerouslySkipPermissions) claudeArgs.push("--dangerously-skip-permissions");
  if (params.model) claudeArgs.push("--model", params.model);
  if (params.disableSlashCommands) claudeArgs.push("--disable-slash-commands");

  let requestedSessionId: string | null = null;
  if (params.resumeSessionId !== undefined) {
    if (params.resumeSessionId) {
      claudeArgs.push("--resume", params.resumeSessionId);
      requestedSessionId = params.resumeSessionId;
    }
  } else if (params.sessionId) {
    claudeArgs.push("--session-id", params.sessionId);
    requestedSessionId = params.sessionId;
  }
  if (params.appendSystemPrompt?.trim()) claudeArgs.push("--append-system-prompt", params.appendSystemPrompt);
  if (params.mcpServers?.length) claudeArgs.push("--mcp-config", writeClaudeMcpConfig(params.mcpServers));

  return {
    spawnCommand: params.wrapper?.command ?? "claude",
    spawnArgs: params.wrapper ? [...params.wrapper.args, "claude", ...claudeArgs] : claudeArgs,
    requestedSessionId,
  };
}

function writeClaudeMcpConfig(servers: ClaudeMcpServerSpec[]): string {
  const file = path.join(os.tmpdir(), `coding-agent-runner-claude-mcp-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((server) => [
      server.name,
      { command: server.command, args: server.args, env: server.env ?? {} },
    ])),
  }), "utf-8");
  return file;
}

function buildClaudeUserInput(text: string): {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
} {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

function accumulateClaudeOutput(event: unknown, previous: string): string {
  if (!event || typeof event !== "object") return previous;
  const obj = event as { type?: unknown; message?: { content?: unknown }; result?: unknown };
  if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
    let next = previous;
    for (const part of obj.message.content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") next += text;
      }
    }
    return next;
  }
  if (obj.type === "result" && typeof obj.result === "string") return obj.result;
  return previous;
}

function classifyClaudeError(stderr: string, code: number | null, stdout = ""): string {
  const lower = `${stderr}\n${stdout}`.toLowerCase();
  if (lower.includes("timeout")) return "provider_timeout";
  if (
    lower.includes("auth") ||
    lower.includes("api key") ||
    lower.includes("unauthorized") ||
    lower.includes("not logged in") ||
    lower.includes("please run /login") ||
    lower.includes("subscription access") ||
    lower.includes("invalid authentication credentials")
  ) return "auth_failed";
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limited";
  if (lower.includes("context") && lower.includes("too")) return "context_too_large";
  if (code === 137 || code === 143) return "provider_cancelled";
  return "execution_failed";
}

function cancelledClaudeResult(sessionId: string | null): ClaudeNativeResult {
  return {
    ok: false,
    output: "",
    emittedSessionId: sessionId,
    errorCode: "cancelled",
    errorMessage: "Task cancelled",
  };
}

function killChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to direct child kill.
  }
  try {
    child.kill(signal);
  } catch {
    // best effort
  }
}
