#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import {
  createCodingAgentRunner,
  detectCliAgents,
} from "../dist/index.js";

const PROVIDERS = ["codex", "claude", "cursor", "opencode", "pi"];
const DEFAULT_TIMEOUT_MS = 0;

let activeController = null;
let activeReadline = null;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const spawn = spawnOverrideFor(options.provider);
  await ensureProviderAvailable(options.provider, spawn);

  const runner = await createCodingAgentRunner({
    provider: options.provider,
    cwd: options.cwd,
    model: options.model,
    systemPrompt: options.systemPrompt,
    ...(spawn ? { spawn } : {}),
  });

  installSigintHandler();
  printHeader(options);

  try {
    if (options.prompt) {
      await runTurn(runner, options.prompt, options);
      if (options.once) return;
    }

    if (!process.stdin.isTTY && !options.prompt) {
      const pipedPrompt = (await readAllStdin()).trim();
      if (pipedPrompt) await runTurn(runner, pipedPrompt, options);
      return;
    }

    await runInteractiveLoop(runner, options);
  } finally {
    await runner.close();
    activeReadline?.close();
  }
}

function parseArgs(argv) {
  const options = {
    provider: "codex",
    cwd: process.cwd(),
    model: null,
    systemPrompt: null,
    prompt: null,
    once: false,
    jsonEvents: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--cwd") {
      options.cwd = requireValue(argv, ++i, "--cwd");
    } else if (arg === "--model") {
      options.model = requireValue(argv, ++i, "--model");
    } else if (arg === "--system-prompt" || arg === "--system") {
      options.systemPrompt = requireValue(argv, ++i, arg);
    } else if (arg === "--prompt") {
      options.prompt = requireValue(argv, ++i, "--prompt");
      options.once = true;
    } else if (arg === "--once") {
      options.once = true;
    } else if (arg === "--json-events") {
      options.jsonEvents = true;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(requireValue(argv, ++i, "--timeout-ms"));
    } else if (!arg.startsWith("-") && options.provider === "codex") {
      options.provider = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!PROVIDERS.includes(options.provider)) {
    throw new Error(`Unknown provider "${options.provider}". Expected one of: ${PROVIDERS.join(", ")}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new Error("--timeout-ms must be a non-negative number");
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function ensureProviderAvailable(provider, spawn) {
  if (spawn) return;
  const detected = await detectCliAgents({ providers: [provider], timeoutMs: 5_000 });
  if (detected.length > 0) return;
  throw new Error(`${provider} CLI was not detected on PATH. Install and authenticate it first, or provide a command override env var.`);
}

async function runInteractiveLoop(runner, options) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  activeReadline = rl;
  printInteractiveHelp();

  for (;;) {
    const prompt = await rl.question("\nuser> ");
    const command = prompt.trim();
    if (!command) continue;
    if (command === "/exit" || command === "/quit") break;
    if (command === "/help") {
      printInteractiveHelp();
      continue;
    }
    if (command === "/session") {
      console.log(`[session] ${runner.sessionId ?? "null"}`);
      continue;
    }
    if (command === "/cwd") {
      console.log(`[cwd] ${options.cwd}`);
      continue;
    }

    await runTurn(runner, prompt, options);
    if (options.once) break;
  }
}

async function runTurn(runner, prompt, options) {
  const controller = new AbortController();
  activeController = controller;
  const startedAt = Date.now();
  let output = "";
  let timeout = null;

  if (options.timeoutMs > 0) {
    timeout = setTimeout(() => {
      controller.abort(new Error(`demo timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
  }

  console.log(`\n[turn:start] ${new Date(startedAt).toISOString()}`);
  try {
    for await (const event of runner.stream({ prompt, signal: controller.signal })) {
      if (event.type === "text_delta") output += event.text;
      renderEvent(event, options);
      if (event.type === "error") return { ok: false, output, error: event.error };
      if (event.type === "done") output = event.output || output;
    }
    return { ok: true, output };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`\n[turn:error] ${error.message}`);
    return { ok: false, output, error };
  } finally {
    if (timeout) clearTimeout(timeout);
    activeController = null;
    console.log(`[turn:elapsed] ${Date.now() - startedAt}ms`);
  }
}

function renderEvent(event, options) {
  if (options.jsonEvents) {
    console.log(JSON.stringify(summarizeEvent(event)));
    return;
  }

  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "thinking_start":
      console.log(`\n[thinking:start] id=${event.id}`);
      break;
    case "thinking_delta":
      console.log(`\n[thinking] ${previewText(event.text)}`);
      break;
    case "thinking_end":
      console.log(`\n[thinking:end] id=${event.id}`);
      break;
    case "tool_start":
      console.log(`\n[tool:start] ${event.name} id=${event.id} input=${previewValue(event.input)}`);
      break;
    case "tool_update":
      console.log(`\n[tool:update] ${event.name} id=${event.id} input=${previewValue(event.input)} output=${previewText(event.output ?? "")}`);
      break;
    case "tool_end":
      console.log(`\n[tool:end] ${event.name} id=${event.id} isError=${event.isError} output=${previewText(event.output)}`);
      break;
    case "done":
      console.log(`\n[turn:done] stopReason=${event.stopReason} sessionId=${event.sessionId ?? "null"}`);
      break;
    case "error":
      console.error(`\n[turn:error] ${event.error.message}`);
      break;
  }
}

function summarizeEvent(event) {
  if (event.type === "error") return { type: "error", message: event.error.message };
  if (event.type === "done") {
    return {
      ...event,
      output: previewText(event.output, 800),
    };
  }
  return event;
}

function previewValue(value) {
  if (value === undefined) return "";
  return previewText(JSON.stringify(value));
}

function previewText(text, maxLength = 1_000) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function printHeader(options) {
  console.log("coding-agent-runner demo");
  console.log(`provider=${options.provider}`);
  console.log(`cwd=${options.cwd}`);
  if (options.model) console.log(`model=${options.model}`);
  if (options.systemPrompt) console.log(`systemPrompt=${previewText(options.systemPrompt, 160)}`);
  console.log("events=text_delta/thinking_start/thinking_delta/thinking_end/tool_start/tool_update/tool_end/done/error");
}

function printInteractiveHelp() {
  console.log("Commands: /help, /session, /cwd, /exit");
  console.log("Type a prompt and press Enter. Press Ctrl+C during a turn to request cancellation.");
}

function installSigintHandler() {
  process.on("SIGINT", () => {
    if (activeController && !activeController.signal.aborted) {
      activeController.abort(new Error("demo interrupted"));
      process.stdout.write("\n[demo] interrupt requested\n");
      return;
    }
    activeReadline?.close();
    process.stdout.write("\n");
    process.exit(130);
  });
}

function spawnOverrideFor(provider) {
  const upper = provider.toUpperCase();
  const command =
    process.env[`CAR_${upper}_COMMAND`] ??
    process.env[`${upper}_COMMAND`] ??
    process.env[`${upper}_BIN`] ??
    (provider === "pi" ? process.env.PI_ACP_BIN : undefined);
  const rawArgs = process.env[`CAR_${upper}_ARGS`] ?? process.env[`${upper}_ARGS`];
  if (!command && !rawArgs) return null;
  return {
    ...(command ? { command } : {}),
    ...(rawArgs ? { args: parseEnvArgs(rawArgs) } : {}),
  };
}

function parseEnvArgs(rawArgs) {
  try {
    const parsed = JSON.parse(rawArgs);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) return parsed;
  } catch {
    // Fall through to whitespace splitting for simple cases.
  }
  return rawArgs.split(/\s+/).filter(Boolean);
}

async function readAllStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function printHelp() {
  console.log(`Usage:
  node scripts/demo-cli.mjs [provider] [options]

Providers:
  ${PROVIDERS.join(", ")}

Options:
  --cwd <path>             Working directory. Defaults to process.cwd().
  --model <id>             Provider model id, for example gpt-5.5 or sonnet.
  --system-prompt <text>   System prompt. Alias: --system.
  --prompt <text>          Run one prompt and exit.
  --once                   Exit after the first interactive turn.
  --json-events            Print normalized events as JSON lines.
  --timeout-ms <number>    Per-turn timeout. 0 disables timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  -h, --help               Show this help.

Examples:
  npm run demo -- codex --model gpt-5.5
  npm run demo -- claude --model sonnet
  npm run demo -- codex --model gpt-5.5 --system-prompt "You are concise"
  npm run demo -- codex --model gpt-5.5 --prompt "Reply with exactly DEMO_OK"
  echo "Summarize this repo" | npm run demo -- codex --once

Command override env vars:
  CAR_CLAUDE_COMMAND=/custom/claude
  CAR_OPENCODE_COMMAND=/custom/opencode
  CAR_OPENCODE_ARGS='["acp"]'
  PI_ACP_BIN=/custom/pi-acp
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
