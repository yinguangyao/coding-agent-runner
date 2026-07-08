/** Local CLI provider detection. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CodingCliProvider } from "./types.js";
import {
  PUBLIC_PROVIDERS,
  toInternalProvider,
  type CodingAgentProvider,
} from "./provider-ids.js";

const execFileAsync = promisify(execFile);

interface ProviderProbe {
  provider: CodingAgentProvider;
  internalProvider: CodingCliProvider;
  binary: string;
  versionArgs: string[];
  versionRe: RegExp;
}

/** Options for best-effort local CLI detection. */
export interface DetectCliAgentsOptions {
  providers?: CodingAgentProvider[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Detected local CLI provider. */
export interface DetectedCliAgent {
  provider: CodingAgentProvider;
  internalProvider: CodingCliProvider;
  binary: string;
  path: string;
  version: string | null;
  runnable: boolean;
  reason?: string;
}

const VERSION_RE = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/;

const PROBES: ProviderProbe[] = [
  { provider: "codex", internalProvider: "codex-cli", binary: "codex", versionArgs: ["--version"], versionRe: VERSION_RE },
  { provider: "claude", internalProvider: "claude-code-cli", binary: "claude", versionArgs: ["--version"], versionRe: VERSION_RE },
  { provider: "cursor", internalProvider: "cursor-cli", binary: "cursor-agent", versionArgs: ["--version"], versionRe: VERSION_RE },
  { provider: "opencode", internalProvider: "opencode-cli", binary: "opencode", versionArgs: ["--version"], versionRe: VERSION_RE },
  { provider: "pi", internalProvider: "pi-cli", binary: "pi-acp", versionArgs: ["--version"], versionRe: VERSION_RE },
];

/** Detect installed and version-runnable local coding CLIs from PATH. */
export async function detectCliAgents(
  options: DetectCliAgentsOptions = {},
): Promise<DetectedCliAgent[]> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const wanted = new Set(options.providers ?? PUBLIC_PROVIDERS);
  const found: DetectedCliAgent[] = [];

  for (const probe of PROBES) {
    if (!wanted.has(probe.provider)) continue;
    const detected = await detectProbe(probe, env, timeoutMs);
    if (detected) found.push(detected);
  }

  return found;
}

async function detectProbe(
  probe: ProviderProbe,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<DetectedCliAgent | null> {
  for (const candidate of pathCandidates(probe.binary, env)) {
    const version = await readVersion(probe, candidate, env, timeoutMs);
    if (version === null) continue;
    return {
      provider: probe.provider,
      internalProvider: toInternalProvider(probe.provider),
      binary: probe.binary,
      path: candidate,
      version,
      runnable: true,
    };
  }
  return null;
}

function pathCandidates(binary: string, env: NodeJS.ProcessEnv): string[] {
  const rawPath = env.PATH ?? env.Path ?? "";
  const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const dir of rawPath.split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${binary}${suffix}`);
      if (seen.has(candidate) || !existsSync(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

async function readVersion(
  probe: ProviderProbe,
  binPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, probe.versionArgs, {
      env,
      timeout: timeoutMs,
      windowsHide: true,
    });
    const match = probe.versionRe.exec(`${stdout}\n${stderr}`);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
