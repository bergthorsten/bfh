import { describe, expect, test } from "bun:test";
import { AGENT_RESULT_END, AGENT_RESULT_START } from "../agent-result.ts";
import { createState } from "../state.ts";
import {
  UnknownOutcomeError,
  applicableOutcomes,
  assertOutcomeMatrixExhaustive,
  classifyScoutOutcome,
  classifyVerifyReviewOutcome,
  resolveOutcome,
  resolveVerifyReviewTransitionFromOutcome,
} from "../outcome-table.ts";
import { buildReviewResult } from "../review.ts";

describe("outcome table", () => {
  test("matrix is exhaustive for applicable pairs", () => {
    expect(() => assertOutcomeMatrixExhaustive()).not.toThrow();
  });

  test("rejects unknown phase/outcome pairs", () => {
    expect(() => resolveOutcome("scout", "pass" as never)).toThrow(UnknownOutcomeError);
  });

  test("every applicable outcome resolves", () => {
    for (const phase of ["scout", "verify_review", "close", "pr_review"] as const) {
      for (const outcome of applicableOutcomes(phase)) {
        expect(resolveOutcome(phase, outcome).action).toBeDefined();
      }
    }
  });
});

describe("classifyScoutOutcome", () => {
  test("timeout from subagent error", () => {
    expect(classifyScoutOutcome("", "request timeout")).toBe("fail-timeout");
  });

  test("malformed AGENT_RESULT", () => {
    expect(classifyScoutOutcome("no block")).toBe("fail-agent-protocol");
  });

  test("failed agent status is fail-agent-protocol", () => {
    const raw = `${AGENT_RESULT_START}\n${JSON.stringify({
      status: "failed",
      summary: "scout broke",
      artifacts: {},
      error: "boom",
    })}\n${AGENT_RESULT_END}`;
    expect(classifyScoutOutcome(raw)).toBe("fail-agent-protocol");
  });

  test("completed scout", () => {
    const raw = `${AGENT_RESULT_START}\n${JSON.stringify({
      status: "completed",
      summary: "ok",
      artifacts: {},
      error: null,
    })}\n${AGENT_RESULT_END}`;
    expect(classifyScoutOutcome(raw)).toBe("completed");
  });
});

describe("verify_review outcomes", () => {
  test("approved with no critical findings advances to close", () => {
    const state = createState({
      key: "PC-1",
      title: "t",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    state.revisionCount = 0;
    const review = buildReviewResult({ verdict: "approved", findings: [], summary: "ok" });
    expect(classifyVerifyReviewOutcome(state, review, true)).toBe("pass");
    expect(resolveVerifyReviewTransitionFromOutcome(state, review, true).transition).toBe("close");
  });

  test("approved with advisory findings at L2 stays for human post_review", () => {
    const state = createState({
      key: "PC-1B",
      title: "t",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    state.currentStep = "verify_review";
    const review = buildReviewResult({
      verdict: "approved",
      findings: [{ severity: "warning", category: "tests", message: "add regression test" }],
      summary: "advisories only",
    });
    expect(classifyVerifyReviewOutcome(state, review, true)).toBe("pass-advisory");
    expect(resolveVerifyReviewTransitionFromOutcome(state, review, true).transition).toBe("verify_review");
  });

  test("approved with advisory findings at L1 advances to close", () => {
    const state = createState(
      {
        key: "PC-1C",
        title: "t",
        type: "task",
        status: "todo",
        description: "",
        linkedTickets: [],
        labels: [],
      },
      { difficulty: 1 },
    );
    const review = buildReviewResult({
      verdict: "approved",
      findings: [
        { severity: "warning", category: "tests", message: "add regression test" },
        { severity: "info", category: "style", message: "nit" },
      ],
      summary: "advisories only",
    });
    expect(classifyVerifyReviewOutcome(state, review, true)).toBe("pass");
    expect(resolveVerifyReviewTransitionFromOutcome(state, review, true).transition).toBe("close");
  });

  test("critical findings loop to implement when budget remains", () => {
    const state = createState({
      key: "PC-2",
      title: "t",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    state.revisionCount = 0;
    state.revisionLimit = 2;
    const review = buildReviewResult({
      verdict: "needs_revision",
      findings: [{ severity: "critical", category: "bug", message: "blocker" }],
      summary: "fix",
    });
    expect(classifyVerifyReviewOutcome(state, review, true)).toBe("fail-critical");
    expect(resolveVerifyReviewTransitionFromOutcome(state, review, true).transition).toBe("implement");
  });
});
