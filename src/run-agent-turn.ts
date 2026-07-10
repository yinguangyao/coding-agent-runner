/** High-level one-shot runner across supported coding-agent providers. */
import { AcpConnection, type AcpSpawnParams, type PromptOutcome, type SessionUpdateHandler } from "./acp.js";
import { buildDefaultSpawn, getProviderConfig } from "./adapters.js";
import { runClaudeNative, type ClaudeNativeParams, type ClaudeNativeResult } from "./claude.js";
import { runCodexTurn, type CodexTurnOutcome, type RunCodexTurnOptions } from "./codex.js";
import { mapStreamEventToAgentEvents } from "./events.js";
import type {
  AgentStreamEvent,
  AgentTurnResult,
  AgentTurnStatus,
  CodingCliProvider,
  RunnerLogger,
  SpawnParams,
  TimingHandler,
} from "./types.js";

/** Dependency injection hooks, primarily useful for tests. */
export interface RunAgentTurnDeps {
  runCodexTurn?: (opts: RunCodexTurnOptions) => Promise<CodexTurnOutcome>;
  runClaudeNative?: (opts: ClaudeNativeParams) => Promise<ClaudeNativeResult>;
  spawnAcpConnection?: (opts: {
    spawnParams: AcpSpawnParams;
    cwd?: string;
    logger?: RunnerLogger;
    env?: Record<string, string | undefined>;
  }) => Promise<{
    ensureSession: (params: { workbenchSessionId: string; cwd: string; logger?: RunnerLogger }) => Promise<string>;
    prompt: (params: {
      acpSessionId: string;
      prompt: string;
      onUpdate: SessionUpdateHandler;
      signal?: AbortSignal;
      logger?: RunnerLogger;
    }) => Promise<PromptOutcome>;
    close?: () => Promise<void>;
  }>;
}

/** Options for the high-level one-shot runner. */
export interface RunAgentTurnOptions {
  provider: CodingCliProvider;
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  sessionId?: string | null;
  model?: string | null;
  systemPrompt?: string | null;
  env?: Record<string, string | undefined>;
  spawn?: Partial<Pick<SpawnParams, "command" | "args" | "env" | "wrapper">>;
  onEvent?: (event: AgentStreamEvent) => void;
  onNotification?: (method: string, params: unknown) => void;
  onTiming?: TimingHandler;
  logger?: RunnerLogger;
  deps?: RunAgentTurnDeps;
}

/** Run one prompt with any supported provider. */
export async function runAgentTurn(opts: RunAgentTurnOptions): Promise<AgentTurnResult> {
  const controller = opts.signal ? null : new AbortController();
  const signal = opts.signal ?? controller!.signal;
  const config = getProviderConfig(opts.provider);
  const spawn = mergeSpawn(buildDefaultSpawn(opts.provider, { cwd: opts.cwd, env: opts.env }), opts.spawn);

  if (config.mode === "codex-app-server") {
    const runner = opts.deps?.runCodexTurn ?? runCodexTurn;
    const outcome = await runner({
      spawn,
      prompt: opts.prompt,
      threadId: opts.sessionId,
      signal,
      onEvent: opts.onEvent,
      onNotification: opts.onNotification,
      onTiming: opts.onTiming,
      logger: opts.logger,
      threadStartParams: buildCodexThreadStartParams(opts),
    });
    return {
      provider: opts.provider,
      status: outcome.status,
      output: outcome.output,
      sessionId: outcome.threadId,
      errorMessage: outcome.errorMessage,
      stderrTail: outcome.stderrTail,
    };
  }

  if (config.mode === "claude-native") {
    const runner = opts.deps?.runClaudeNative ?? runClaudeNative;
    const result = await runner({
      prompt: opts.prompt,
      cwd: opts.cwd,
      model: opts.model,
      appendSystemPrompt: normalizeOptionalText(opts.systemPrompt) ?? undefined,
      resumeSessionId: opts.sessionId ?? undefined,
      signal,
      env: spawn.env,
      wrapper: spawn.wrapper,
      onEvent: opts.onEvent,
      onTiming: opts.onTiming,
    });
    return {
      provider: opts.provider,
      status: result.ok ? "completed" : mapErrorCodeToStatus(result.errorCode),
      output: result.output,
      sessionId: result.emittedSessionId,
      errorMessage: result.errorMessage,
    };
  }

  const spawnAcp = opts.deps?.spawnAcpConnection ?? ((params) => AcpConnection.spawn(params));
  const conn = await spawnAcp({
    spawnParams: { label: opts.provider, command: spawn.command, args: spawn.args },
    cwd: opts.cwd,
    logger: opts.logger,
    env: spawn.env,
  });
  let output = "";
  try {
    const acpSessionId = await conn.ensureSession({
      workbenchSessionId: opts.sessionId ?? "default",
      cwd: opts.cwd,
      logger: opts.logger,
    });
    if (signal.aborted) {
      return {
        provider: opts.provider,
        status: "cancelled",
        output,
        sessionId: acpSessionId,
        errorMessage: readAbortReason(signal) ?? "cancelled",
      };
    }
    const outcome = await conn.prompt({
      acpSessionId,
      prompt: applySystemPromptFallback(opts.prompt, opts.systemPrompt),
      signal,
      logger: opts.logger,
      onUpdate: (update) => {
        for (const event of mapStreamEventToAgentEvents(update)) {
          if (event.type === "message_delta") output += event.text;
          if (event.type === "result") output = event.text;
          opts.onEvent?.(event);
        }
      },
    });
    return {
      provider: opts.provider,
      status: mapAcpStopReason(outcome),
      output,
      sessionId: acpSessionId,
      errorMessage: outcome.crashReason,
    };
  } finally {
    await conn.close?.();
  }
}

function buildCodexThreadStartParams(opts: RunAgentTurnOptions): RunCodexTurnOptions["threadStartParams"] {
  const model = normalizeOptionalText(opts.model);
  const developerInstructions = normalizeOptionalText(opts.systemPrompt);
  if (!model && !developerInstructions) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
  };
}

function applySystemPromptFallback(prompt: string, systemPrompt?: string | null): string {
  const normalized = normalizeOptionalText(systemPrompt);
  if (!normalized) return prompt;
  return [
    "<system>",
    normalized,
    "</system>",
    "",
    "<user>",
    prompt,
    "</user>",
  ].join("\n");
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mergeSpawn(base: SpawnParams, override: RunAgentTurnOptions["spawn"]): SpawnParams {
  const env = { ...(base.env ?? {}), ...(override?.env ?? {}) };
  const merged: SpawnParams = {
    ...base,
    ...override,
    args: override?.args ? [...override.args] : base.args,
  };
  if (Object.keys(env).length > 0) merged.env = env;
  return merged;
}

function mapErrorCodeToStatus(errorCode: string | null): AgentTurnStatus {
  if (errorCode === "cancelled" || errorCode === "provider_cancelled") return "cancelled";
  return "failed";
}

function mapAcpStopReason(outcome: PromptOutcome): AgentTurnStatus {
  if (outcome.stopReason === "crashed") return "failed";
  if (["cancelled", "canceled", "aborted", "interrupted"].includes(outcome.stopReason)) return "cancelled";
  return "completed";
}

function readAbortReason(signal: AbortSignal): string | null {
  const reason = signal.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  return null;
}
