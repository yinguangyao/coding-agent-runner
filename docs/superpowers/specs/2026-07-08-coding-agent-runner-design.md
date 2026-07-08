# Coding Agent Runner Design

## Background

This repository already contains a Node.js TypeScript package that wraps local coding-agent CLIs:

- Codex CLI through `codex app-server --listen stdio://`
- Claude Code through native `stream-json`
- Cursor Agent, OpenCode, and Pi through ACP

The target npm package name is `coding-agent-runner`. The AI Workbench repository at `~/Desktop/project/ai-workbench` is only a source reference for protocol behavior; implementation belongs in this repository.

## Goals

1. Rename the package from `coding-cli-runner` to `coding-agent-runner`.
2. Keep the existing low-level transport exports for Codex, Claude, and ACP.
3. Add a friendlier public API for local app developers:
   - `detectCliAgents()`
   - `createCodingAgentRunner()`
   - `streamCliAgent()`
   - `runCliAgent()`
4. Support public provider ids: `codex`, `claude`, `cursor`, `opencode`, `pi`.
5. Preserve compatibility with existing internal provider ids: `codex-cli`, `claude-code-cli`, `cursor-cli`, `opencode-cli`, `pi-cli`.
6. Normalize the new public stream API to `text_delta`, `thinking_delta`, `tool_start`, `tool_update`, `tool_end`, `done`, and `error`.
7. Keep CI, tests, build, typecheck, and npm pack dry-run passing without real provider credentials.

## Non-Goals

- Do not push to GitHub in this phase.
- Do not publish to npm in this phase.
- Do not auto-install or authenticate provider CLIs.
- Do not add Electron, AI Workbench team-server, database, task queue, artifact, or UI concepts.
- Do not remove the existing lower-level exports while adding the new public API.

## Design

Add a thin public layer on top of the current `runAgentTurn()` implementation:

- Friendly provider ids map to existing provider ids.
- `streamCliAgent()` runs one turn and exposes an async iterable.
- `runCliAgent()` consumes `streamCliAgent()` and returns the final output.
- `createCodingAgentRunner()` keeps the last provider session id in memory and reuses it across turns.
- `detectCliAgents()` scans PATH and runs version commands with timeouts.

This keeps the protocol-heavy implementation stable while making the package API read like an open-source SDK.

## Testing

Add tests for:

- Package name and README references.
- Provider id mapping.
- CLI detection with fake PATH binaries.
- `streamCliAgent()` and `runCliAgent()` using dependency injection instead of real CLIs.
- Existing low-level tests still passing.

## Release Readiness

Final local verification must run:

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

