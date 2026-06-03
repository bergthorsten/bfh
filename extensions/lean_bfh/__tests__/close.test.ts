import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateCloseReadiness } from "../close.ts";
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
