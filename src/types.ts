/** Shared public types for coding CLI runner providers. */

/** Supported coding-agent CLI providers. */
export type CodingCliProvider =
  | "codex-cli"
  | "claude-code-cli"
  | "cursor-cli"
  | "opencode-cli"
  | "pi-cli";

/** Transport used by a provider adapter. */
export type ProviderMode = "codex-app-server" | "claude-native" | "acp";

/** Provider metadata and default command-line invocation. */
export interface ProviderConfig {
  /** Stable provider id. */
  id: CodingCliProvider;
  /** Human-readable CLI name. */
  displayName: string;
  /** Protocol transport used by this provider. */
  mode: ProviderMode;
  /** Executable name to spawn. */
  command: string;
  /** Default executable arguments. */
  args: string[];
  /** Whether callers usually need to install the CLI globally. */
  localCliRequired: boolean;
  /** Executable used for availability probing, or null for packaged adapters. */
  probeCommand: string | null;
}

/** Optional process wrapper such as a sandbox executable. */
export interface ProcessWrapper {
  /** Wrapper executable. */
  command: string;
  /** Arguments passed before the wrapped command. */
  args: string[];
}

/** Child process spawn configuration. */
export interface SpawnParams {
  /** Executable to spawn. */
  command: string;
  /** Command arguments. */
  args: string[];
  /** Working directory for the agent process. */
  cwd: string;
  /** Environment overrides merged over process.env. */
  env?: Record<string, string | undefined>;
  /** Optional wrapper invoked as `<wrapper> <wrapperArgs> <command> <args>`. */
  wrapper?: ProcessWrapper;
}

/** Normalized event emitted by all provider transports. */
export type AgentStreamEvent =
  | { type: "message_delta"; text: string }
  | { type: "thinking_start"; id: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; id: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown }
  | { type: "tool_update"; id: string; name: string; input?: unknown; output?: string }
  | { type: "tool_end"; id: string; name: string; output: string; isError: boolean }
  | { type: "result"; text: string; isError: boolean };

/** Minimal logger accepted by long-lived connection APIs. */
export interface RunnerLogger {
  debug: (tag: string, message: string, extras?: Record<string, unknown>) => void;
  info: (tag: string, message: string, extras?: Record<string, unknown>) => void;
  warn: (tag: string, message: string, extras?: Record<string, unknown>) => void;
  error: (tag: string, message: string, extras?: Record<string, unknown>) => void;
}

/** Phase timing callback shared by providers. */
export type TimingHandler = (phase: string, ms: number, extras?: Record<string, unknown>) => void;

/** Common terminal status for a provider turn. */
export type AgentTurnStatus = "completed" | "failed" | "cancelled" | "timeout" | "unknown";

/** Result returned by the high-level one-shot runner. */
export interface AgentTurnResult {
  /** Provider used for the turn. */
  provider: CodingCliProvider;
  /** Normalized terminal status. */
  status: AgentTurnStatus;
  /** Accumulated assistant output. */
  output: string;
  /** Provider session/thread id, when available. */
  sessionId: string | null;
  /** Error summary for failed/unknown turns. */
  errorMessage: string | null;
  /** Recent provider stderr, when available. */
  stderrTail?: string;
}
