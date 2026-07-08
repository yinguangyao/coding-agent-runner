# coding-agent-runner

Run coding-agent CLIs from Node.js through one small API.

This package wraps the process/protocol details for:

- `codex-cli`: `codex app-server --listen stdio://`
- `claude-code-cli`: native Claude Code `stream-json`
- `cursor-cli`: `cursor-agent acp`
- `opencode-cli`: `opencode acp`
- `pi-cli`: `pi-acp`

It is intentionally narrow: it does not provide a UI, database, task queue, sandbox, credential manager, or agent memory layer. It starts local CLI processes, speaks their stdio protocols, normalizes streaming events, and returns a turn result.

## Install

```bash
npm install coding-agent-runner
```

You must install and authenticate the underlying CLI you want to run. For example, `codex`, `claude`, `cursor-agent`, `opencode`, or `pi-acp` must be available on `PATH`.

## Quick Start

```ts
import { runAgentTurn } from "coding-agent-runner";

const result = await runAgentTurn({
  provider: "codex-cli",
  cwd: process.cwd(),
  prompt: "Inspect this repository and summarize the test command.",
  onEvent(event) {
    if (event.type === "message_delta") process.stdout.write(event.text);
  },
});

console.log(result.status, result.sessionId);
```

## Provider Defaults

```ts
import { buildDefaultSpawn, listProviderConfigs } from "coding-agent-runner";

console.log(listProviderConfigs());
console.log(buildDefaultSpawn("cursor-cli", { cwd: "/repo" }));
```

Default commands:

| Provider | Command |
| --- | --- |
| `codex-cli` | `codex app-server --listen stdio://` |
| `claude-code-cli` | `claude -p --output-format stream-json --input-format stream-json` |
| `cursor-cli` | `cursor-agent acp` |
| `opencode-cli` | `opencode acp` |
| `pi-cli` | `pi-acp` |

## Events

All transports emit the same small event union:

```ts
type AgentStreamEvent =
  | { type: "message_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown }
  | { type: "tool_update"; id: string; name: string; input?: unknown; output?: string }
  | { type: "tool_end"; id: string; name: string; output: string; isError: boolean }
  | { type: "result"; text: string; isError: boolean };
```

You can also use the lower-level exports directly:

- `runCodexTurn()` and `acquireCodexAppServer()`
- `runClaudeNative()`
- `AcpConnection`
- `mapStreamEventToAgentEvents()`

## Safety

This library does not sandbox provider processes. The spawned CLI runs with the working directory, environment, credentials, and filesystem permissions you give it. If you need isolation, pass a `wrapper` command in spawn options or run this package inside your own sandbox/container.

Claude Code permission bypass is not enabled by default. To add `--dangerously-skip-permissions`, call `runClaudeNative()` with `dangerouslySkipPermissions: true`.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT
