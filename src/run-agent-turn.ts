/** High-level one-shot runner across supported coding-agent providers. */
import { AcpConnection, type AcpMcpServer, type AcpSpawnParams, type PromptOutcome, type SessionUpdateHandler } from "./acp.js";
import { buildDefaultSpawn, getProviderConfig } from "./adapters.js";
import { runClaudeNative, type ClaudeNativeParams, type ClaudeNativeResult } from "./claude.js";
import { runCodexTurn, type CodexTurnOutcome, type RunCodexTurnOptions } from "./codex.js";
import { mapStreamEventToAgentEvents } from "./events.js";
import type {
  AgentStreamEvent,
  AgentTurnResult,
  AgentTurnStatus,
  CodingAgentMcpServer,
  CodingAgentSkill,
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
    ensureSession: (params: {
      workbenchSessionId: string;
      cwd: string;
      mcpServers?: AcpMcpServer[];
      logger?: RunnerLogger;
    }) => Promise<string>;
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
  mcpServers?: CodingAgentMcpServer[];
  skills?: CodingAgentSkill[];
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
      input: buildCodexInput(opts.prompt, opts.skills),
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
      appendSystemPrompt: buildPromptSystemContext(opts.systemPrompt, opts.skills) ?? undefined,
      resumeSessionId: opts.sessionId ?? undefined,
      signal,
      env: spawn.env,
      wrapper: spawn.wrapper,
      mcpServers: toClaudeMcpServers(opts.mcpServers),
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
      mcpServers: toAcpMcpServers(opts.mcpServers),
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
      prompt: applySystemPromptFallback(opts.prompt, buildPromptSystemContext(opts.systemPrompt, opts.skills)),
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
  const developerInstructions = buildPromptSystemContext(opts.systemPrompt, opts.skills);
  const config = buildCodexMcpConfig(opts.mcpServers);
  if (!model && !developerInstructions && !config) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    ...(config ? { config } : {}),
  };
}

function buildCodexMcpConfig(mcpServers: CodingAgentMcpServer[] | undefined): Record<string, unknown> | null {
  const servers = normalizeMcpServers(mcpServers);
  if (servers.length === 0) return null;
  return {
    mcp_servers: Object.fromEntries(servers.map((server) => [
      server.name,
      {
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {}),
      },
    ])),
  };
}

function buildCodexInput(
  prompt: string,
  skills: CodingAgentSkill[] | undefined,
): RunCodexTurnOptions["input"] | undefined {
  const normalized = normalizeSkills(skills);
  if (normalized.length === 0) return undefined;
  return [
    ...normalized.map((skill) => ({ type: "skill" as const, name: skill.name, path: skill.path })),
    { type: "text" as const, text: prompt, text_elements: [] as [] },
  ];
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

function buildPromptSystemContext(
  systemPrompt: string | null | undefined,
  skills: CodingAgentSkill[] | undefined,
): string | null {
  return joinPromptSections(normalizeOptionalText(systemPrompt), buildSkillInstructions(skills));
}

function buildSkillInstructions(skills: CodingAgentSkill[] | undefined): string | null {
  const normalized = normalizeSkills(skills);
  if (normalized.length === 0) return null;
  return [
    "Available skills:",
    ...normalized.map((skill) => {
      const description = normalizeOptionalText(skill.description);
      return `- ${skill.name}: ${description ? `${description} ` : ""}${skill.path}`;
    }),
    "When a task matches a skill, read the skill path before acting and follow it for that turn.",
  ].join("\n");
}

function joinPromptSections(...sections: Array<string | null | undefined>): string | null {
  const normalized = sections.flatMap((section) => {
    const text = normalizeOptionalText(section);
    return text ? [text] : [];
  });
  return normalized.length > 0 ? normalized.join("\n\n") : null;
}

function toClaudeMcpServers(mcpServers: CodingAgentMcpServer[] | undefined): ClaudeNativeParams["mcpServers"] {
  const servers = normalizeMcpServers(mcpServers);
  return servers.length > 0 ? servers : undefined;
}

function toAcpMcpServers(mcpServers: CodingAgentMcpServer[] | undefined): AcpMcpServer[] | undefined {
  const servers = normalizeMcpServers(mcpServers);
  if (servers.length === 0) return undefined;
  return servers.map((server) => ({
    name: server.name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
  }));
}

function normalizeMcpServers(mcpServers: CodingAgentMcpServer[] | undefined): Array<{
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}> {
  return (mcpServers ?? []).map((server) => ({
    name: server.name.trim(),
    command: server.command.trim(),
    args: [...(server.args ?? [])],
    env: normalizeEnv(server.env),
  })).filter((server) => server.name.length > 0 && server.command.length > 0);
}

function normalizeEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const entries = Object.entries(env).filter((entry): entry is [string, string] => (
    entry[0].trim().length > 0 && typeof entry[1] === "string"
  ));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeSkills(skills: CodingAgentSkill[] | undefined): CodingAgentSkill[] {
  return (skills ?? []).flatMap((skill) => {
    const name = normalizeOptionalText(skill.name);
    const path = normalizeOptionalText(skill.path);
    if (!name || !path) return [];
    return [{ name, path, description: normalizeOptionalText(skill.description) ?? undefined }];
  });
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
