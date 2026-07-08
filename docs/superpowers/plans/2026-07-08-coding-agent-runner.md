# Coding Agent Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish this repository as the independent npm package `coding-agent-runner`.

**Architecture:** Preserve the existing transport modules and add a friendly public SDK layer over `runAgentTurn()`. Rename package metadata/docs, add PATH detection, add stateful and one-shot public helpers, then verify tests, build, CI, and npm pack.

**Tech Stack:** TypeScript ESM, Node.js 20+, npm, Vitest, GitHub Actions, `@zed-industries/agent-client-protocol`.

---

### Task 1: Rename Package Metadata And Docs

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `src/index.ts`
- Modify: `src/codex.ts`
- Modify: `src/claude.ts`
- Test: `tests/package-metadata.test.ts`

- [ ] **Step 1: Write failing metadata test**

Create `tests/package-metadata.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("package metadata", () => {
  it("uses the public npm package name", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { name: string };
    const lock = JSON.parse(readFileSync("package-lock.json", "utf-8")) as {
      name: string;
      packages: { "": { name: string } };
    };
    expect(pkg.name).toBe("coding-agent-runner");
    expect(lock.name).toBe("coding-agent-runner");
    expect(lock.packages[""].name).toBe("coding-agent-runner");
  });

  it("documents the public package name", () => {
    const readme = readFileSync("README.md", "utf-8");
    expect(readme).toContain("# coding-agent-runner");
    expect(readme).toContain("npm install coding-agent-runner");
    expect(readme).not.toContain("coding-cli-runner");
  });
});
```

- [ ] **Step 2: Run the metadata test to verify it fails**

Run: `npm test -- tests/package-metadata.test.ts`

Expected: FAIL because current metadata still says `coding-cli-runner`.

- [ ] **Step 3: Rename package metadata and generated strings**

Change:

- `package.json` `name` to `coding-agent-runner`.
- Repository, bugs, and homepage URLs to `coding-agent-runner`.
- `package-lock.json` root `name` fields to `coding-agent-runner`.
- README title/install/import examples to `coding-agent-runner`.
- `src/index.ts` top comment to `coding-agent-runner`.
- Codex client info in `src/codex.ts` to `{ name: "coding-agent-runner", title: "coding-agent-runner" }`.
- Claude temp MCP filename prefix in `src/claude.ts` to `coding-agent-runner-claude-mcp-`.

- [ ] **Step 4: Run metadata test**

Run: `npm test -- tests/package-metadata.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json README.md src/index.ts src/codex.ts src/claude.ts tests/package-metadata.test.ts
git commit -m "chore: rename package to coding-agent-runner"
```

---

### Task 2: Add Public Provider IDs And Detection

**Files:**
- Modify: `src/types.ts`
- Create: `src/provider-ids.ts`
- Create: `src/detect.ts`
- Modify: `src/index.ts`
- Test: `tests/detect.test.ts`

- [ ] **Step 1: Write failing provider and detection tests**

Create `tests/detect.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectCliAgents, toInternalProvider, toPublicProvider } from "../src/index.js";

const tempDirs: string[] = [];

async function makeBin(name: string, output: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coding-agent-runner-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(output)});\n`, { mode: 0o755 });
  return file;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("provider ids and detection", () => {
  it("maps public and internal provider ids", () => {
    expect(toInternalProvider("codex")).toBe("codex-cli");
    expect(toInternalProvider("claude")).toBe("claude-code-cli");
    expect(toPublicProvider("cursor-cli")).toBe("cursor");
  });

  it("detects installed providers from PATH", async () => {
    const codex = await makeBin("codex", "codex 1.2.3");
    const oldPath = process.env.PATH;
    process.env.PATH = `${path.dirname(codex)}${path.delimiter}${oldPath ?? ""}`;
    try {
      await expect(detectCliAgents({ providers: ["codex"] })).resolves.toEqual([
        {
          provider: "codex",
          internalProvider: "codex-cli",
          binary: "codex",
          path: codex,
          version: "1.2.3",
          runnable: true,
        },
      ]);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
```

- [ ] **Step 2: Run detection tests to verify they fail**

Run: `npm test -- tests/detect.test.ts`

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Add provider id mapping**

Create `src/provider-ids.ts`:

```ts
/** Public and internal provider id mapping. */
import type { CodingCliProvider } from "./types.js";

export type CodingAgentProvider = "codex" | "claude" | "cursor" | "opencode" | "pi";
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

export function isPublicProvider(provider: AnyCodingProvider): provider is CodingAgentProvider {
  return provider in PUBLIC_TO_INTERNAL;
}

export function toInternalProvider(provider: AnyCodingProvider): CodingCliProvider {
  return isPublicProvider(provider) ? PUBLIC_TO_INTERNAL[provider] : provider;
}

export function toPublicProvider(provider: CodingCliProvider): CodingAgentProvider {
  return INTERNAL_TO_PUBLIC[provider];
}

export const PUBLIC_PROVIDERS = Object.keys(PUBLIC_TO_INTERNAL) as CodingAgentProvider[];
```

- [ ] **Step 4: Add detection implementation**

Create `src/detect.ts` with PATH scanning, version parsing, and exported `detectCliAgents(options)` that returns detected providers using public ids.

The provider probes must be:

```ts
[
  ["codex", "codex", ["--version"]],
  ["claude", "claude", ["--version"]],
  ["cursor", "cursor-agent", ["--version"]],
  ["opencode", "opencode", ["--version"]],
  ["pi", "pi-acp", ["--version"]],
]
```

Use version regex:

```ts
/(\\d+\\.\\d+\\.\\d+(?:[-+][\\w.]+)?)/
```

- [ ] **Step 5: Export detection and provider ids**

Add to `src/index.ts`:

```ts
export * from "./provider-ids.js";
export * from "./detect.js";
```

- [ ] **Step 6: Run detection tests**

Run: `npm test -- tests/detect.test.ts`

Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/provider-ids.ts src/detect.ts src/index.ts tests/detect.test.ts
git commit -m "feat: add public provider detection"
```

---

### Task 3: Add Friendly Public Runner API

**Files:**
- Modify: `src/types.ts`
- Create: `src/agent-runner.ts`
- Modify: `src/index.ts`
- Test: `tests/agent-runner.test.ts`

- [ ] **Step 1: Write failing public API tests**

Create `tests/agent-runner.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createCodingAgentRunner, runCliAgent, streamCliAgent } from "../src/index.js";

describe("friendly public runner api", () => {
  it("runCliAgent returns final output for a public provider id", async () => {
    const runAgentTurn = vi.fn(async ({ onEvent }: any) => {
      onEvent?.({ type: "message_delta", text: "hello" });
      return {
        provider: "codex-cli",
        status: "completed",
        output: "hello",
        sessionId: "thread-1",
        errorMessage: null,
      };
    });

    await expect(runCliAgent({
      provider: "codex",
      cwd: "/repo",
      prompt: "hi",
      deps: { runAgentTurn },
    })).resolves.toMatchObject({
      ok: true,
      output: "hello",
      provider: "codex",
      sessionId: "thread-1",
    });
  });

  it("streamCliAgent maps legacy event names to public event names", async () => {
    const runAgentTurn = vi.fn(async ({ onEvent }: any) => {
      onEvent?.({ type: "message_delta", text: "hello" });
      onEvent?.({ type: "thinking_delta", text: "thinking" });
      return {
        provider: "codex-cli",
        status: "completed",
        output: "hello",
        sessionId: "thread-1",
        errorMessage: null,
      };
    });

    const events = [];
    for await (const event of streamCliAgent({
      provider: "codex",
      cwd: "/repo",
      prompt: "hi",
      deps: { runAgentTurn },
    })) events.push(event);

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "thinking_delta", text: "thinking" },
      { type: "done", output: "hello", sessionId: "thread-1", stopReason: "completed" },
    ]);
  });

  it("createCodingAgentRunner reuses the previous session id", async () => {
    const runAgentTurn = vi.fn(async () => ({
      provider: "claude-code-cli",
      status: "completed",
      output: "ok",
      sessionId: "session-next",
      errorMessage: null,
    }));
    const runner = await createCodingAgentRunner({
      provider: "claude",
      cwd: "/repo",
      deps: { runAgentTurn },
    });

    for await (const _event of runner.stream({ prompt: "first" })) {}
    for await (const _event of runner.stream({ prompt: "second" })) {}

    expect(runAgentTurn.mock.calls[1][0].sessionId).toBe("session-next");
    await runner.close();
  });
});
```

- [ ] **Step 2: Run public API tests to verify they fail**

Run: `npm test -- tests/agent-runner.test.ts`

Expected: FAIL because the new API does not exist.

- [ ] **Step 3: Implement public runner API**

Create `src/agent-runner.ts`:

```ts
/** Friendly public runner API for local app developers. */
import { runAgentTurn, type RunAgentTurnDeps } from "./run-agent-turn.js";
import type { AgentStreamEvent, AgentTurnStatus, SpawnParams } from "./types.js";
import { toInternalProvider, type AnyCodingProvider, type CodingAgentProvider } from "./provider-ids.js";

export type CodingAgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown }
  | { type: "tool_update"; id: string; name: string; input?: unknown; output?: string }
  | { type: "tool_end"; id: string; name: string; output: string; isError: boolean }
  | { type: "done"; output: string; sessionId: string | null; stopReason: AgentTurnStatus }
  | { type: "error"; error: Error };

export interface CodingAgentRunnerOptions {
  provider: AnyCodingProvider;
  cwd: string;
  model?: string | null;
  sessionId?: string | null;
  env?: Record<string, string | undefined>;
  spawn?: Partial<Pick<SpawnParams, "command" | "args" | "env" | "wrapper">>;
  signal?: AbortSignal;
  deps?: { runAgentTurn?: RunAgentTurnDeps["runCodexTurn"] extends never ? never : typeof runAgentTurn };
}

export interface CodingAgentTurnOptions {
  prompt: string;
  signal?: AbortSignal;
}

export interface CodingAgentRunOptions extends CodingAgentRunnerOptions, CodingAgentTurnOptions {}

export interface CodingAgentRunResult {
  ok: boolean;
  output: string;
  provider: CodingAgentProvider;
  sessionId: string | null;
  errorMessage: string | null;
}

export interface CodingAgentRunner {
  readonly provider: CodingAgentProvider;
  readonly sessionId: string | null;
  stream(turn: CodingAgentTurnOptions): AsyncIterable<CodingAgentEvent>;
  close(): Promise<void>;
}
```

Then complete the file with:

- `mapPublicEvent(event: AgentStreamEvent): CodingAgentEvent[]`
- `streamCliAgent(options)`
- `runCliAgent(options)`
- `createCodingAgentRunner(options)`

Use a package-private dependency shape:

```ts
type PublicRunnerDeps = { runAgentTurn?: typeof runAgentTurn };
```

The implementation must call the injected `runAgentTurn` in tests and the real `runAgentTurn` in production.

- [ ] **Step 4: Export public runner API**

Add to `src/index.ts`:

```ts
export * from "./agent-runner.js";
```

- [ ] **Step 5: Run public API tests**

Run: `npm test -- tests/agent-runner.test.ts`

Expected: PASS.

- [ ] **Step 6: Run full tests and typecheck**

Run:

```bash
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/agent-runner.ts src/index.ts tests/agent-runner.test.ts
git commit -m "feat: add friendly runner api"
```

---

### Task 4: Update README And Verify Pack/CI

**Files:**
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/publish.yml`

- [ ] **Step 1: Update README**

README must lead with `runCliAgent`, `streamCliAgent`, `createCodingAgentRunner`, and `detectCliAgents`. Keep a lower-level section documenting existing `runAgentTurn`, `runCodexTurn`, `runClaudeNative`, and `AcpConnection` exports.

- [ ] **Step 2: Ensure CI uses package check and pack dry-run**

In `.github/workflows/ci.yml`, after `npm run check`, add:

```yaml
      - run: npm pack --dry-run
```

Keep `.github/workflows/publish.yml` release/manual publish flow using provenance.

- [ ] **Step 3: Run final verification**

Run:

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Expected: all commands PASS and npm pack lists only intended package files.

- [ ] **Step 4: Commit**

```bash
git add README.md .github/workflows/ci.yml .github/workflows/publish.yml
git commit -m "docs: document coding-agent-runner api"
```

