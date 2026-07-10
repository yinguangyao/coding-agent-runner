/** Friendly public runner API for local app developers. */
import {
  runAgentTurn,
  type RunAgentTurnOptions,
} from "./run-agent-turn.js";
import type {
  AgentStreamEvent,
  AgentTurnResult,
  AgentTurnStatus,
  RunnerLogger,
  SpawnParams,
  TimingHandler,
} from "./types.js";
import {
  toInternalProvider,
  toPublicProvider,
  type AnyCodingProvider,
  type CodingAgentProvider,
} from "./provider-ids.js";

/** Event union emitted by the friendly public streaming API. */
export type CodingAgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_start"; id: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; id: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown }
  | { type: "tool_update"; id: string; name: string; input?: unknown; output?: string }
  | { type: "tool_end"; id: string; name: string; output: string; isError: boolean }
  | { type: "done"; output: string; sessionId: string | null; stopReason: AgentTurnStatus }
  | { type: "error"; error: Error };

/** Dependency injection hook for tests and host apps with custom dispatch. */
export interface CodingAgentRunnerDeps {
  runAgentTurn?: typeof runAgentTurn;
}

/** Options shared by stateful and one-shot public APIs. */
export interface CodingAgentRunnerOptions {
  provider: AnyCodingProvider;
  cwd: string;
  model?: string | null;
  sessionId?: string | null;
  env?: Record<string, string | undefined>;
  spawn?: Partial<Pick<SpawnParams, "command" | "args" | "env" | "wrapper">>;
  signal?: AbortSignal;
  onTiming?: TimingHandler;
  logger?: RunnerLogger;
  deps?: CodingAgentRunnerDeps;
}

/** Per-turn options for a stateful runner. */
export interface CodingAgentTurnOptions {
  prompt: string;
  signal?: AbortSignal;
}

/** One-shot run options. */
export interface CodingAgentRunOptions extends CodingAgentRunnerOptions, CodingAgentTurnOptions {}

/** One-shot public run result. */
export interface CodingAgentRunResult {
  ok: boolean;
  output: string;
  provider: CodingAgentProvider;
  sessionId: string | null;
  errorMessage: string | null;
}

/** Stateful local coding agent runner. */
export interface CodingAgentRunner {
  readonly provider: CodingAgentProvider;
  readonly sessionId: string | null;
  stream(turn: CodingAgentTurnOptions): AsyncIterable<CodingAgentEvent>;
  close(): Promise<void>;
}

/** Create a stateful runner that reuses the last provider session id. */
export async function createCodingAgentRunner(
  options: CodingAgentRunnerOptions,
): Promise<CodingAgentRunner> {
  return new CodingAgentRunnerImpl(options);
}

/** Stream one prompt and close the implicit runner when done. */
export function streamCliAgent(options: CodingAgentRunOptions): AsyncIterable<CodingAgentEvent> {
  return streamCliAgentInternal(options);
}

/** Run one prompt and return final output. Throws when provider execution fails. */
export async function runCliAgent(options: CodingAgentRunOptions): Promise<CodingAgentRunResult> {
  let output = "";
  let done: Extract<CodingAgentEvent, { type: "done" }> | null = null;

  for await (const event of streamCliAgent(options)) {
    if (event.type === "text_delta") output += event.text;
    if (event.type === "done") done = event;
    if (event.type === "error") throw event.error;
  }

  return {
    ok: true,
    output: done?.output ?? output,
    provider: toPublicProvider(toInternalProvider(options.provider)),
    sessionId: done?.sessionId ?? null,
    errorMessage: null,
  };
}

class CodingAgentRunnerImpl implements CodingAgentRunner {
  readonly provider: CodingAgentProvider;
  private currentSessionId: string | null;

  constructor(private readonly options: CodingAgentRunnerOptions) {
    this.provider = toPublicProvider(toInternalProvider(options.provider));
    this.currentSessionId = options.sessionId ?? null;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  stream(turn: CodingAgentTurnOptions): AsyncIterable<CodingAgentEvent> {
    return streamCliAgentInternal(
      {
        ...this.options,
        prompt: turn.prompt,
        signal: turn.signal ?? this.options.signal,
        sessionId: this.currentSessionId,
      },
      (result) => {
        this.currentSessionId = result.sessionId ?? this.currentSessionId;
      },
    );
  }

  async close(): Promise<void> {
    // Current public runner delegates process ownership to one-shot transports.
  }
}

function streamCliAgentInternal(
  options: CodingAgentRunOptions,
  onResult?: (result: AgentTurnResult) => void,
): AsyncIterable<CodingAgentEvent> {
  const queue = createAsyncEventQueue<CodingAgentEvent>();
  const dispatch = options.deps?.runAgentTurn ?? runAgentTurn;
  const provider = toInternalProvider(options.provider);

  void dispatch({
    provider,
    cwd: options.cwd,
    prompt: options.prompt,
    signal: options.signal,
    sessionId: options.sessionId ?? null,
    model: options.model,
    env: options.env,
    spawn: options.spawn,
    onTiming: options.onTiming,
    logger: options.logger,
    onEvent(event) {
      for (const mapped of mapLowLevelEvent(event)) queue.push(mapped);
    },
  } satisfies RunAgentTurnOptions).then((result) => {
    onResult?.(result);
    if (result.status === "completed") {
      queue.push({
        type: "done",
        output: result.output,
        sessionId: result.sessionId,
        stopReason: result.status,
      });
      return;
    }
    queue.push({
      type: "error",
      error: new Error(result.errorMessage ?? `Provider turn ${result.status}`),
    });
  }, (error: unknown) => {
    queue.push({ type: "error", error: error instanceof Error ? error : new Error(String(error)) });
  }).finally(() => {
    queue.end();
  });

  return queue.iterable;
}

function mapLowLevelEvent(event: AgentStreamEvent): CodingAgentEvent[] {
  switch (event.type) {
    case "message_delta":
      return [{ type: "text_delta", text: event.text }];
    case "thinking_start":
      return [{ type: "thinking_start", id: event.id }];
    case "thinking_delta":
      return [{ type: "thinking_delta", text: event.text }];
    case "thinking_end":
      return [{ type: "thinking_end", id: event.id }];
    case "tool_start":
      return [{ type: "tool_start", id: event.id, name: event.name, input: event.input }];
    case "tool_update":
      return [{
        type: "tool_update",
        id: event.id,
        name: event.name,
        input: event.input,
        output: event.output,
      }];
    case "tool_end":
      return [{
        type: "tool_end",
        id: event.id,
        name: event.name,
        output: event.output,
        isError: event.isError,
      }];
    case "result":
      return [];
  }
}

function createAsyncEventQueue<T>(): {
  iterable: AsyncIterable<T>;
  push(value: T): void;
  end(): void;
} {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let ended = false;

  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = values.shift();
            if (value !== undefined) return Promise.resolve({ value, done: false });
            if (ended) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
    push(value) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
        return;
      }
      values.push(value);
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ value: undefined, done: true });
      }
    },
  };
}
