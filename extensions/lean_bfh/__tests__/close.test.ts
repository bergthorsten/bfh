import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { assertCleanWorkingTree, evaluateCloseReadiness, executeCloseCreate, resolveBaseBranch } from "../close.ts";
import { writeReviewedMarker, writeTestedMarker } from "../evidence-markers.ts";
import { buildReviewResult } from "../review.ts";
import { applyAdvance, createState, writeState } from "../state.ts";

function makeCloseReadyState() {
  const state = createState({
    key: "PC-30",
    title: "close test",
    type: "task",
    status: "todo",
    description: "",
    linkedTickets: [],
    labels: [],
  });
  applyAdvance(state, "scout");
  applyAdvance(state, "implement");
  applyAdvance(state, "verify_review");
  applyAdvance(state, "close");
  state.human.preClose.status = "approved";
  state.review = buildReviewResult({ verdict: "approved", findings: [], summary: "ok" });
  state.evidence.push(
    { type: "test", passed: true, summary: "unit tests", createdAt: new Date().toISOString() },
    { type: "review", passed: true, summary: "review ok", createdAt: new Date().toISOString() },
  );
  return state;
}

function setupGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lean-bfh-close-repo-"));
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  fs.writeFileSync(path.join(cwd, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["commit", "-m", "init"], { cwd });
  return cwd;
}

describe("evaluateCloseReadiness", () => {
  test("fails when step is not close", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lean-bfh-close-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-30.state.json");
    const state = makeCloseReadyState();
    state.currentStep = "implement";
    writeState(statePath, state);

    const result = evaluateCloseReadiness(cwd, statePath, state);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("currentStep"))).toBe(true);
  });

  test("fails without filesystem markers", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lean-bfh-close-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-30.state.json");
    const state = makeCloseReadyState();
    writeState(statePath, state);

    const result = evaluateCloseReadiness(cwd, statePath, state);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("tested.json"))).toBe(true);
  });

  test("passes with evidence and markers", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lean-bfh-close-ok-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-31.state.json");
    const state = makeCloseReadyState();
    state.ticketKey = "PC-31";
    writeState(statePath, state);
    writeTestedMarker(statePath, state, { outputContent: "PASS\n", passed: true });
    writeReviewedMarker(statePath, state, "unit-test");

    const result = evaluateCloseReadiness(cwd, statePath, state);
    expect(result.ok).toBe(true);
    expect(result.prBody).toContain("PC-31");
    expect(result.prBody).toContain("Acceptance criteria");
  });

  test("blocks when human pre-close approval is missing", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lean-bfh-close-human-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-35.state.json");
    const state = makeCloseReadyState();
    state.ticketKey = "PC-35";
    state.human.preClose.status = "pending";
    writeState(statePath, state);
    writeTestedMarker(statePath, state, { outputContent: "PASS\n", passed: true });
    writeReviewedMarker(statePath, state, "unit-test");

    const result = evaluateCloseReadiness(cwd, statePath, state);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => /human pre-close approval/i.test(r))).toBe(true);
  });

  test("difficulty level 1 bypasses pre-close human gate", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lean-bfh-close-level1-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-36.state.json");
    const state = makeCloseReadyState();
    state.ticketKey = "PC-36";
    state.difficulty = 1;
    state.human.preClose.status = "pending";
    writeState(statePath, state);
    writeTestedMarker(statePath, state, { outputContent: "PASS\n", passed: true });
    writeReviewedMarker(statePath, state, "unit-test");

    const result = evaluateCloseReadiness(cwd, statePath, state);
    expect(result.ok).toBe(true);
  });

  test("blocks on critical findings without override", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lean-bfh-close-crit-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-32.state.json");
    const state = makeCloseReadyState();
    state.ticketKey = "PC-32";
    state.review = buildReviewResult({
      verdict: "approved",
      findings: [{ severity: "critical", category: "bug", message: "blocker" }],
      summary: "has critical",
    });
    writeState(statePath, state);
    writeTestedMarker(statePath, state, { outputContent: "PASS\n", passed: true });
    writeReviewedMarker(statePath, state, "unit-test");

    const result = evaluateCloseReadiness(cwd, statePath, state);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => /critical/i.test(r))).toBe(true);
  });
});

describe("executeCloseCreate", () => {
  test("dryRun returns PR payload without creating PR", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lean-bfh-close-dry-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-80.state.json");
    const state = makeCloseReadyState();
    state.ticketKey = "PC-80";
    writeState(statePath, state);
    writeTestedMarker(statePath, state, { outputContent: "PASS\n", passed: true });
    writeReviewedMarker(statePath, state, "unit-test");

    const result = executeCloseCreate(cwd, statePath, state, { dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.prBody).toContain("## Summary");
  });

  test("treats existing PR as success when gh reports already exists URL", () => {
    const cwd = setupGitRepo();
    const statePath = path.join(cwd, ".pi", "bfh", "PC-81.state.json");
    const state = makeCloseReadyState();
    state.ticketKey = "PC-81";
    writeState(statePath, state);
    writeTestedMarker(statePath, state, { outputContent: "PASS\n", passed: true });
    writeReviewedMarker(statePath, state, "unit-test");

    const fakeBin = path.join(cwd, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    const ghPath = path.join(fakeBin, "gh");
    fs.writeFileSync(
      ghPath,
      "#!/usr/bin/env bash\n" +
        "echo 'a pull request for branch already exists: https://github.com/acme/shop/pull/99' >&2\n" +
        "exit 1\n",
      "utf8",
    );
    fs.chmodSync(ghPath, 0o755);

    const originalPath = process.env.PATH || "";
    process.env.PATH = `${fakeBin}:${originalPath}`;
    try {
      const result = executeCloseCreate(cwd, statePath, state, {
        pushBranch: false,
        requireCleanTree: false,
      });
      expect(result.ok).toBe(true);
      expect(result.created).toBe(false);
      expect(result.prUrl).toBe("https://github.com/acme/shop/pull/99");
      expect(state.pr.url).toBe("https://github.com/acme/shop/pull/99");
      expect(state.currentStep).toBe("pr_review");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("close helpers", () => {
  test("assertCleanWorkingTree throws on dirty repo", () => {
    const cwd = setupGitRepo();
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "x\n", "utf8");
    expect(() => assertCleanWorkingTree(cwd)).toThrow(/not clean/i);
  });

  test("resolveBaseBranch prefers explicit then state", () => {
    const state = makeCloseReadyState();
    state.git.baseBranch = "develop";
    expect(resolveBaseBranch(process.cwd(), "main", state)).toBe("main");
    expect(resolveBaseBranch(process.cwd(), undefined, state)).toBe("develop");
  });
});
