import { describe, expect, test } from "bun:test";
import { describePendingHarnessInput } from "../pending-input.ts";
import { createState } from "../state.ts";

const emptyIssue = {
  key: "PC-99",
  title: "Notify test",
  type: "task",
  status: "todo",
  description: "",
  linkedTickets: [] as Array<{ key: string; type: string }>,
  labels: [] as string[],
};

describe("describePendingHarnessInput", () => {
  test("returns null when workflow is done", () => {
    const state = createState(emptyIssue, { difficulty: 2 });
    state.currentStep = "done";
    state.human.preClose.status = "pending";
    expect(describePendingHarnessInput(state)).toBeNull();
  });

  test("detects post-review pending with advisory findings", () => {
    const state = createState(emptyIssue, { difficulty: 2 });
    state.currentStep = "verify_review";
    state.human.postReview = {
      status: "pending",
      requestedAt: "2026-01-01T00:00:00.000Z",
    };
    state.review = {
      verdict: "approved",
      summary: "ok with notes",
      counts: { critical: 0, warning: 1, info: 1 },
      findings: [
        { severity: "warning", category: "tests", message: "add test" },
        { severity: "info", category: "style", message: "nit" },
      ],
    };
    const pending = describePendingHarnessInput(state);
    expect(pending?.reasons).toContain("post_review");
    expect(pending?.body).toContain("warning");
    expect(pending?.body).toContain("add test");
  });

  test("detects pre-implement pending after human_gate request", () => {
    const state = createState(emptyIssue, { difficulty: 2 });
    state.human.preImplement = {
      required: true,
      status: "pending",
      requestedAt: "2026-01-01T00:00:00.000Z",
    };
    const pending = describePendingHarnessInput(state);
    expect(pending?.reasons).toContain("pre_implement");
    expect(pending?.title).toContain("PC-99");
  });

  test("ignores human gates at difficulty level 1", () => {
    const state = createState(emptyIssue, { difficulty: 1 });
    state.human.preImplement = {
      required: true,
      status: "pending",
      requestedAt: "2026-01-01T00:00:00.000Z",
    };
    state.human.preClose = { status: "pending", requestedAt: "2026-01-01T00:00:00.000Z" };
    expect(describePendingHarnessInput(state)).toBeNull();
  });

  test("ignores default pre-close pending without requestedAt", () => {
    const state = createState(emptyIssue, { difficulty: 2 });
    expect(state.human.preClose.status).toBe("pending");
    expect(state.human.preClose.requestedAt).toBeUndefined();
    expect(describePendingHarnessInput(state)).toBeNull();
  });

  test("detects design choice and approval, not agent-only design steps", () => {
    const state = createState(emptyIssue, { difficulty: 3 });
    state.designReview.status = "awaiting_options";
    expect(describePendingHarnessInput(state)).toBeNull();

    state.designReview.status = "awaiting_choice";
    expect(describePendingHarnessInput(state)?.reasons).toContain("design_choice");

    state.designReview.status = "awaiting_proposal";
    expect(describePendingHarnessInput(state)).toBeNull();

    state.designReview.status = "awaiting_approval";
    expect(describePendingHarnessInput(state)?.reasons).toContain("design_approval");
  });

  test("detects unanswered open questions", () => {
    const state = createState(emptyIssue, { difficulty: 2 });
    state.openQuestions = [
      { id: "q1", question: "Which API?" },
      { id: "q2", question: "Done", answer: "REST" },
    ];
    const pending = describePendingHarnessInput(state);
    expect(pending?.reasons).toContain("open_questions");
    expect(pending?.body).toContain("open question");
  });
});
