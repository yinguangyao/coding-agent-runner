/** Public and internal provider id mapping. */
import type { CodingCliProvider } from "./types.js";

/** Public provider ids used by the friendly SDK API. */
export type CodingAgentProvider = "codex" | "claude" | "cursor" | "opencode" | "pi";

/** Provider ids accepted by public convenience APIs. */
export type AnyCodingProvider = CodingAgentProvider | CodingCliProvider;

const PUBLIC_TO_INTERNAL: Record<CodingAgentProvider, CodingCliProvider> = {
  codex: "codex-cli",
  claude: "claude-code-cli",
  cursor: "cursor-cli",
  opencode: "opencode-cli",
  pi: "pi-cli",
};

const INTERNAL_TO_PUBLIC: Record<CodingCliProvider, CodingAgentProvider> = {
  "codex-cli": "codex",
  "claude-code-cli": "claude",
  "cursor-cli": "cursor",
  "opencode-cli": "opencode",
  "pi-cli": "pi",
};

/** Stable list of public provider ids. */
export const PUBLIC_PROVIDERS = Object.keys(PUBLIC_TO_INTERNAL) as CodingAgentProvider[];

/** Return whether a provider id is a public short id. */
export function isPublicProvider(provider: AnyCodingProvider): provider is CodingAgentProvider {
  return Object.hasOwn(PUBLIC_TO_INTERNAL, provider);
}

/** Convert public or internal provider ids to the existing internal id. */
export function toInternalProvider(provider: AnyCodingProvider): CodingCliProvider {
  return isPublicProvider(provider) ? PUBLIC_TO_INTERNAL[provider] : provider;
}

/** Convert an internal provider id to its public short id. */
export function toPublicProvider(provider: CodingCliProvider): CodingAgentProvider {
  return INTERNAL_TO_PUBLIC[provider];
}
