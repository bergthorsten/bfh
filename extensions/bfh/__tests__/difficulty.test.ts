import { describe, expect, test } from "bun:test";
import { applyAdvance, createState } from "../state.ts";
import { applyDesignGate } from "../design-review.ts";

const emptyIssue = {
  key: "PC-50",
  title: "t",
  type: "task",
  status: "todo",
  description: "",
  linkedTickets: [] as Array<{ key: string; type: string }>,
  labels: [] as string[],
};

describe("difficulty", () => {
  test("level 1 bypasses pre-close and blocks close -> implement", () => {
    const state = createState(emptyIssue, { difficulty: 1 });
    expect(state.human.preClose.status).toBe("approved");
    applyAdvance(state, "scout");
    applyAdvance(state, "implement");
    applyAdvance(state, "verify_review");
    applyAdvance(state, "close");
    expect(() => applyAdvance(state, "implement")).toThrow(/difficulty level 1/i);
  });

  test("level 3 blocks implement until design approved", () => {
    const state = createState(emptyIssue, { difficulty: 3 });
    applyAdvance(state, "scout");
    applyAdvance(state, "clarify");

    expect(() => applyAdvance(state, "implement")).toThrow(/design review must be approved/i);

    applyDesignGate(state, {
      step: "submit_options",
      options: [
        { id: "a", title: "A", angle: "incremental", summary: "Small change", risks: ["r"], mitigations: ["m"] },
        { id: "b", title: "B", angle: "rewrite", summary: "Bigger change", risks: ["r2"], mitigations: ["m2"] },
      ],
    });
    applyDesignGate(state, {
      step: "record_choice",
      selectedOptionId: "a",
      humanSteering: "Prefer incremental; keep API stable.",
    });
    applyDesignGate(state, {
      step: "submit_proposal",
      proposal: "Add adapter layer; ship behind flag.",
    });
    applyDesignGate(state, { step: "accept" });

    applyAdvance(state, "implement");
    expect(state.currentStep).toBe("implement");
  });

  test("level 3 decline loops with revision budget", () => {
    const state = createState(emptyIssue, { difficulty: 3 });
    applyAdvance(state, "scout");
    applyAdvance(state, "clarify");

    applyDesignGate(state, {
      step: "submit_options",
      options: [
        { id: "a", title: "A", angle: "x", summary: "s1", risks: [], mitigations: [] },
        { id: "b", title: "B", angle: "y", summary: "s2", risks: [], mitigations: [] },
      ],
    });
    applyDesignGate(state, {
      step: "record_choice",
      selectedOptionId: "a",
      humanSteering: "go",
    });
    applyDesignGate(state, { step: "submit_proposal", proposal: "v1" });
    applyDesignGate(state, { step: "decline", comment: "too vague" });
    expect(state.designReview.status).toBe("awaiting_proposal");
    expect(state.designReview.revisionCount).toBe(1);
  });
});
