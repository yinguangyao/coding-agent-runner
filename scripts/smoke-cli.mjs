#!/usr/bin/env node

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCodingAgentRunner,
  detectCliAgents,
  streamCliAgent,
} from "../dist/index.js";

const PROVIDERS = ["codex", "claude", "cursor", "opencode", "pi"];
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_ABORT_AFTER_MS = 1_500;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const selected = options.target === "all" ? PROVIDERS : [options.target];
  const detected = new Set((await detectCliAgents({ timeoutMs: 5_000 })).map((agent) => agent.provider));
  const results = [];

  for (const provider of selected) {
    const spawn = spawnOverrideFor(provider);
    if (!detected.has(provider) && !spawn) {
      const message = `${provider} CLI was not detected on PATH`;
      if (options.target === "all") {
        console.warn(`[${provider}] skipped: ${message}`);
        results.push({ provider, skipped: true, message });
        continue;
      }
      throw new Error(`${message}. Install and authenticate it first, or provide a command override env var.`);
    }

    results.push(await runProviderSmoke(provider, options, spawn));
  }

  console.log("\nSmoke summary:");
  console.log(JSON.stringify(summarizeForDisplay(results), null, 2));
}

function parseArgs(argv) {
  const options = {
    target: "claude",
    cwd: null,
    model: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    abortAfterMs: DEFAULT_ABORT_AFTER_MS,
    streamOnly: false,
    skipAbort: false,
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
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(requireValue(argv, ++i, "--timeout-ms"));
    } else if (arg === "--abort-after-ms") {
      options.abortAfterMs = Number(requireValue(argv, ++i, "--abort-after-ms"));
    } else if (arg === "--stream-only") {
      options.streamOnly = true;
    } else if (arg === "--skip-abort") {
      options.skipAbort = true;
    } else if (!arg.startsWith("-") && options.target === "claude") {
      options.target = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.target !== "all" && !PROVIDERS.includes(options.target)) {
    throw new Error(`Unknown provider "${options.target}". Expected one of: ${PROVIDERS.join(", ")}, all`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  if (!Number.isFinite(options.abortAfterMs) || options.abortAfterMs <= 0) {
    throw new Error("--abort-after-ms must be a positive number");
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function runProviderSmoke(provider, options, spawn) {
  const cwd = options.cwd ?? await mkdtemp(path.join(os.tmpdir(), `coding-agent-runner-${provider}-`));
  console.log(`\n[${provider}] cwd=${cwd}${options.model ? ` model=${options.model}` : ""}`);

  const stream = await streamSmoke(provider, cwd, options.timeoutMs, options.model, spawn);
  console.log(`[${provider}] stream ok: ${previewText(stream.output)}`);

  if (options.streamOnly) {
    return { provider, cwd, stream };
  }

  const resume = await resumeSmoke(provider, cwd, options.timeoutMs, options.model, spawn);
  console.log(`[${provider}] resume ok: ${previewText(resume.output)}`);

  let abort = null;
  if (!options.skipAbort) {
    abort = await abortSmoke(provider, cwd, options.timeoutMs, options.abortAfterMs, options.model, spawn);
    console.log(`[${provider}] abort ok: ${abort.errorMessage}`);
  }

  return { provider, cwd, stream, resume, abort };
}

async function streamSmoke(provider, cwd, timeoutMs, model, spawn) {
  const expected = `coding-agent-runner-${provider}-stream-ok`;
  const result = await collectStream({
    provider,
    cwd,
    prompt: `Do not create, modify, or delete files. Reply with exactly: ${expected}`,
    model,
    timeoutMs,
    spawn,
  });
  if (!result.output.includes(expected)) {
    throw new Error(`[${provider}] stream smoke failed. Expected output to include ${expected}, got: ${previewText(result.output)}`);
  }
  if (!result.done) throw new Error(`[${provider}] stream smoke did not emit done`);
  return result;
}

async function resumeSmoke(provider, cwd, timeoutMs, model, spawn) {
  const token = `${provider.toUpperCase()}_SMOKE_TOKEN_${Date.now()}`;
  const runner = await createCodingAgentRunner({ provider, cwd, model, ...(spawn ? { spawn } : {}) });
  try {
    await collectRunnerStream(runner, {
      prompt: `Do not create, modify, or delete files. Remember this exact token for the next turn: ${token}. Reply only: remembered`,
      timeoutMs,
    });
    const sessionAfterFirst = runner.sessionId;
    const second = await collectRunnerStream(runner, {
      prompt: "What exact token did I ask you to remember in the previous turn? Reply only with that token.",
      timeoutMs,
    });
    if (!second.output.includes(token)) {
      throw new Error(`[${provider}] resume smoke failed. Expected ${token}, got: ${previewText(second.output)}`);
    }
    if (runner.sessionId !== sessionAfterFirst) {
      throw new Error(`[${provider}] resume smoke changed session id from ${sessionAfterFirst} to ${runner.sessionId}`);
    }
    return { ...second, sessionId: runner.sessionId };
  } finally {
    await runner.close();
  }
}

async function abortSmoke(provider, cwd, timeoutMs, abortAfterMs, model, spawn) {
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => {
    controller.abort(new Error(`${provider} hard timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  const abortTimer = setTimeout(() => {
    controller.abort(new Error(`${provider} abort requested`));
  }, abortAfterMs);
  let errorMessage = null;
  const events = [];
  const startedAt = Date.now();

  try {
    for await (const event of streamCliAgent({
      provider,
      cwd,
      model,
      prompt: "Do not create, modify, or delete files. Write 200 numbered lines, slowly and without markdown.",
      signal: controller.signal,
      ...(spawn ? { spawn } : {}),
    })) {
      events.push(event.type);
      if (event.type === "error") errorMessage = event.error.message;
    }
  } finally {
    clearTimeout(hardTimeout);
    clearTimeout(abortTimer);
  }

  if (!controller.signal.aborted) throw new Error(`[${provider}] abort smoke did not abort`);
  if (!errorMessage) throw new Error(`[${provider}] abort smoke did not emit an error event`);

  return {
    aborted: true,
    elapsedMs: Date.now() - startedAt,
    events,
    errorMessage,
  };
}

async function collectStream({ provider, cwd, prompt, model, timeoutMs, spawn }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`${provider} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  let output = "";
  const events = [];
  let thinkingEvents = 0;
  let done = false;

  try {
    for await (const event of streamCliAgent({
      provider,
      cwd,
      model,
      prompt,
      signal: controller.signal,
      ...(spawn ? { spawn } : {}),
    })) {
      events.push(event.type);
      if (event.type === "text_delta") output += event.text;
      if (event.type === "thinking_delta") thinkingEvents += 1;
      if (event.type === "done") done = true;
      if (event.type === "error") throw event.error;
    }
  } finally {
    clearTimeout(timeout);
  }

  return {
    output: output.trim(),
    eventCount: events.length,
    thinkingEvents,
    done,
  };
}

async function collectRunnerStream(runner, { prompt, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`runner timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  let output = "";
  const events = [];
  let thinkingEvents = 0;
  let done = false;

  try {
    for await (const event of runner.stream({ prompt, signal: controller.signal })) {
      events.push(event.type);
      if (event.type === "text_delta") output += event.text;
      if (event.type === "thinking_delta") thinkingEvents += 1;
      if (event.type === "done") done = true;
      if (event.type === "error") throw event.error;
    }
  } finally {
    clearTimeout(timeout);
  }

  return {
    output: output.trim(),
    eventCount: events.length,
    thinkingEvents,
    done,
  };
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

function summarizeForDisplay(value) {
  if (typeof value === "string") return previewText(value);
  if (Array.isArray(value)) return value.map((item) => summarizeForDisplay(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key === "output" ? "outputPreview" : key,
    summarizeForDisplay(entry),
  ]));
}

function previewText(text, maxLength = 240) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function printHelp() {
  console.log(`Usage:
  node scripts/smoke-cli.mjs [provider|all] [options]

Providers:
  ${PROVIDERS.join(", ")}, all

Options:
  --cwd <path>             Working directory for the real CLI. Defaults to a temp dir.
  --model <id>             Provider model id. Directly supported by Codex and Claude.
  --timeout-ms <number>    Per-turn timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --abort-after-ms <n>     Abort test delay. Defaults to ${DEFAULT_ABORT_AFTER_MS}.
  --stream-only            Only test stream output.
  --skip-abort             Test stream and resume, but skip cancellation.
  -h, --help               Show this help.

Command override env vars:
  CAR_CLAUDE_COMMAND=/custom/claude
  CAR_OPENCODE_COMMAND=/custom/opencode
  CAR_OPENCODE_ARGS='["acp"]'
  PI_ACP_BIN=/custom/pi-acp

Note:
  ACP provider model selection is provider-dependent. If Cursor/OpenCode/Pi expose
  model choice as CLI args, pass those args with CAR_<PROVIDER>_ARGS.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
