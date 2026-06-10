import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureBfhSubagentDefinitions,
  getBfhSubagentDefinitionsDir,
} from "../bfh-agents.ts";

describe("bfh-agents", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("writes scout and reviewer agent files with tintinweb frontmatter", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-agents-"));
    ensureBfhSubagentDefinitions(tmpDir);

    const agentsDir = getBfhSubagentDefinitionsDir(tmpDir);
    const scoutPath = path.join(agentsDir, "scout.md");
    const reviewerPath = path.join(agentsDir, "reviewer.md");

    expect(fs.existsSync(scoutPath)).toBe(true);
    expect(fs.existsSync(reviewerPath)).toBe(true);

    const scout = fs.readFileSync(scoutPath, "utf8");
    expect(scout).toMatch(/^---\n/);
    expect(scout).toContain("tools: read, bash, grep, find, ls");
    expect(scout).toContain("extensions: false");
    expect(scout).toContain("prompt_mode: replace");
    expect(scout).toContain("# Scout — Read-Only Exploration Agent");
    expect(scout).toContain("<<<AGENT_RESULT");

    const reviewer = fs.readFileSync(reviewerPath, "utf8");
    expect(reviewer).toContain("# Reviewer — Code Review Agent");
    expect(reviewer).toContain("max_turns: 40");
  });

  test("is idempotent when content unchanged", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-agents-"));
    ensureBfhSubagentDefinitions(tmpDir);
    const scoutPath = path.join(getBfhSubagentDefinitionsDir(tmpDir), "scout.md");
    const mtime1 = fs.statSync(scoutPath).mtimeMs;

    ensureBfhSubagentDefinitions(tmpDir);
    const mtime2 = fs.statSync(scoutPath).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });
});
