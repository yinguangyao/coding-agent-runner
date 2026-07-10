# coding-agent-runner

[English](README.md) | [简体中文](README.zh-CN.md)

通过一个轻量的 Node-only API 调用本地 coding agent CLI。

`coding-agent-runner` 封装了这些本地 provider 的进程启动和 stdio 协议细节：

- `codex`：通过 `codex app-server --listen stdio://` 调用 Codex CLI
- `claude`：通过 Claude Code 原生 `stream-json` 调用
- `cursor`：通过 `cursor-agent acp` 调用 Cursor Agent
- `opencode`：通过 `opencode acp` 调用 OpenCode
- `pi`：通过 `pi-acp` 调用 Pi

它的定位是对标 ACP 这类本地 agent 互操作协议，但提供更友好的应用层 API。应用开发者不需要直接处理各 provider 的启动命令、stdio transport、JSON-RPC 结构、`stream-json` 差异、取消执行和 session id 管理；只需要选择 provider，传入 `cwd` 和 `prompt`，再消费归一化事件或最终结果。

它不提供 UI、数据库、任务队列、沙箱、凭据管理或记忆层。它只负责启动本地 CLI 进程、读写对应 stdio 协议、归一化流式事件，并返回本轮执行结果。你的本地应用可以自行决定如何渲染、存储或编排这些结果。

## 适用场景

当你在构建本地应用、桌面应用、daemon 或开发者工具，并希望从 Node.js 调用本机已安装的 coding agent CLI 时，可以使用这个包。

适合：

- 在桌面应用里调用 Codex 或 Claude Code。
- 把 Cursor/OpenCode/Pi 的工具调用进度流式展示到自己的 UI。
- 检测用户机器上安装了哪些 coding CLI。
- 在不接入大型 agent 平台的情况下，保留轻量多轮会话。

不适合：

- 纯浏览器应用。
- 托管 LLM API 调用。
- 默认沙箱隔离。
- provider 安装、登录、计费或凭据管理。

## 安装

```bash
npm install coding-agent-runner
```

你需要自行安装并登录底层 CLI。例如 `codex`、`claude`、`cursor-agent`、`opencode` 或 `pi-acp` 需要在 `PATH` 上可用。

运行要求：

- Node.js 20 或更新版本
- ESM 项目，或使用动态 `import()`
- 至少安装一个受支持的本地 provider CLI

## 快速开始

```ts
import { runCliAgent } from "coding-agent-runner";

const result = await runCliAgent({
  provider: "codex",
  cwd: process.cwd(),
  model: "gpt-5.5",
  prompt: "Inspect this repository and summarize the test command.",
});

console.log(result.output);
```

`runCliAgent()` 是最简单的入口。它会创建 provider 进程，执行一个 prompt，消费流式输出，关闭进程，并返回最终文本。

## 模型选择

在顶层 runner 参数上传 `model`：

```ts
await runCliAgent({
  provider: "claude",
  cwd: process.cwd(),
  model: "sonnet",
  prompt: "Review the staged diff.",
});
```

`model` 会直接传给 Codex 的 thread startup，以及 Claude Code 的 `--model` 参数。ACP provider（`cursor`、`opencode`、`pi`）当前对模型切换的支持不完全一致；如果某个 provider 支持模型 flag 或环境变量，可以通过 `spawn.args` 或 `spawn.env` 透传。

## System Prompt

在顶层 runner 参数上传 `systemPrompt`：

```ts
await runCliAgent({
  provider: "codex",
  cwd: process.cwd(),
  model: "gpt-5.5",
  systemPrompt: "You are a concise senior TypeScript reviewer.",
  prompt: "Review this repository.",
});
```

不同 provider 的行为：

- Codex：映射到 app-server 的 `developerInstructions`。
- Claude：映射到 Claude Code 的 `--append-system-prompt`。
- ACP provider（`cursor`、`opencode`、`pi`）：由于 ACP 当前没有统一的 system prompt 字段，会包装成显式 `<system>` 和 `<user>` prompt block。

## 流式事件

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

`streamCliAgent()` 仍然是单轮调用，但会在 provider 执行过程中持续产出归一化事件。

## 有状态多轮 Runner

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

有状态 runner 会在内存里保存上一次 provider session id，并在下一轮调用时复用。

## 检测本地 CLI

```ts
import { detectCliAgents } from "coding-agent-runner";

const agents = await detectCliAgents();
console.table(agents);
```

检测是 best-effort。它会扫描 `PATH`，用超时机制运行每个 provider 的版本命令，不会尝试登录，也不会修改 provider 状态。

## 自定义命令

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

当宿主应用内置 CLI adapter，或 CLI 不在 `PATH` 上时，可以使用命令覆盖。

## 取消执行

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

取消是 best-effort，具体行为取决于 provider。这个包会把 abort signal 传给当前 transport，并清理自己拥有的子进程。

## Wrapper 与沙箱

这个包不会默认沙箱化 provider 进程。如果你需要隔离，可以传入 wrapper 命令：

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

wrapper 调用形式为：

```text
<wrapper.command> <wrapper.args...> <provider.command> <provider.args...>
```

## 事件类型

友好流式 API 会产出：

```ts
type CodingAgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_start"; id: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; id: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown }
  | { type: "tool_update"; id: string; name: string; input?: unknown; output?: string }
  | { type: "tool_end"; id: string; name: string; output: string; isError: boolean }
  | { type: "done"; output: string; sessionId: string | null; stopReason: string }
  | { type: "error"; error: Error };
```

## 底层 API

这个包也导出底层构件，方便高级调用方使用：

- `runAgentTurn()`：现有的单轮 provider dispatcher
- `runCodexTurn()` 和 `acquireCodexAppServer()`
- `runClaudeNative()`
- `AcpConnection`
- `mapStreamEventToAgentEvents()`
- `buildDefaultSpawn()` 和 `listProviderConfigs()`

底层 API 使用内部 provider id：`codex-cli`、`claude-code-cli`、`cursor-cli`、`opencode-cli`、`pi-cli`。

## Provider ID

友好 API 接受短 provider id：

| Public id | 默认命令 | Internal id |
| --- | --- | --- |
| `codex` | `codex app-server --listen stdio://` | `codex-cli` |
| `claude` | `claude -p --output-format stream-json --input-format stream-json --verbose` | `claude-code-cli` |
| `cursor` | `cursor-agent acp` | `cursor-cli` |
| `opencode` | `opencode acp` | `opencode-cli` |
| `pi` | `pi-acp` | `pi-cli` |

## 安全说明

这个库不会沙箱化 provider 进程。被启动的 CLI 会拥有你传给它的工作目录、环境变量、凭据和文件系统权限。如果你需要隔离，请传入 `wrapper`，或在自己的沙箱/容器里运行这个包。

Claude Code 默认不会启用权限绕过。如果需要添加 `--dangerously-skip-permissions`，请直接调用底层 `runClaudeNative()` 并设置 `dangerouslySkipPermissions: true`。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

`npm run check` 会运行 typecheck、测试和构建。

## 交互式 Demo

当你想自己输入真实 prompt，并像看一个轻量 TUI trace 一样观察执行过程时，可以用 demo：

```bash
npm run demo -- codex --model gpt-5.5
npm run demo -- claude --model sonnet
npm run demo -- codex --model gpt-5.5 --system-prompt "You are concise"
```

进入 demo 后，直接输入 prompt 并回车。它会打印流式回答文本，也会打印 `thinking_start`、`thinking_delta`、`thinking_end`、`tool_start`、`tool_update`、`tool_end`、`done`、`sessionId`、耗时等过程事件。同一个 runner 实例会被复用，因此 provider 支持时，后续输入会延续同一个 session。

Codex 经常只暴露 `thinking_start` 和 `thinking_end` 这类生命周期事件，不会暴露私有思考文本；demo 会展示这些生命周期标记，不会伪造隐藏的 chain-of-thought 内容。

如果只想传一次输入并退出：

```bash
npm run demo -- codex --model gpt-5.5 --prompt "Reply with exactly DEMO_OK"
```

demo 内置命令：

```text
/session   查看当前 provider session id
/cwd       查看工作目录
/help      查看交互命令
/exit      退出
```

如果想看机器可读的事件流：

```bash
npm run demo -- codex --model gpt-5.5 --prompt "List two test commands" --json-events
```

## 真实 CLI Smoke Test

默认测试使用 mock 和协议 fixture，因此 CI 不需要本地 agent 登录。要验证你机器上真实安装的 provider，可以手动运行这些 smoke 脚本：

```bash
npm run smoke:claude
npm run smoke:codex
npm run smoke:cursor
npm run smoke:opencode
npm run smoke:pi
```

每个 smoke 脚本都会先 build 包，再启动真实本地 CLI，验证流式输出、一次 session 恢复，以及取消执行。运行前需要底层 CLI 已安装、已登录，并且在 `PATH` 上可用。

只验证流式输出：

```bash
npm run smoke:claude -- --stream-only
```

如果要给 Codex 或 Claude 指定模型：

```bash
npm run smoke:claude -- --model sonnet
npm run smoke:codex -- --model gpt-5.5
```

如果 CLI 不在 `PATH` 上，可以传命令覆盖：

```bash
CAR_OPENCODE_COMMAND=/custom/bin/opencode npm run smoke:opencode
PI_ACP_BIN=/custom/bin/pi-acp npm run smoke:pi
```

## License

MIT
