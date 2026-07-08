# AGENTS.md - coding-agent-runner

## Project

`coding-agent-runner` is a Node.js package for running local coding-agent CLIs from application code.

Supported providers:

- `codex` / `codex-cli`: Codex app-server over stdio JSON-RPC.
- `claude` / `claude-code-cli`: Claude Code native `stream-json`.
- `cursor` / `cursor-cli`: Cursor Agent over ACP.
- `opencode` / `opencode-cli`: OpenCode over ACP.
- `pi` / `pi-cli`: Pi ACP.

## Boundaries

- Do not import AI Workbench code, Electron code, server code, database code, or app-specific task queues.
- Keep this package Node-only and publishable as a standalone npm package.
- Do not add provider installation, login, credential storage, billing, UI, or sandbox policy.
- Do not require real provider credentials in tests or CI.
- Keep provider protocol code behind small public APIs and package-owned types.

## Public API

Friendly APIs use short provider ids:

- `detectCliAgents()`
- `createCodingAgentRunner()`
- `streamCliAgent()`
- `runCliAgent()`

Lower-level APIs remain exported for advanced callers:

- `runAgentTurn()`
- `runCodexTurn()` / `acquireCodexAppServer()`
- `runClaudeNative()`
- `AcpConnection`
- `mapStreamEventToAgentEvents()`
- `buildDefaultSpawn()` / `listProviderConfigs()`

## Development

Use npm, not yarn or pnpm, in this repository.

Run local verification before claiming completion:

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

`npm run check` runs typecheck, tests, and build. It does not run `npm pack --dry-run`, so run pack separately before release-related changes.

## Testing

- Use Vitest.
- Prefer fake child processes and dependency injection over real provider CLIs.
- Tests must not depend on installed `codex`, `claude`, `cursor-agent`, `opencode`, or `pi-acp`.
- For new behavior, write a failing test first, then implement the minimum code to pass it.
- Keep docs-sensitive package guarantees covered by tests in `tests/package-metadata.test.ts`.

## Implementation Notes

- Friendly provider ids live in `src/provider-ids.ts`.
- PATH/version detection lives in `src/detect.ts`.
- Friendly stream/result APIs live in `src/agent-runner.ts`.
- Existing low-level provider transports live in `src/codex.ts`, `src/claude.ts`, and `src/acp.ts`.
- `src/run-agent-turn.ts` dispatches one turn across all providers using internal provider ids.

## Release Notes

Before publishing:

1. Confirm the `coding-agent-runner` npm package name is available or owned.
2. Confirm GitHub repository metadata in `package.json`.
3. Run the full local verification commands.
4. Check `npm pack --dry-run` includes only `dist`, `README.md`, `LICENSE`, and `package.json`.
