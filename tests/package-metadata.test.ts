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
    expect(readme).toContain("[English](README.md)");
    expect(readme).toContain("[简体中文](README.zh-CN.md)");
    expect(readme).not.toContain("coding-cli-runner");
  });

  it("ships localized readmes", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { files: string[] };
    const zh = readFileSync("README.zh-CN.md", "utf-8");

    expect(pkg.files).toContain("README*.md");
    expect(zh).toContain("# coding-agent-runner");
    expect(zh).toContain("[English](README.md)");
    expect(zh).toContain("[简体中文](README.zh-CN.md)");
    expect(zh).toContain("本地 coding agent CLI");
    expect(zh).toContain("runCliAgent");
    expect(zh).toContain("detectCliAgents");
    expect(zh).toContain("npm pack --dry-run");
  });

  it("documents the friendly public API", () => {
    const readme = readFileSync("README.md", "utf-8");

    expect(readme).toContain("runCliAgent");
    expect(readme).toContain("streamCliAgent");
    expect(readme).toContain("createCodingAgentRunner");
    expect(readme).toContain("detectCliAgents");
    expect(readme).toContain("Command Overrides");
    expect(readme).toContain("Cancellation");
  });

  it("provides agent contributor instructions", () => {
    const agents = readFileSync("AGENTS.md", "utf-8");

    expect(agents).toContain("coding-agent-runner");
    expect(agents).toContain("npm test");
    expect(agents).toContain("npm run typecheck");
    expect(agents).toContain("npm run build");
    expect(agents).toContain("npm pack --dry-run");
    expect(agents).toContain("Do not import AI Workbench");
    expect(agents).toContain("README.zh-CN.md");
  });
});
