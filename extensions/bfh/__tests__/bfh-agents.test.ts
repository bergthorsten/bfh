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
  let prevPiAgentDir: string | undefined;

  afterEach(() => {
    if (prevPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevPiAgentDir;

    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("writes scout and reviewer agent files with tintinweb frontmatter", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-agents-"));
    prevPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpDir;
    ensureBfhSubagentDefinitions(tmpDir);

    const agentsDir = getBfhSubagentDefinitionsDir();
    const scoutPath = path.join(agentsDir, "scout.md");
    const reviewerPath = path.join(agentsDir, "reviewer.md");
    const legacyScoutPath = path.join(tmpDir, ".pi", "agents", "scout.md");

    expect(fs.existsSync(scoutPath)).toBe(true);
    expect(fs.existsSync(reviewerPath)).toBe(true);
    expect(fs.existsSync(legacyScoutPath)).toBe(false);

    const scout = fs.readFileSync(scoutPath, "utf8");
    expect(scout).toMatch(/^---\n/);
    expect(scout).toContain("tools: read, bash, grep, find, ls");
    expect(scout).toContain("extensions: false");
    expect(scout).toContain("skills: true");
    expect(scout).toContain("prompt_mode: replace");
    expect(scout).toContain("# Scout — Read-Only Exploration Agent");
    expect(scout).toContain("<<<AGENT_RESULT");

    const reviewer = fs.readFileSync(reviewerPath, "utf8");
    expect(reviewer).toContain("# Reviewer — Code Review Agent");
    expect(reviewer).toContain("max_turns: 40");
  });

  test("is idempotent when content unchanged", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-agents-"));
    prevPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpDir;
    ensureBfhSubagentDefinitions(tmpDir);
    const scoutPath = path.join(getBfhSubagentDefinitionsDir(), "scout.md");
    const mtime1 = fs.statSync(scoutPath).mtimeMs;

    ensureBfhSubagentDefinitions(tmpDir);
    const mtime2 = fs.statSync(scoutPath).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  test("removes legacy project-local generated files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-agents-"));
    prevPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpDir;

    ensureBfhSubagentDefinitions(tmpDir);
    const generated = fs.readFileSync(path.join(getBfhSubagentDefinitionsDir(), "scout.md"), "utf8");
    const legacyPath = path.join(tmpDir, ".pi", "agents", "scout.md");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, generated, "utf8");

    ensureBfhSubagentDefinitions(tmpDir);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });
});
