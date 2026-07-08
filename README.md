# coding-agent-runner

Run local coding-agent CLIs from Node.js through one small API.

`coding-agent-runner` wraps the process and protocol details for:

- `codex`: Codex CLI via `codex app-server --listen stdio://`
- `claude`: Claude Code via native `stream-json`
- `cursor`: Cursor Agent via `cursor-agent acp`
- `opencode`: OpenCode via `opencode acp`
- `pi`: Pi via `pi-acp`

It does not provide a UI, database, task queue, sandbox, credential manager, or memory layer. It starts local CLI processes, speaks their stdio protocols, normalizes streaming events, and returns turn results.

## Install

```bash
npm install coding-agent-runner
```

Install and authenticate the underlying CLI separately. For example, `codex`, `claude`, `cursor-agent`, `opencode`, or `pi-acp` must be available on `PATH`.

## Quick Start

```ts
import { runCliAgent } from "coding-agent-runner";

const result = await runCliAgent({
  provider: "codex",
  cwd: process.cwd(),
  prompt: "Inspect this repository and summarize the test command.",
});

console.log(result.output);
```

## Streaming

```ts
import { streamCliAgent } from "coding-agent-runner";

for await (const event of streamCliAgent({
  provider: "claude",
  cwd: process.cwd(),
  prompt: "Add tests for the auth module.",
})) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "tool_start") console.log("tool:", event.name);
}
```

## Stateful Multi-Turn Runner

```ts
import { createCodingAgentRunner } from "coding-agent-runner";

const runner = await createCodingAgentRunner({
  provider: "cursor",
  cwd: "/path/to/project",
});

try {
  for await (const event of runner.stream({ prompt: "Inspect the codebase." })) {
    console.log(event);
  }

  for await (const event of runner.stream({ prompt: "Now make the change." })) {
    console.log(event);
  }
} finally {
  await runner.close();
}
```

The stateful runner keeps the last provider session id in memory and reuses it on the next turn.

## Detect Local CLIs

```ts
import { detectCliAgents } from "coding-agent-runner";

const agents = await detectCliAgents();
console.table(agents);
```

## Command Overrides

```ts
import { runCliAgent } from "coding-agent-runner";

await runCliAgent({
  provider: "opencode",
  cwd: process.cwd(),
  prompt: "Summarize this package.",
  spawn: {
    command: "/custom/bin/opencode",
    args: ["acp"],
  },
});
```

## Events

The friendly streaming API emits:

```ts
type CodingAgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown }
  | { type: "tool_update"; id: string; name: string; input?: unknown; output?: string }
  | { type: "tool_end"; id: string; name: string; output: string; isError: boolean }
  | { type: "done"; output: string; sessionId: string | null; stopReason: string }
  | { type: "error"; error: Error };
```

## Lower-Level API

The package also exports the lower-level building blocks:

- `runAgentTurn()` for the existing one-shot provider dispatcher
- `runCodexTurn()` and `acquireCodexAppServer()`
- `runClaudeNative()`
- `AcpConnection`
- `mapStreamEventToAgentEvents()`
- `buildDefaultSpawn()` and `listProviderConfigs()`

Lower-level APIs use the internal provider ids: `codex-cli`, `claude-code-cli`, `cursor-cli`, `opencode-cli`, and `pi-cli`.

## Safety

This library does not sandbox provider processes. The spawned CLI runs with the working directory, environment, credentials, and filesystem permissions you give it. If you need isolation, pass a `wrapper` command in spawn options or run this package inside your own sandbox/container.

Claude Code permission bypass is not enabled by default. To add `--dangerously-skip-permissions`, call `runClaudeNative()` with `dangerouslySkipPermissions: true`.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

## License

MIT
