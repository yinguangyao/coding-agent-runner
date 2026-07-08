/** Default provider command mappings for supported coding-agent CLIs. */
import type { CodingCliProvider, ProviderConfig, SpawnParams } from "./types.js";

const PROVIDER_CONFIGS: Record<CodingCliProvider, ProviderConfig> = {
  "codex-cli": {
    id: "codex-cli",
    displayName: "Codex CLI",
    mode: "codex-app-server",
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
    localCliRequired: true,
    probeCommand: "codex",
  },
  "claude-code-cli": {
    id: "claude-code-cli",
    displayName: "Claude Code",
    mode: "claude-native",
    command: "claude",
    args: [],
    localCliRequired: true,
    probeCommand: "claude",
  },
  "cursor-cli": {
    id: "cursor-cli",
    displayName: "Cursor Agent",
    mode: "acp",
    command: "cursor-agent",
    args: ["acp"],
    localCliRequired: true,
    probeCommand: "cursor-agent",
  },
  "opencode-cli": {
    id: "opencode-cli",
    displayName: "OpenCode",
    mode: "acp",
    command: "opencode",
    args: ["acp"],
    localCliRequired: true,
    probeCommand: "opencode",
  },
  "pi-cli": {
    id: "pi-cli",
    displayName: "Pi ACP",
    mode: "acp",
    command: "pi-acp",
    args: [],
    localCliRequired: true,
    probeCommand: "pi-acp",
  },
};

/** Return a defensive copy of a provider config. */
export function getProviderConfig(provider: CodingCliProvider): ProviderConfig {
  const config = PROVIDER_CONFIGS[provider];
  return { ...config, args: [...config.args] };
}

/** Return defensive copies of all supported provider configs. */
export function listProviderConfigs(): ProviderConfig[] {
  return (Object.keys(PROVIDER_CONFIGS) as CodingCliProvider[]).map(getProviderConfig);
}

/** Build default spawn params for a provider. */
export function buildDefaultSpawn(
  provider: CodingCliProvider,
  params: { cwd: string; env?: Record<string, string | undefined> },
): SpawnParams {
  const config = getProviderConfig(provider);
  return {
    command: config.command,
    args: [...config.args],
    cwd: params.cwd,
    ...(params.env ? { env: params.env } : {}),
  };
}
