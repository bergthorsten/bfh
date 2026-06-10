import { isHandsOffLevel, requiresMandatoryDesignReview } from "./difficulty.ts";
import type { DesignReviewStatus, HarnessState, HarnessStep } from "./types.ts";

export type PendingReason =
  | "pre_implement"
  | "pre_close"
  | "design_choice"
  | "design_approval"
  | "open_questions";

export type PendingHarnessInput = {
  ticketKey: string;
  step: HarnessStep;
  title: string;
  body: string;
  reasons: PendingReason[];
  /** Stable key for deduping repeated agent_end events. */
  signature: string;
};

const HUMAN_DESIGN_STATUSES = new Set<DesignReviewStatus>(["awaiting_choice", "awaiting_approval"]);

function unansweredQuestions(state: HarnessState): number {
  return state.openQuestions.filter((q) => !String(q.answer ?? "").trim()).length;
}

/**
 * Returns a user-facing summary when the harness is blocked on human or design input.
 * Agent-only design steps (options/proposal) do not count as pending human input.
 */
export function describePendingHarnessInput(state: HarnessState): PendingHarnessInput | null {
  if (state.currentStep === "done" || state.currentStep === "failed") {
    return null;
  }

  const reasons: PendingReason[] = [];

  if (!isHandsOffLevel(state)) {
    if (state.human.preImplement.status === "pending" && state.human.preImplement.requestedAt) {
      reasons.push("pre_implement");
    }
    if (state.human.preClose.status === "pending" && state.human.preClose.requestedAt) {
      reasons.push("pre_close");
    }
  }

  if (requiresMandatoryDesignReview(state) && HUMAN_DESIGN_STATUSES.has(state.designReview.status)) {
    reasons.push(
      state.designReview.status === "awaiting_choice" ? "design_choice" : "design_approval",
    );
  }

  if (unansweredQuestions(state) > 0) {
    reasons.push("open_questions");
  }

  if (reasons.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (reasons.includes("pre_implement")) {
    parts.push("pre-implement approval");
  }
  if (reasons.includes("pre_close")) {
    parts.push("pre-close approval");
  }
  if (reasons.includes("design_choice")) {
    parts.push("design option choice");
  }
  if (reasons.includes("design_approval")) {
    parts.push("design proposal approval");
  }
  if (reasons.includes("open_questions")) {
    const n = unansweredQuestions(state);
    parts.push(n === 1 ? "open question" : `${n} open questions`);
  }

  const body = `${parts.join(", ")} (${state.currentStep})`;
  const title = `BFH ${state.ticketKey} needs you`;

  return {
    ticketKey: state.ticketKey,
    step: state.currentStep,
    title,
    body,
    reasons,
    signature: `${reasons.join(",")}:${state.updatedAt}`,
  };
}
