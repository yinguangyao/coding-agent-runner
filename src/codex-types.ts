/** Narrow Codex app-server JSON-RPC protocol types used by this package. */

/** JSON-RPC request envelope. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC notification envelope. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** JSON-RPC response envelope. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC message envelope. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Codex initialize params. */
export interface InitializeParams {
  clientInfo: { name: string; title?: string; version: string };
  capabilities?: { experimentalApi?: boolean; [extra: string]: unknown };
}

/** Codex thread.start runtime options. */
export interface CodexThreadConfigParams {
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "untrusted";
  config?: Record<string, unknown>;
  developerInstructions?: string | null;
}

/** Codex thread result. */
export interface ThreadResult {
  thread?: { id?: string; [extra: string]: unknown };
  [extra: string]: unknown;
}

/** Structured Codex user input block. */
export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; detail?: "auto" | "low" | "high" | "original"; url: string }
  | { type: "localImage"; detail?: "auto" | "low" | "high" | "original"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

/** Codex turn steering params. */
export interface TurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: CodexUserInput[];
}

/** Codex active turn handle. */
export interface CodexActiveTurnHandle {
  threadId: string;
  turnId: string;
  steer: (input: string | CodexUserInput[]) => Promise<void>;
  interrupt: () => Promise<void>;
}
