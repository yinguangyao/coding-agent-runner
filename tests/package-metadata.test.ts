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
