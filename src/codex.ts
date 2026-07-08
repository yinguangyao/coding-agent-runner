/** Codex app-server runner. */
import { RpcClient } from "./rpc-client.js";
import { mapStreamEventToAgentEvents } from "./events.js";
import { createOutputTracker } from "./output-tracker.js";
import type {
  CodexActiveTurnHandle,
  CodexThreadConfigParams,
  CodexUserInput,
  InitializeParams,
  ThreadResult,
  TurnSteerParams,
} from "./codex-types.js";
import type { AgentStreamEvent, AgentTurnStatus, RunnerLogger, SpawnParams, TimingHandler } from "./types.js";

const DEFAULT_CODEX_TURN_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

/** Options for one Codex turn. */
export interface RunCodexTurnOptions {
  /** Codex app-server spawn params. */
  spawn: SpawnParams;
  /** Fallback plain text prompt. */
  prompt: string;
  /** Structured Codex user input. */
  input?: CodexUserInput[];
  /** Existing Codex thread id to resume. */
  threadId?: string | null;
  /** Cancellation signal. */
  signal: AbortSignal;
  /** Raw Codex notification callback. */
  onNotification?: (method: string, params: unknown) => void;
  /** Normalized event callback. */
  onEvent?: (event: AgentStreamEvent) => void;
  /** Active turn callback for steering/interruption. */
  onActiveTurn?: (turn: CodexActiveTurnHandle) => void;
  /** Phase timing callback. */
  onTiming?: TimingHandler;
  /** Logger. */
  logger?: RunnerLogger;
  /** thread.start/resume options. */
  threadStartParams?: CodexThreadConfigParams;
  /** initialize clientInfo. */
  clientInfo?: InitializeParams["clientInfo"];
  /** Semantic inactivity timeout in ms. <=0 disables. */
  inactivityTimeoutMs?: number;
}

/** Normalized Codex turn result. */
export interface CodexTurnOutcome {
  status: AgentTurnStatus;
  output: string;
  threadId: string | null;
  errorMessage: string | null;
  stderrTail: string;
}

/** Options for acquiring a reusable Codex app-server handle. */
export interface AcquireCodexAppServerOptions {
  spawn: SpawnParams;
  clientInfo?: InitializeParams["clientInfo"];
  signal?: AbortSignal;
  onTiming?: TimingHandler;
  logger?: RunnerLogger;
}

/** Reusable Codex app-server handle. */
export interface CodexAppServerHandle {
  readonly spawn: SpawnParams;
  readonly closed: boolean;
  runTurn(opts: Omit<RunCodexTurnOptions, "spawn" | "clientInfo">): Promise<CodexTurnOutcome>;
  close(): Promise<void>;
  getRecentStderr(): string;
}

/** Build Codex app-server thread/start params. */
export function buildThreadStartParams(
  cwd: string,
  params?: CodexThreadConfigParams,
): Record<string, unknown> {
  return {
    model: params?.model ?? null,
    modelProvider: null,
    profile: null,
    cwd,
    approvalPolicy: params?.approvalPolicy ?? null,
    sandbox: params?.sandbox ?? null,
    config: params?.config ?? null,
    baseInstructions: null,
    developerInstructions: params?.developerInstructions ?? null,
    compactPrompt: null,
    includeApplyPatchTool: null,
    experimentalRawEvents: false,
    persistFullHistory: true,
  };
}

/** Build Codex app-server thread/resume params. */
export function buildThreadResumeParams(
  threadId: string,
  params?: CodexThreadConfigParams,
): Record<string, unknown> {
  return {
    threadId,
    ...(params?.config ? { config: params.config } : {}),
    ...(params?.model ? { model: params.model } : {}),
    ...(params?.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
    ...(params?.sandbox ? { sandbox: params.sandbox } : {}),
  };
}

/** Return true when a Codex notification belongs to the current thread. */
export function eventOwnsThread(currentThreadId: string | null, params: unknown): boolean {
  const threadId = (params as { threadId?: string } | undefined)?.threadId;
  if (!currentThreadId || threadId == null) return true;
  return threadId === currentThreadId;
}

/** Spawn and initialize a reusable Codex app-server. */
export async function acquireCodexAppServer(
  opts: AcquireCodexAppServerOptions,
): Promise<CodexAppServerHandle> {
  if (opts.signal?.aborted) throw new Error(readAbortReason(opts.signal) ?? "Codex acquire cancelled");
  const timing = createTiming(opts);
  const client = RpcClient.spawn(opts.spawn);
  timing.mark("spawn", { command: opts.spawn.command });
  const onAbort = (): void => {
    void client.close();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const initParams: InitializeParams = {
      clientInfo: opts.clientInfo ?? { name: "coding-cli-runner", title: "coding-cli-runner", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    };
    await client.sendRequest("initialize", initParams);
    client.sendNotification("initialized");
    timing.mark("initialize");
    return new CodexAppServerHandleImpl(opts.spawn, client, timing.startedAt);
  } catch (err) {
    await client.close();
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Run a one-shot Codex app-server turn. */
export async function runCodexTurn(opts: RunCodexTurnOptions): Promise<CodexTurnOutcome> {
  if (opts.signal.aborted) {
    return {
      status: "cancelled",
      output: "",
      threadId: opts.threadId ?? null,
      errorMessage: readAbortReason(opts.signal) ?? "cancelled",
      stderrTail: "",
    };
  }
  let handle: CodexAppServerHandle | null = null;
  try {
    handle = await acquireCodexAppServer({
      spawn: opts.spawn,
      clientInfo: opts.clientInfo,
      signal: opts.signal,
      onTiming: opts.onTiming,
      logger: opts.logger,
    });
    return await handle.runTurn(opts);
  } catch (err) {
    return {
      status: "failed",
      output: "",
      threadId: opts.threadId ?? null,
      errorMessage: err instanceof Error ? err.message : String(err),
      stderrTail: handle?.getRecentStderr() ?? "",
    };
  } finally {
    await handle?.close();
  }
}

class CodexAppServerHandleImpl implements CodexAppServerHandle {
  private active = false;
  closed = false;

  constructor(
    readonly spawn: SpawnParams,
    private readonly client: RpcClient,
    private readonly startedAt: number,
  ) {}

  async runTurn(opts: Omit<RunCodexTurnOptions, "spawn" | "clientInfo">): Promise<CodexTurnOutcome> {
    if (opts.signal.aborted) {
      return {
        status: "cancelled",
        output: "",
        threadId: opts.threadId ?? null,
        errorMessage: readAbortReason(opts.signal) ?? "cancelled",
        stderrTail: this.client.getRecentStderr(),
      };
    }
    if (this.closed) {
      return {
        status: "failed",
        output: "",
        threadId: opts.threadId ?? null,
        errorMessage: "Codex app-server handle is closed",
        stderrTail: this.client.getRecentStderr(),
      };
    }
    if (this.active) {
      return {
        status: "failed",
        output: "",
        threadId: opts.threadId ?? null,
        errorMessage: "Codex app-server handle already has an active turn",
        stderrTail: this.client.getRecentStderr(),
      };
    }
    this.active = true;
    try {
      return await runCodexTurnOnClient(this.client, this.spawn, opts, this.startedAt, () => {
        this.closed = true;
      });
    } finally {
      this.active = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close();
  }

  getRecentStderr(): string {
    return this.client.getRecentStderr();
  }
}

async function runCodexTurnOnClient(
  client: RpcClient,
  spawn: SpawnParams,
  opts: Omit<RunCodexTurnOptions, "spawn" | "clientInfo">,
  processStartedAt: number,
  markClientClosed: () => void,
): Promise<CodexTurnOutcome> {
  const timing = createTiming({
    logger: opts.logger,
    onTiming: opts.onTiming,
    startedAt: processStartedAt,
    phaseStartedAt: Date.now(),
  });
  const outputTracker = createOutputTracker();
  let threadId: string | null = opts.threadId ?? null;
  let activeTurnId: string | null = null;
  let activeTurnEmitted = false;
  let turnStarted = false;
  let turnSentAt = 0;
  let firstEventLogged = false;
  let turnResolve: ((value: { status: AgentTurnStatus; errorMessage: string | null }) => void) | null = null;
  const turnPromise = new Promise<{ status: AgentTurnStatus; errorMessage: string | null }>((resolve) => {
    turnResolve = resolve;
  });
  const disposers: Array<() => void> = [];

  const inactivityMs = opts.inactivityTimeoutMs ?? DEFAULT_CODEX_TURN_INACTIVITY_TIMEOUT_MS;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  const clearInactivity = (): void => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = null;
  };
  const finishTurn = (status: AgentTurnStatus, errorMessage: string | null): void => {
    if (!turnResolve) return;
    clearInactivity();
    turnResolve({ status, errorMessage });
    turnResolve = null;
  };
  const bumpActivity = (): void => {
    if (inactivityMs <= 0 || !turnResolve) return;
    clearInactivity();
    inactivityTimer = setTimeout(() => {
      opts.logger?.warn("codex.inactivity_timeout", "Codex produced no semantic progress", { ms: inactivityMs, threadId });
      finishTurn("timeout", `Codex produced no semantic progress for ${Math.round(inactivityMs / 1000)}s`);
      void client.close().then(markClientClosed);
    }, inactivityMs);
    inactivityTimer.unref?.();
  };
  const ownsThread = (params: unknown): boolean => eventOwnsThread(threadId, params);
  const emitActiveTurn = (): void => {
    if (activeTurnEmitted || !threadId || !activeTurnId || !opts.onActiveTurn) return;
    activeTurnEmitted = true;
    opts.onActiveTurn({
      threadId,
      turnId: activeTurnId,
      steer: async (input) => {
        if (!threadId || !activeTurnId || !turnResolve) throw new Error("Codex turn is no longer active");
        const params: TurnSteerParams = {
          threadId,
          expectedTurnId: activeTurnId,
          input: normalizeCodexUserInput(input),
        };
        await client.sendRequest("turn/steer", params);
      },
      interrupt: async () => {
        if (!threadId || !activeTurnId || !turnResolve) return;
        await client.sendRequest("turn/interrupt", { threadId, turnId: activeTurnId });
      },
    });
  };
  const dispatchNotification = (method: string, params: unknown): void => {
    bumpActivity();
    if (turnSentAt > 0 && !firstEventLogged && ownsThread(params)) {
      firstEventLogged = true;
      timing.mark("ttft", { method });
    }
    opts.onNotification?.(method, params);
    if (method === "item/agentMessage/delta" && ownsThread(params)) {
      const obj = params as { item?: { id?: string; delta?: string; text?: string }; delta?: string; text?: string } | undefined;
      const itemId = obj?.item?.id ?? "default";
      const delta = obj?.delta || obj?.text || obj?.item?.delta || obj?.item?.text || "";
      if (delta) outputTracker.onDelta(itemId, delta);
    }
    for (const event of mapStreamEventToAgentEvents(method, params)) opts.onEvent?.(event);
  };

  for (const method of ["item/started", "item/progress", "item/agentMessage/delta"]) {
    disposers.push(client.onNotification(method, (params) => dispatchNotification(method, params)));
  }
  disposers.push(client.onNotification("item/completed", (params) => {
    const item = (params as { item?: { id?: string; type?: string; text?: string; phase?: string } } | undefined)?.item;
    if (item?.type === "agentMessage" && ownsThread(params)) {
      outputTracker.onCompleted(item.id ?? "default", item.text, item.phase);
      turnStarted = true;
    }
    dispatchNotification("item/completed", params);
  }));
  disposers.push(client.onNotification("codex/event", (params) => {
    dispatchNotification("codex/event", params);
    const evtType = (params as { msg?: { type?: string } } | undefined)?.msg?.type;
    if (evtType === "task_started") turnStarted = true;
    else if (evtType === "task_complete") finishTurn("completed", null);
    else if (evtType === "turn_aborted") finishTurn("cancelled", null);
  }));
  disposers.push(client.onNotification("turn/started", (params) => {
    opts.onNotification?.("turn/started", params);
    if (!ownsThread(params)) return;
    activeTurnId = readTurnId(params) ?? activeTurnId;
    emitActiveTurn();
    turnStarted = true;
    bumpActivity();
  }));
  disposers.push(client.onNotification("turn/completed", (params) => {
    opts.onNotification?.("turn/completed", params);
    if (!ownsThread(params)) return;
    const turn = (params as { turn?: { status?: string; error?: unknown } } | undefined)?.turn;
    const status = normalizeCodexStatus(turn?.status);
    finishTurn(status, extractErrorMessage(turn?.error));
  }));
  disposers.push(client.onNotification("thread/status/changed", (params) => {
    opts.onNotification?.("thread/status/changed", params);
    if (!ownsThread(params)) return;
    const statusType = (params as { status?: { type?: string } } | undefined)?.status?.type;
    if (statusType === "idle" && turnStarted) finishTurn("completed", null);
    else bumpActivity();
  }));
  disposers.push(client.onNotification("error", (params) => {
    opts.onNotification?.("error", params);
    if ((params as { willRetry?: boolean } | undefined)?.willRetry === true) return;
    finishTurn("failed", extractErrorMessage(params) ?? "Codex emitted an error notification");
  }));
  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "execCommandApproval",
    "applyPatchApproval",
  ]) {
    disposers.push(client.onServerRequest(method, () => ({ decision: "accept" })));
  }

  const onAbort = (): void => {
    finishTurn("cancelled", readAbortReason(opts.signal));
    markClientClosed();
    void (async () => {
      if (threadId && activeTurnId) {
        await Promise.race([
          client.sendRequest("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => undefined),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500);
            timer.unref?.();
          }),
        ]);
      }
      await client.close();
    })();
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (threadId) {
      try {
        const resumed = await client.sendRequest<ThreadResult>("thread/resume", buildThreadResumeParams(threadId, opts.threadStartParams));
        threadId = resumed.thread?.id ?? threadId;
      } catch (err) {
        opts.logger?.warn("codex.thread_resume_failed", "Falling back to thread/start", {
          threadId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        const started = await client.sendRequest<ThreadResult>("thread/start", buildThreadStartParams(spawn.cwd, opts.threadStartParams));
        threadId = started.thread?.id ?? null;
      }
    } else {
      const started = await client.sendRequest<ThreadResult>("thread/start", buildThreadStartParams(spawn.cwd, opts.threadStartParams));
      threadId = started.thread?.id ?? null;
    }
    if (!threadId) throw new Error("Codex thread/start returned no thread id");
    timing.mark("thread", { resumed: opts.threadId != null });

    turnSentAt = Date.now();
    client.sendRequest("turn/start", {
      threadId,
      input: opts.input ?? [makeCodexTextUserInput(opts.prompt)],
    }).then((result) => {
      activeTurnId = readTurnId(result) ?? activeTurnId;
      emitActiveTurn();
    }).catch((err) => {
      finishTurn("failed", err instanceof Error ? err.message : String(err));
    });
    bumpActivity();

    const outcome = await turnPromise;
    timing.mark("turn", { status: outcome.status, ttftMs: firstEventLogged ? undefined : "no-event" });
    return {
      status: outcome.status,
      output: outputTracker.getOutput(),
      threadId,
      errorMessage: outcome.errorMessage,
      stderrTail: client.getRecentStderr(),
    };
  } catch (err) {
    return {
      status: "failed",
      output: outputTracker.getOutput(),
      threadId,
      errorMessage: err instanceof Error ? err.message : String(err),
      stderrTail: client.getRecentStderr(),
    };
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
    clearInactivity();
    for (const dispose of disposers.reverse()) dispose();
  }
}

function createTiming(input: {
  logger?: RunnerLogger;
  onTiming?: TimingHandler;
  startedAt?: number;
  phaseStartedAt?: number;
}) {
  const startedAt = input.startedAt ?? Date.now();
  let phaseStartedAt = input.phaseStartedAt ?? startedAt;
  return {
    startedAt,
    mark(phase: string, extras?: Record<string, unknown>): void {
      const now = Date.now();
      const ms = now - phaseStartedAt;
      input.logger?.info("codex.timing", phase, { ms, sinceSpawnMs: now - startedAt, ...extras });
      input.onTiming?.(phase, ms, { sinceSpawnMs: now - startedAt, ...extras });
      phaseStartedAt = now;
    },
  };
}

function makeCodexTextUserInput(text: string): CodexUserInput {
  return { type: "text", text, text_elements: [] };
}

function normalizeCodexUserInput(input: string | CodexUserInput[]): CodexUserInput[] {
  return typeof input === "string" ? [makeCodexTextUserInput(input)] : input;
}

function readTurnId(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as { turn?: { id?: unknown }; turnId?: unknown };
  if (typeof obj.turn?.id === "string" && obj.turn.id) return obj.turn.id;
  if (typeof obj.turnId === "string" && obj.turnId) return obj.turnId;
  return null;
}

function normalizeCodexStatus(status: string | undefined): AgentTurnStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "canceled" || status === "aborted" || status === "interrupted") return "cancelled";
  return "unknown";
}

function extractErrorMessage(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "string") return input;
  if (input instanceof Error) return input.message;
  if (typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  for (const key of ["message", "error_message", "errorMessage", "detail"]) {
    if (typeof obj[key] === "string" && obj[key]) return obj[key];
  }
  for (const key of ["error", "cause", "data"]) {
    const nested = extractErrorMessage(obj[key]);
    if (nested) return nested;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return null;
  }
}

function readAbortReason(signal: AbortSignal): string | null {
  const reason = signal.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  return null;
}
