import type { DesignOption, DesignReview, HarnessState } from "./types.ts";
import { requiresMandatoryDesignReview } from "./difficulty.ts";

const MAX_OPTIONS = 3;
const MIN_OPTIONS = 2;

function normalizeOption(raw: Partial<DesignOption>, index: number): DesignOption {
  const id = String(raw.id || `option-${index + 1}`).trim();
  const title = String(raw.title || "").trim();
  const angle = String(raw.angle || "").trim();
  const summary = String(raw.summary || "").trim();
  const risks = Array.isArray(raw.risks)
    ? raw.risks.map((r) => String(r).trim()).filter(Boolean)
    : [];
  const mitigations = Array.isArray(raw.mitigations)
    ? raw.mitigations.map((m) => String(m).trim()).filter(Boolean)
    : [];

  if (!title || !summary) {
    throw new Error(`Design option '${id}' requires title and summary.`);
  }

  return { id, title, angle: angle || title, summary, risks, mitigations };
}

export function ensureDesignReviewShape(value: unknown, difficulty: HarnessState["difficulty"]): DesignReview {
  const input = value && typeof value === "object" ? (value as Partial<DesignReview>) : {};
  const allowedStatus = new Set<DesignReview["status"]>([
    "not_applicable",
    "awaiting_options",
    "awaiting_choice",
    "awaiting_proposal",
    "awaiting_approval",
    "approved",
  ]);
  const defaultStatus = difficulty === 3 ? "awaiting_options" : "not_applicable";
  const status = allowedStatus.has(input.status as DesignReview["status"])
    ? (input.status as DesignReview["status"])
    : defaultStatus;

  const options = Array.isArray(input.options)
    ? input.options.map((item, index) => normalizeOption(item as Partial<DesignOption>, index))
    : [];

  const revisionCount = typeof input.revisionCount === "number" && input.revisionCount >= 0 ? input.revisionCount : 0;
  const revisionLimit = typeof input.revisionLimit === "number" && input.revisionLimit >= 0 ? input.revisionLimit : 3;

  return {
    status: difficulty === 3 && status === "not_applicable" ? "awaiting_options" : status,
    options,
    selectedOptionId: typeof input.selectedOptionId === "string" ? input.selectedOptionId : undefined,
    humanSteering: typeof input.humanSteering === "string" ? input.humanSteering : undefined,
    proposal: typeof input.proposal === "string" ? input.proposal : undefined,
    lastDeclineComment: typeof input.lastDeclineComment === "string" ? input.lastDeclineComment : undefined,
    revisionCount,
    revisionLimit,
    decidedAt: typeof input.decidedAt === "string" ? input.decidedAt : undefined,
  };
}

export type DesignGateInput = {
  step: "submit_options" | "record_choice" | "submit_proposal" | "accept" | "decline";
  options?: Array<Partial<DesignOption>>;
  selectedOptionId?: string;
  humanSteering?: string;
  proposal?: string;
  comment?: string;
  reopenOptions?: boolean;
};

function assertDesignReviewActive(state: HarnessState): void {
  if (!requiresMandatoryDesignReview(state)) {
    throw new Error("design_gate is only available when difficulty=3 (hard).");
  }
}

function findOption(review: DesignReview, optionId: string): DesignOption {
  const match = review.options.find((o) => o.id === optionId);
  if (!match) {
    throw new Error(`Unknown design option '${optionId}'. Known: ${review.options.map((o) => o.id).join(", ") || "(none)"}.`);
  }
  return match;
}

function assertRevisionBudget(review: DesignReview): void {
  if (review.revisionCount >= review.revisionLimit) {
    throw new Error(
      `Design review revision limit reached (${review.revisionCount}/${review.revisionLimit}). Escalate to a human.`,
    );
  }
}

export function applyDesignGate(state: HarnessState, input: DesignGateInput): string {
  assertDesignReviewActive(state);
  const review = state.designReview;
  const now = new Date().toISOString();

  switch (input.step) {
    case "submit_options": {
      if (review.status === "approved") {
        throw new Error("design_gate submit_options: design already approved.");
      }
      if (!["awaiting_options", "awaiting_choice", "awaiting_proposal"].includes(review.status)) {
        throw new Error(`design_gate submit_options not allowed in status=${review.status}.`);
      }
      const rawOptions = input.options ?? [];
      if (rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
        throw new Error(`design_gate submit_options requires ${MIN_OPTIONS}–${MAX_OPTIONS} options.`);
      }
      review.options = rawOptions.map((item, index) => normalizeOption(item, index));
      review.status = "awaiting_choice";
      review.proposal = undefined;
      review.lastDeclineComment = undefined;
      return `Submitted ${review.options.length} design options; waiting for human choice.`;
    }

    case "record_choice": {
      if (review.status !== "awaiting_choice") {
        throw new Error(`design_gate record_choice requires status=awaiting_choice (found ${review.status}).`);
      }
      const optionId = String(input.selectedOptionId || "").trim();
      if (!optionId) throw new Error("design_gate record_choice requires selectedOptionId.");
      findOption(review, optionId);
      const steering = String(input.humanSteering || "").trim();
      if (!steering) {
        throw new Error("design_gate record_choice requires humanSteering (human direction after picking an option).");
      }
      review.selectedOptionId = optionId;
      review.humanSteering = steering;
      review.status = "awaiting_proposal";
      review.proposal = undefined;
      return `Recorded choice '${optionId}'; submit a short refined proposal next.`;
    }

    case "submit_proposal": {
      if (review.status !== "awaiting_proposal") {
        throw new Error(`design_gate submit_proposal requires status=awaiting_proposal (found ${review.status}).`);
      }
      if (!review.selectedOptionId) {
        throw new Error("design_gate submit_proposal requires a prior record_choice.");
      }
      const proposal = String(input.proposal || "").trim();
      if (!proposal) throw new Error("design_gate submit_proposal requires proposal text.");
      review.proposal = proposal;
      review.status = "awaiting_approval";
      return "Proposal submitted; waiting for human accept or decline.";
    }

    case "accept": {
      if (review.status !== "awaiting_approval") {
        throw new Error(`design_gate accept requires status=awaiting_approval (found ${review.status}).`);
      }
      if (!review.proposal?.trim()) {
        throw new Error("design_gate accept requires a submitted proposal.");
      }
      review.status = "approved";
      review.decidedAt = now;
      review.lastDeclineComment = undefined;
      return "Design approved; you may advance to implement.";
    }

    case "decline": {
      if (review.status !== "awaiting_approval") {
        throw new Error(`design_gate decline requires status=awaiting_approval (found ${review.status}).`);
      }
      const comment = String(input.comment || "").trim();
      if (!comment) throw new Error("design_gate decline requires comment (what to change).");
      assertRevisionBudget(review);
      review.revisionCount += 1;
      review.lastDeclineComment = comment;
      review.proposal = undefined;
      review.status = input.reopenOptions ? "awaiting_options" : "awaiting_proposal";
      if (input.reopenOptions) {
        review.options = [];
        review.selectedOptionId = undefined;
        review.humanSteering = undefined;
        return `Declined (${review.revisionCount}/${review.revisionLimit}); reopening for new options.`;
      }
      return `Declined (${review.revisionCount}/${review.revisionLimit}); revise the proposal.`;
    }

    default:
      throw new Error("design_gate step must be submit_options|record_choice|submit_proposal|accept|decline.");
  }
}
