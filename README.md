# coding-agent-runner

[English](README.md) | [简体中文](README.zh-CN.md)

Run local coding-agent CLIs from Node.js through one small Node-only API.

`coding-agent-runner` wraps the process and protocol details for:

- `codex`: Codex CLI via `codex app-server --listen stdio://`
- `claude`: Claude Code via native `stream-json`
- `cursor`: Cursor Agent via `cursor-agent acp`
- `opencode`: OpenCode via `opencode acp`
- `pi`: Pi via `pi-acp`

It is positioned next to ACP-style local agent interoperability, but with a friendlier application API. Instead of making every app deal with provider-specific commands, stdio transports, JSON-RPC shapes, `stream-json` differences, cancellation, and session ids directly, this package exposes a small SDK surface: pick a provider, pass `cwd` and `prompt`, then consume normalized events or a final result.

It does not provide a UI, database, task queue, sandbox, credential manager, or memory layer. It starts local CLI processes, speaks their stdio protocols, normalizes streaming events, and returns turn results that local apps can render or store however they want.

## When To Use It

Use this package when you are building a local app, desktop app, daemon, or developer tool that needs to call installed coding agents from Node.js.

Good fits:

- Run Codex or Claude Code from a desktop app.
- Stream Cursor/OpenCode/Pi tool progress into your own UI.
- Detect which coding CLIs are installed on a user's machine.
- Keep a lightweight multi-turn session without adopting a larger agent platform.

Not a fit:

- Browser-only applications.
- Hosted LLM API calls.
- Sandboxed execution by default.
- Provider installation, login, billing, or credential management.

## Install

```bash
npm install coding-agent-runner
```

Install and authenticate the underlying CLI separately. For example, `codex`, `claude`, `cursor-agent`, `opencode`, or `pi-acp` must be available on `PATH`.

Runtime requirements:

- Node.js 20 or newer
- ESM project or dynamic `import()`
- At least one supported provider CLI installed locally

## Quick Start

```ts
import { runCliAgent } from "coding-agent-runner";

const result = await runCliAgent({
  provider: "codex",
  cwd: process.cwd(),
  model: "gpt-5",
  prompt: "Inspect this repository and summarize the test command.",
});

console.log(result.output);
```

`runCliAgent()` is the simplest API. It creates a provider process, runs one prompt, consumes the stream, closes the process, and returns the final output.

## Model Selection

Pass `model` on the top-level runner options:

```ts
await runCliAgent({
  provider: "claude",
  cwd: process.cwd(),
  model: "sonnet",
  prompt: "Review the staged diff.",
});
```

`model` is passed directly to Codex thread startup and Claude Code's `--model` flag. ACP providers (`cursor`, `opencode`, and `pi`) expose model switching inconsistently today; when a provider supports a model flag or env var, pass it through `spawn.args` or `spawn.env`.

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

`streamCliAgent()` is still one-shot, but it yields normalized progress events as the provider runs.

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

Detection is best-effort. It scans `PATH`, runs each provider's version command with a timeout, and does not try to log in or mutate provider state.

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

Use command overrides when your host app bundles a CLI adapter or stores it outside `PATH`.

## Cancellation

```ts
import { runCliAgent } from "coding-agent-runner";

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("Timed out")), 30_000);

try {
  await runCliAgent({
    provider: "claude",
    cwd: process.cwd(),
    prompt: "Run the test suite and fix failures.",
    signal: controller.signal,
  });
} finally {
  clearTimeout(timeout);
}
```

Cancellation is best-effort and provider-specific. The package forwards the abort signal to the active transport and cleans up child processes it owns.

## Wrappers And Sandboxes

This package does not sandbox provider processes. If you need isolation, pass a wrapper command:

```ts
await runCliAgent({
  provider: "codex",
  cwd: process.cwd(),
  prompt: "Inspect this repository.",
  spawn: {
    wrapper: {
      command: "sandbox-exec",
      args: ["-f", "/path/to/profile.sb"],
    },
  },
});
```

The wrapper is invoked as:

```text
<wrapper.command> <wrapper.args...> <provider.command> <provider.args...>
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

## Provider IDs

Friendly APIs accept short provider ids:

| Public id | Default command | Internal id |
| --- | --- | --- |
| `codex` | `codex app-server --listen stdio://` | `codex-cli` |
| `claude` | `claude -p --output-format stream-json --input-format stream-json --verbose` | `claude-code-cli` |
| `cursor` | `cursor-agent acp` | `cursor-cli` |
| `opencode` | `opencode acp` | `opencode-cli` |
| `pi` | `pi-acp` | `pi-cli` |

## Safety

This library does not sandbox provider processes. The spawned CLI runs with the working directory, environment, credentials, and filesystem permissions you give it. If you need isolation, pass a `wrapper` command in spawn options or run this package inside your own sandbox/container.

Claude Code permission bypass is not enabled by default. To add `--dangerously-skip-permissions`, call `runClaudeNative()` with `dangerouslySkipPermissions: true`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

`npm run check` runs typecheck, tests, and build.

## Real CLI Smoke Tests

The default test suite uses mocks and protocol fixtures so CI does not need local agent logins. To verify a real installed provider on your machine, run the manual smoke scripts:

```bash
npm run smoke:claude
npm run smoke:codex
npm run smoke:cursor
npm run smoke:opencode
npm run smoke:pi
```

Each smoke script builds the package, starts the real local CLI, checks streaming output, verifies one session resume turn, and checks cancellation. The scripts require the underlying CLI to be installed, authenticated, and available on `PATH`.

To run only the streaming check:

```bash
npm run smoke:claude -- --stream-only
```

To run with an explicit model for Codex or Claude:

```bash
npm run smoke:claude -- --model sonnet
npm run smoke:codex -- --model gpt-5
```

To test a CLI outside `PATH`, pass a command override:

```bash
CAR_OPENCODE_COMMAND=/custom/bin/opencode npm run smoke:opencode
PI_ACP_BIN=/custom/bin/pi-acp npm run smoke:pi
```

## License

MIT
