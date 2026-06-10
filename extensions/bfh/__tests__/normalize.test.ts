import { describe, expect, test } from "bun:test";
import { AGENT_RESULT_END, AGENT_RESULT_START } from "../agent-result.ts";
import {
  buildScoutInput,
  normalizeReviewFromText,
  normalizeScoutFromText,
  shouldRetryAgentParse,
} from "../normalize.ts";
import { createState } from "../state.ts";

function makeAgentResult(payload: Record<string, unknown>): string {
  return `${AGENT_RESULT_START}\n${JSON.stringify(payload, null, 2)}\n${AGENT_RESULT_END}`;
}

describe("normalize", () => {
  test("buildScoutInput renders optional sections", () => {
    const state = createState({
      key: "PC-70",
      title: "Improve checkout",
      type: "task",
      status: "todo",
      description: "desc",
      linkedTickets: [],
      labels: [],
    });
    state.acceptanceCriteria = ["A", "B"];
    state.constraints = ["No schema changes"];

    const input = buildScoutInput(state, "Focus on migration risk");
    expect(input).toContain("Ticket: PC-70");
    expect(input).toContain("Acceptance Criteria:");
    expect(input).toContain("Known Constraints:");
    expect(input).toContain("Extra Scout Focus: Focus on migration risk");
  });

  test("normalizeScoutFromText parses AGENT_RESULT findings and limits list sizes", () => {
    const raw = makeAgentResult({
      status: "completed",
      summary: "done",
      findings: {
        relevantFiles: [{ path: "a.ts", reason: "core" }, { path: " ", reason: "ignore" }],
        patterns: [{ name: "factory", description: "pattern", file: "a.ts" }],
        commands: ["  rg foo  ", "", 1],
        constraints: [" no downtime ", ""],
      },
      artifacts: {},
      error: null,
    });

    const scout = normalizeScoutFromText(raw);
    expect(scout.relevantFiles).toEqual([{ path: "a.ts", reason: "core" }]);
    expect(scout.commands).toEqual(["rg foo"]);
    expect(scout.constraints).toEqual(["no downtime"]);
  });

  test("normalizeReviewFromText rejects malformed reviewer output", () => {
    const review = normalizeReviewFromText("not a structured agent result");
    expect(review.verdict).toBe("failed");
    expect(review.counts.critical).toBeGreaterThan(0);
    expect(review.summary).toContain("cannot be used as approval");
  });

  test("normalizeReviewFromText maps blocked or critical findings to needs_revision", () => {
    const raw = makeAgentResult({
      status: "blocked",
      summary: "needs changes",
      findings: {
        critical: 0,
        warnings: 1,
        info: 0,
        details: [{ severity: "warning", message: "fix naming", category: "style" }],
      },
      artifacts: {},
      error: null,
    });

    const review = normalizeReviewFromText(raw);
    expect(review.verdict).toBe("needs_revision");
    expect(review.counts.warning).toBe(1);
  });

  test("shouldRetryAgentParse only false for valid AGENT_RESULT", () => {
    expect(shouldRetryAgentParse("plain text")).toBe(true);
    expect(
      shouldRetryAgentParse(
        makeAgentResult({
          status: "completed",
          summary: "ok",
          findings: {},
          artifacts: {},
          error: null,
        }),
      ),
    ).toBe(false);
  });
});
