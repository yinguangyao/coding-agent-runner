/** ACP stdio connection runner for Cursor Agent, OpenCode, Pi ACP, and similar adapters. */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable, PassThrough } from "node:stream";
import * as acp from "@zed-industries/agent-client-protocol";
import type { ProcessWrapper, RunnerLogger } from "./types.js";

type AcpSessionUpdate = acp.SessionNotification["update"];

/** ACP adapter spawn params. */
export interface AcpSpawnParams {
  label: string;
  command: string;
  args: string[];
}

/** ACP usage notification emitted by newer adapters. */
export interface AcpUsageUpdate {
  size: number;
  used: number;
  cost?: { amount: number; currency: string };
}

/** ACP session/update callback. */
export type SessionUpdateHandler = (update: AcpSessionUpdate) => void;

/** ACP usage callback. */
export type AcpUsageHandler = (usage: AcpUsageUpdate) => void;

/** Prompt result from an ACP adapter. */
export interface PromptOutcome {
  stopReason: string;
  crashReason: string | null;
}

const NOOP_LOGGER: RunnerLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const KNOWN_SESSION_UPDATE_KINDS = new Set<string>([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
]);

/** Long-lived ACP adapter process and JSON-RPC connection. */
export class AcpConnection {
  private readonly sessionMap = new Map<string, string>();
  private readonly pendingPrompts = new Set<PendingPrompt>();
  private closed = false;
  private exitReason: string | null = null;
  private authenticated = false;

  readonly agentCapabilities: acp.AgentCapabilities;

  private constructor(
    private readonly spawnParams: AcpSpawnParams,
    private readonly child: ChildProcess,
    private readonly rpc: acp.ClientSideConnection,
    private readonly fanout: Map<string, SessionUpdateHandler>,
    private readonly logger: RunnerLogger,
    agentCapabilities: acp.AgentCapabilities,
    private readonly authMethods: acp.AuthMethod[],
  ) {
    this.agentCapabilities = agentCapabilities;
  }

  /** Spawn an ACP adapter and initialize the client connection. */
  static async spawn(params: {
    spawnParams: AcpSpawnParams;
    cwd?: string;
    logger?: RunnerLogger;
    wrapper?: ProcessWrapper;
    env?: Record<string, string | undefined>;
    onUsage?: AcpUsageHandler;
  }): Promise<AcpConnection> {
    const logger = params.logger ?? NOOP_LOGGER;
    const finalCommand = params.wrapper?.command ?? params.spawnParams.command;
    const finalArgs = params.wrapper
      ? [...params.wrapper.args, params.spawnParams.command, ...params.spawnParams.args]
      : params.spawnParams.args;
    const child = spawn(finalCommand, finalArgs, {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const text = buf.toString().trim();
      if (text) logger.warn("acp.stderr", text.slice(-400), { label: params.spawnParams.label });
    });

    const fanout = new Map<string, SessionUpdateHandler>();
    const input = Writable.toWeb(child.stdin!) as WritableStream<unknown>;
    const filteredStdout = createAcpUpdateFilter(child.stdout!, params.onUsage);
    const output = Readable.toWeb(filteredStdout as unknown as Readable) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);
    const rpc = new acp.ClientSideConnection(() => makeClientDelegate(fanout, logger), stream);
    const initResp = await rpc.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    if (initResp.protocolVersion < acp.PROTOCOL_VERSION) {
      child.kill("SIGTERM");
      throw new Error(
        `ACP adapter ${params.spawnParams.command} reported protocolVersion=${initResp.protocolVersion}, but client requires >=${acp.PROTOCOL_VERSION}`,
      );
    }
    const conn = new AcpConnection(
      params.spawnParams,
      child,
      rpc,
      fanout,
      logger,
      initResp.agentCapabilities ?? {},
      initResp.authMethods ?? [],
    );
    conn.attachExitHandlers();
    return conn;
  }

  /** Get or create an ACP session for a caller-defined session id. */
  async ensureSession(params: {
    workbenchSessionId: string;
    cwd: string;
    mcpServers?: acp.McpServer[];
    logger?: RunnerLogger;
  }): Promise<string> {
    if (this.closed) throw new AcpConnectionClosedError(this.exitReason ?? "closed");
    const existing = this.sessionMap.get(params.workbenchSessionId);
    if (existing) return existing;
    if (params.workbenchSessionId !== "default" && this.agentCapabilities.loadSession === true) {
      await this.loadSessionWithAuthRetry({
        sessionId: params.workbenchSessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        logger: params.logger,
      });
      this.sessionMap.set(params.workbenchSessionId, params.workbenchSessionId);
      params.logger?.info("acp.session.loaded", "loadSession ok", {
        label: this.spawnParams.label,
        sessionId: params.workbenchSessionId,
      });
      return params.workbenchSessionId;
    }
    const resp = await this.newSessionWithAuthRetry(params);
    this.sessionMap.set(params.workbenchSessionId, resp.sessionId);
    params.logger?.info("acp.session.created", "newSession ok", {
      label: this.spawnParams.label,
      sessionId: resp.sessionId,
    });
    return resp.sessionId;
  }

  /** Send one prompt to an ACP session. */
  async prompt(params: {
    acpSessionId: string;
    prompt: string;
    onUpdate: SessionUpdateHandler;
    signal?: AbortSignal;
    logger?: RunnerLogger;
  }): Promise<PromptOutcome> {
    if (this.closed) return { stopReason: "crashed", crashReason: this.exitReason ?? "closed" };
    const logger = params.logger ?? this.logger;
    this.fanout.set(params.acpSessionId, params.onUpdate);
    let rejectPending: ((err: Error) => void) | null = null;
    const pending: PendingPrompt = {
      acpSessionId: params.acpSessionId,
      reject: (err) => rejectPending?.(err),
    };
    this.pendingPrompts.add(pending);
    const onAbort = (): void => {
      this.rpc.cancel({ sessionId: params.acpSessionId }).catch((err) => {
        logger.warn("acp.cancel_failed", err instanceof Error ? err.message : String(err), {
          sessionId: params.acpSessionId,
        });
      });
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await new Promise<acp.PromptResponse>((resolve, reject) => {
        rejectPending = reject;
        this.rpc.prompt({
          sessionId: params.acpSessionId,
          prompt: [{ type: "text", text: params.prompt }],
        }).then(resolve, reject);
      });
      return { stopReason: String(response.stopReason), crashReason: null };
    } catch (err) {
      if (err instanceof AcpConnectionClosedError) return { stopReason: "crashed", crashReason: err.message };
      throw err;
    } finally {
      params.signal?.removeEventListener("abort", onAbort);
      this.fanout.delete(params.acpSessionId);
      this.pendingPrompts.delete(pending);
    }
  }

  /** Send a cancellation request for a session. */
  async cancelSession(acpSessionId: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.rpc.cancel({ sessionId: acpSessionId });
    } catch {
      // best effort
    }
  }

  /** Close the adapter process. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // best effort
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // best effort
        }
        resolve();
      }, 5000);
      timer.unref?.();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Return whether the adapter process is still usable. */
  isAlive(): boolean {
    return !this.closed;
  }

  private async newSessionWithAuthRetry(params: {
    cwd: string;
    mcpServers?: acp.McpServer[];
    logger?: RunnerLogger;
  }): Promise<acp.NewSessionResponse> {
    const request = { cwd: params.cwd, mcpServers: params.mcpServers ?? [] };
    return this.requestWithAuthRetry(() => this.rpc.newSession(request), params.logger);
  }

  private async loadSessionWithAuthRetry(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: acp.McpServer[];
    logger?: RunnerLogger;
  }): Promise<void> {
    const request = { sessionId: params.sessionId, cwd: params.cwd, mcpServers: params.mcpServers ?? [] };
    await this.requestWithAuthRetry(() => this.rpc.loadSession(request), params.logger);
  }

  private async requestWithAuthRetry<T>(
    request: () => Promise<T>,
    logger?: RunnerLogger,
  ): Promise<T> {
    try {
      return await request();
    } catch (err) {
      if (!isAuthRequiredError(err)) throw err;
      await this.authenticate(err, logger);
      return await request();
    }
  }

  private async authenticate(err: unknown, logger?: RunnerLogger): Promise<void> {
    if (this.authenticated) return;
    const methodId = selectAuthMethodId(this.authMethods, err);
    if (!methodId) throw err;
    logger?.info("acp.auth.required", "Authenticating ACP adapter before session setup", {
      label: this.spawnParams.label,
      methodId,
    });
    await this.rpc.authenticate({ methodId });
    this.authenticated = true;
  }

  private attachExitHandlers(): void {
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.exitReason = `adapter exited code=${code} signal=${signal ?? "null"}`;
      for (const prompt of this.pendingPrompts) prompt.reject(new AcpConnectionClosedError(this.exitReason));
      this.pendingPrompts.clear();
      this.fanout.clear();
      this.sessionMap.clear();
    });
    this.child.on("error", (err) => {
      this.logger.error("acp.child_error", err.message, { label: this.spawnParams.label });
    });
  }
}

function isAuthRequiredError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const obj = err as { code?: unknown; message?: unknown; data?: unknown };
  const text = `${readUnknownString(obj.message)}\n${readUnknownString((obj.data as { message?: unknown } | undefined)?.message)}`.toLowerCase();
  return obj.code === -32000 && text.includes("auth");
}

function selectAuthMethodId(authMethods: acp.AuthMethod[], err: unknown): string | null {
  const advertised = authMethods.find((method) => method.id)?.id;
  if (advertised) return advertised;
  return extractAuthMethodId(err);
}

function extractAuthMethodId(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const obj = err as { message?: unknown; data?: { message?: unknown } };
  const text = `${readUnknownString(obj.message)}\n${readUnknownString(obj.data?.message)}`;
  return /methodId\s+['"`]([^'"`\s]+)['"`]/.exec(text)?.[1] ?? null;
}

function readUnknownString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Error thrown when an ACP adapter exits during a prompt. */
export class AcpConnectionClosedError extends Error {
  constructor(reason: string) {
    super(`ACP connection closed: ${reason}`);
    this.name = "AcpConnectionClosedError";
  }
}

interface PendingPrompt {
  acpSessionId: string;
  reject: (reason: Error) => void;
}

function makeClientDelegate(
  fanout: Map<string, SessionUpdateHandler>,
  logger: RunnerLogger,
): acp.Client {
  return {
    async sessionUpdate(params: acp.SessionNotification): Promise<void> {
      const handler = fanout.get(params.sessionId);
      if (!handler) return;
      try {
        handler(params.update);
      } catch (err) {
        logger.error("acp.update_handler_error", err instanceof Error ? err.message : String(err), {
          sessionId: params.sessionId,
        });
      }
    },
    async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
      const options = params.options ?? [];
      const allow = options.find((option) => /allow|approve|yes/i.test(`${option.optionId} ${option.name}`)) ?? options[0];
      return allow
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    async readTextFile(): Promise<acp.ReadTextFileResponse> {
      throw acp.RequestError.methodNotFound("fs/read_text_file");
    },
    async writeTextFile(): Promise<acp.WriteTextFileResponse> {
      throw acp.RequestError.methodNotFound("fs/write_text_file");
    },
  };
}

function createAcpUpdateFilter(
  upstream: NodeJS.ReadableStream,
  onUsage?: AcpUsageHandler,
): NodeJS.ReadableStream {
  const out = new PassThrough();
  let buffer = "";
  const handleLine = (line: string): void => {
    if (!shouldForwardLine(line)) {
      if (onUsage) tryEmitUsage(line, onUsage);
      return;
    }
    out.write(`${line}\n`);
  };
  upstream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
  });
  upstream.on("end", () => {
    if (buffer) handleLine(buffer);
    out.end();
  });
  upstream.on("error", (err) => out.destroy(err));
  return out;
}

function shouldForwardLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  try {
    const msg = JSON.parse(trimmed) as {
      method?: string;
      params?: { update?: { sessionUpdate?: string } };
    };
    if (msg.method === "session/update") {
      const kind = msg.params?.update?.sessionUpdate;
      if (kind && !KNOWN_SESSION_UPDATE_KINDS.has(kind)) return false;
    }
  } catch {
    // ACP over stdio is JSON-only. Some adapters leak startup logs on stdout;
    // dropping them keeps the JSON-RPC parser from emitting noisy parse errors.
    return false;
  }
  return true;
}

function tryEmitUsage(line: string, onUsage: AcpUsageHandler): void {
  try {
    const msg = JSON.parse(line) as {
      method?: string;
      params?: { update?: { sessionUpdate?: string; size?: unknown; used?: unknown; cost?: unknown } };
    };
    const update = msg.params?.update;
    if (msg.method !== "session/update" || update?.sessionUpdate !== "usage_update") return;
    if (typeof update.size !== "number" || typeof update.used !== "number") return;
    const costObj = update.cost as { amount?: unknown; currency?: unknown } | undefined;
    const cost =
      costObj && typeof costObj.amount === "number" && typeof costObj.currency === "string"
        ? { amount: costObj.amount, currency: costObj.currency }
        : undefined;
    onUsage({ size: update.size, used: update.used, cost });
  } catch {
    // ignore malformed usage notification
  }
}
