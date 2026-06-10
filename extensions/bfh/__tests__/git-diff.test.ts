import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { buildTouchedFileContext, discoverTouchedFiles } from "../git-diff.ts";

function setupRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-git-diff-"));
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  const base = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  fs.writeFileSync(path.join(cwd, "a.txt"), base, "utf8");
  execFileSync("git", ["add", "a.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "init"], { cwd });
  return cwd;
}

describe("git-diff", () => {
  test("discoverTouchedFiles returns changed ranges and untracked files", () => {
    const cwd = setupRepo();
    const lines = fs.readFileSync(path.join(cwd, "a.txt"), "utf8").trimEnd().split("\n");
    lines[1] = "line-2-updated";
    lines[7] = "line-8-updated";
    fs.writeFileSync(path.join(cwd, "a.txt"), `${lines.join("\n")}\n`, "utf8");
    fs.writeFileSync(path.join(cwd, "new.ts"), "export const n = 1;\n", "utf8");

    const touched = discoverTouchedFiles(cwd, 10);
    expect(touched.some((f) => f.path === "a.txt" && typeof f.startLine === "number")).toBe(true);
    expect(touched.some((f) => f.path === "new.ts" && f.note === "Untracked file")).toBe(true);
  });

  test("buildTouchedFileContext renders snippets and missing-file fallback", () => {
    const cwd = setupRepo();
    const touched = [
      { path: "a.txt", startLine: 2, endLine: 4 },
      { path: "missing.txt" },
    ];

    const result = buildTouchedFileContext(cwd, touched);
    expect(result.filesUsed.length).toBe(2);
    expect(result.context).toContain("## a.txt");
    expect(result.context).toContain("    2 | line-2");
    expect(result.context).toContain("## missing.txt");
    expect(result.context).toContain("File not found on disk");
  });
});
