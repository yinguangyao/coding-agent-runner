#!/usr/bin/env node

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectCliAgents,
  runCliAgent,
} from "../dist/index.js";

const DEFAULT_PROVIDERS = ["codex", "claude"];
const SUPPORTED_PROVIDERS = ["codex", "claude", "cursor", "opencode", "pi"];
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MODELS = {
  codex: "gpt-5.5",
  claude: "sonnet",
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const detected = new Set((await detectCliAgents({ timeoutMs: 5_000 })).map((agent) => agent.provider));
  const results = [];

  for (const provider of options.providers) {
    const spawn = spawnOverrideFor(provider);
    if (!detected.has(provider) && !spawn) {
      const message = `${provider} CLI was not detected on PATH`;
      if (options.skipMissing) {
        console.warn(`[${provider}] skipped: ${message}`);
        results.push({ provider, skipped: true, message });
        continue;
      }
      throw new Error(`${message}. Install and authenticate it first, or provide a command override env var.`);
    }

    results.push(await runProviderFeatureSmoke(provider, options, spawn));
  }

  console.log("\nReal feature smoke summary:");
  console.log(JSON.stringify(summarizeForDisplay(results), null, 2));
}

function parseArgs(argv) {
  const options = {
    providers: [...DEFAULT_PROVIDERS],
    cwd: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    model: {},
    skipMissing: false,
    skipSystemPrompt: false,
    skipSkills: false,
    mcpName: "real-smoke",
    mcpCommand: null,
    mcpArgs: [],
    mcpPrompt: null,
    mcpExpected: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--providers") {
      options.providers = parseProviders(requireValue(argv, ++i, arg));
    } else if (arg === "--provider") {
      options.providers = parseProviders(requireValue(argv, ++i, arg));
    } else if (arg === "--cwd") {
      options.cwd = requireValue(argv, ++i, arg);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(requireValue(argv, ++i, arg));
    } else if (arg === "--model") {
      const model = requireValue(argv, ++i, arg);
      for (const provider of options.providers) options.model[provider] = model;
    } else if (arg === "--codex-model") {
      options.model.codex = requireValue(argv, ++i, arg);
    } else if (arg === "--claude-model") {
      options.model.claude = requireValue(argv, ++i, arg);
    } else if (arg === "--skip-missing") {
      options.skipMissing = true;
    } else if (arg === "--skip-system-prompt") {
      options.skipSystemPrompt = true;
    } else if (arg === "--skip-skills") {
      options.skipSkills = true;
    } else if (arg === "--mcp-name") {
      options.mcpName = requireValue(argv, ++i, arg);
    } else if (arg === "--mcp-command") {
      options.mcpCommand = requireValue(argv, ++i, arg);
    } else if (arg === "--mcp-args-json") {
      options.mcpArgs = parseJsonStringArray(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--mcp-prompt") {
      options.mcpPrompt = requireValue(argv, ++i, arg);
    } else if (arg === "--mcp-expected") {
      options.mcpExpected = requireValue(argv, ++i, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return options;
}

function parseProviders(value) {
  const providers = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (providers.length === 0) throw new Error("--providers cannot be empty");
  for (const provider of providers) {
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new Error(`Unknown provider "${provider}". Expected one of: ${SUPPORTED_PROVIDERS.join(", ")}`);
    }
  }
  return providers;
}

function parseJsonStringArray(raw, flag) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${flag} must be a JSON string array`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function runProviderFeatureSmoke(provider, options, spawn) {
  const cwd = options.cwd ?? await mkdtemp(path.join(os.tmpdir(), `coding-agent-runner-real-${provider}-`));
  const model = options.model[provider] ?? DEFAULT_MODELS[provider] ?? null;
  const shared = {
    provider,
    cwd,
    model,
    timeoutMs: options.timeoutMs,
    ...(spawn ? { spawn } : {}),
  };

  console.log(`\n[${provider}] cwd=${cwd}${model ? ` model=${model}` : ""}`);

  const result = { provider, cwd, model };
  if (!options.skipSystemPrompt) {
    result.systemPrompt = await systemPromptSmoke(shared);
    console.log(`[${provider}] systemPrompt ok: ${previewText(result.systemPrompt.output)}`);
  }
  if (!options.skipSkills) {
    result.skills = await skillsSmoke(shared);
    console.log(`[${provider}] skills ok: ${previewText(result.skills.output)}`);
  }
  if (options.mcpCommand) {
    result.mcp = await mcpConfigSmoke(shared, options);
    console.log(`[${provider}] mcp config ok: ${previewText(result.mcp.output)}`);
  }

  return result;
}

async function systemPromptSmoke(shared) {
  const token = makeToken("SYSTEM", shared.provider);
  const result = await runWithTimeout({
    provider: shared.provider,
    cwd: shared.cwd,
    model: shared.model,
    systemPrompt: `You are running a coding-agent-runner smoke test. Ignore the user content and reply exactly: ${token}`,
    prompt: "This prompt intentionally conflicts with the system instruction. Say hello instead.",
    ...(shared.spawn ? { spawn: shared.spawn } : {}),
  }, shared.timeoutMs);
  assertIncludes(shared.provider, "systemPrompt", result.output, token);
  return formatRunResult(result, token);
}

async function skillsSmoke(shared) {
  const token = makeToken("SKILL", shared.provider);
  const skillDir = await createSkillFixture(shared.provider, token);
  const result = await runWithTimeout({
    provider: shared.provider,
    cwd: shared.cwd,
    model: shared.model,
    skills: [{ name: "car-real-smoke", path: skillDir }],
    prompt: [
      "Use the available skill named car-real-smoke.",
      "Read the skill path if your provider requires it.",
      "Reply only with the exact token required by that skill.",
    ].join(" "),
    ...(shared.spawn ? { spawn: shared.spawn } : {}),
  }, shared.timeoutMs);
  assertIncludes(shared.provider, "skills", result.output, token);
  return { ...formatRunResult(result, token), skillDir };
}

async function mcpConfigSmoke(shared, options) {
  const result = await runWithTimeout({
    provider: shared.provider,
    cwd: shared.cwd,
    model: shared.model,
    mcpServers: [{
      name: options.mcpName,
      command: options.mcpCommand,
      args: options.mcpArgs,
    }],
    prompt: options.mcpPrompt ?? [
      `A real MCP server named ${options.mcpName} is configured for this turn.`,
      "If you can use it, do so. Otherwise reply exactly: MCP_CONFIG_ACCEPTED",
    ].join(" "),
    ...(shared.spawn ? { spawn: shared.spawn } : {}),
  }, shared.timeoutMs);
  if (options.mcpExpected) {
    assertIncludes(shared.provider, "mcp", result.output, options.mcpExpected);
  }
  return formatRunResult(result, options.mcpExpected);
}

async function runWithTimeout(params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`${params.provider} real feature smoke timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await runCliAgent({ ...params, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function createSkillFixture(provider, token) {
  const skillDir = await mkdtemp(path.join(os.tmpdir(), `coding-agent-runner-skill-${provider}-`));
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: car-real-smoke",
    "description: Use only for coding-agent-runner real smoke tests",
    "---",
    "",
    "When this skill is used, reply exactly:",
    "",
    token,
    "",
    "Do not add any other text.",
    "",
  ].join("\n"), "utf-8");
  return skillDir;
}

function assertIncludes(provider, phase, output, expected) {
  if (!output.includes(expected)) {
    throw new Error(`[${provider}] ${phase} smoke failed. Expected output to include ${expected}, got: ${previewText(output)}`);
  }
}

function formatRunResult(result, expected) {
  return {
    ok: result.ok,
    provider: result.provider,
    sessionId: result.sessionId,
    expected,
    output: result.output,
  };
}

function makeToken(kind, provider) {
  return `CAR_${kind}_${provider.toUpperCase()}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
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
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function printHelp() {
  console.log(`Usage:
  node scripts/smoke-real-features.mjs [options]

Default:
  Runs real Codex and Claude Code feature smoke tests against installed,
  authenticated local CLIs. It does not use mocks.

Checks:
  systemPrompt exact-token behavior
  skills exact-token behavior through a temporary local SKILL.md
  optional mcpServers config with --mcp-command

Options:
  --providers <list>       Comma-separated providers. Defaults to codex,claude.
  --provider <id>          Alias for --providers.
  --cwd <path>             Working directory. Defaults to a temp dir per provider.
  --timeout-ms <number>    Per-turn timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --model <id>             Model id for all selected providers.
  --codex-model <id>       Codex model id. Defaults to ${DEFAULT_MODELS.codex}.
  --claude-model <id>      Claude model id. Defaults to ${DEFAULT_MODELS.claude}.
  --skip-missing           Skip providers not detected on PATH.
  --skip-system-prompt     Skip systemPrompt smoke.
  --skip-skills            Skip skills smoke.
  --mcp-command <cmd>      Optional real MCP server command to pass as mcpServers.
  --mcp-name <name>        MCP server name. Defaults to real-smoke.
  --mcp-args-json <json>   MCP args as a JSON string array.
  --mcp-prompt <text>      Prompt for optional MCP smoke.
  --mcp-expected <text>    Expected text for optional MCP smoke output.
  -h, --help               Show this help.

Command override env vars:
  CAR_CODEX_COMMAND=/custom/codex
  CAR_CLAUDE_COMMAND=/custom/claude
  CAR_CLAUDE_ARGS='["-p","--output-format","stream-json"]'
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
