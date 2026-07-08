import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectCliAgents,
  toInternalProvider,
  toPublicProvider,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeBin(name: string, output: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coding-agent-runner-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await writeFile(file, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(output)});\n`, {
    mode: 0o755,
  });
  return file;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("provider ids and detection", () => {
  it("maps public and internal provider ids", () => {
    expect(toInternalProvider("codex")).toBe("codex-cli");
    expect(toInternalProvider("claude")).toBe("claude-code-cli");
    expect(toInternalProvider("opencode-cli")).toBe("opencode-cli");
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

  it("omits missing providers by default", async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(detectCliAgents({ providers: ["cursor"] })).resolves.toEqual([]);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
