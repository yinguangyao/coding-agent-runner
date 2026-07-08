/** JSON-RPC 2.0 over stdio client for Codex app-server. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./codex-types.js";
import type { SpawnParams } from "./types.js";

/** Notification callback for a JSON-RPC method. */
export type NotificationHandler = (params: unknown) => void;

/** Server-initiated request callback. */
export type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

const resolvedBinaryPathCache = new Map<string, string>();

function resolveBinaryPath(name: string): string {
  if (name.includes("/") || name.includes("\\")) return name;
  const cached = resolvedBinaryPathCache.get(name);
  if (cached) return cached;
  let resolved = name;
  try {
    const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf-8" });
    resolved = result.stdout?.split(/\r?\n/).find(Boolean)?.trim() || name;
  } catch {
    // Let spawn use PATH as a fallback.
  }
  resolvedBinaryPathCache.set(name, resolved);
  return resolved;
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

/** Stdio JSON-RPC client. */
export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private buffer = "";
  private closed = false;
  private exitReason: string | null = null;
  private closing: Promise<void> | null = null;
  private readonly stderrLines: string[] = [];

  private constructor(private readonly child: ChildProcess) {
    this.child.stdout?.setEncoding("utf-8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding("utf-8");
    this.child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        this.stderrLines.push(line);
        if (this.stderrLines.length > 50) this.stderrLines.shift();
      }
    });
    this.child.on("exit", (code, signal) => {
      this.exitReason = `exit code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.failAllPending(`process exited (${this.exitReason})`);
      this.closed = true;
    });
    this.child.on("error", (err) => {
      this.exitReason = `spawn error: ${err.message}`;
      this.failAllPending(this.exitReason);
      this.closed = true;
    });
  }

  /** Spawn a JSON-RPC stdio process. */
  static spawn(params: SpawnParams): RpcClient {
    const rawCommand = params.wrapper?.command ?? params.command;
    const command = resolveBinaryPath(rawCommand);
    const args = params.wrapper
      ? [...params.wrapper.args, params.command, ...params.args]
      : params.args;
    const child = spawn(command, args, {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    return new RpcClient(child);
  }

  /** Register a notification handler. */
  onNotification(method: string, handler: NotificationHandler): () => void {
    this.notificationHandlers.set(method, handler);
    return () => {
      if (this.notificationHandlers.get(method) === handler) this.notificationHandlers.delete(method);
    };
  }

  /** Register a server-initiated request handler. */
  onServerRequest(method: string, handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) this.serverRequestHandlers.delete(method);
    };
  }

  /** Send a JSON-RPC request. */
  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`RpcClient is closed (${this.exitReason ?? "unknown"})`));
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject });
      this.writeLine(msg);
    });
  }

  /** Send a JSON-RPC notification. */
  sendNotification(method: string, params?: unknown): void {
    if (this.closed) return;
    this.writeLine({ jsonrpc: "2.0", method, params });
  }

  /** Close the underlying process. */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      // best effort
    }
    this.closing = new Promise((resolve) => {
      const timer = setTimeout(() => {
        killChildProcess(this.child, "SIGKILL");
        resolve();
      }, 2000);
      timer.unref?.();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await this.closing;
  }

  /** Return recent stderr lines for diagnostics. */
  getRecentStderr(): string {
    return this.stderrLines.join("\n");
  }

  private writeLine(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.dispatchLine(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  private dispatchLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if ("id" in msg && (("result" in msg) || ("error" in msg))) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.code} ${msg.error.message}`));
      else pending.resolve(msg.result);
      return;
    }
    if ("method" in msg && !("id" in msg)) {
      this.notificationHandlers.get(msg.method)?.(msg.params);
      return;
    }
    if ("method" in msg && "id" in msg) {
      const handler = this.serverRequestHandlers.get(msg.method);
      if (!handler) {
        this.writeLine({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        return;
      }
      Promise.resolve(handler(msg.params)).then(
        (result) => this.writeLine({ jsonrpc: "2.0", id: msg.id, result }),
        (err) => this.writeLine({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }

  private failAllPending(reason: string): void {
    const err = new Error(reason);
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}
