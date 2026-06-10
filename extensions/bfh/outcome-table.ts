import { agentResultParsedOk, parseAgentResult } from "./agent-result.ts";
import { isHandsOffLevel } from "./difficulty.ts";
import { getReviewCounts, hasAdvisoryFindings, type HarnessReview } from "./review.ts";
import type { PrReviewSnapshot } from "./pr-sync.ts";
import type { HarnessState, HarnessStep } from "./types.ts";

export type BfhPhase = "scout" | "verify_review" | "close" | "pr_review";

export type ScoutOutcome = "completed" | "fail-timeout" | "fail-agent-protocol";
export type VerifyReviewOutcome =
  | "pass"
  | "pass-advisory"
  | "fail-critical"
  | "fail-soft"
  | "budget-exhausted"
  | "fail-agent-protocol";
export type CloseOutcome = "success" | "fail-gates" | "fail-gh" | "fail-agent-protocol";
export type PrReviewOutcome =
  | "approved"
  | "changes-requested"
  | "pending"
  | "checks-failing"
  | "fail-gh";

export type PhaseOutcome = ScoutOutcome | VerifyReviewOutcome | CloseOutcome | PrReviewOutcome;

export type OutcomeAction =
  | { action: "advance"; to: HarnessStep; warning?: string }
  | { action: "stay"; message: string }
  | { action: "failed"; reason: string };

export class UnknownOutcomeError extends Error {
  constructor(
    readonly phase: BfhPhase,
    readonly outcome: PhaseOutcome,
  ) {
    super(`No outcome entry for ${phase}:${outcome}`);
    this.name = "UnknownOutcomeError";
  }
}

const APPLICABLE: Record<BfhPhase, readonly PhaseOutcome[]> = {
  scout: ["completed", "fail-timeout", "fail-agent-protocol"],
  verify_review: ["pass", "pass-advisory", "fail-critical", "fail-soft", "budget-exhausted", "fail-agent-protocol"],
  close: ["success", "fail-gates", "fail-gh", "fail-agent-protocol"],
  pr_review: ["approved", "changes-requested", "pending", "checks-failing", "fail-gh"],
};

const MATRIX = new Map<string, OutcomeAction>([
  ["scout:completed", { action: "advance", to: "implement" }],
  [
    "scout:fail-timeout",
    { action: "advance", to: "implement", warning: "scout timed out; proceed without full recon" },
  ],
  [
    "scout:fail-agent-protocol",
    { action: "advance", to: "implement", warning: "scout returned malformed AGENT_RESULT; proceed with caution" },
  ],

  ["verify_review:pass", { action: "advance", to: "close" }],
  [
    "verify_review:pass-advisory",
    {
      action: "stay",
      message: "review passed with advisory findings; human post_review decision required (L2/L3)",
    },
  ],
  ["verify_review:fail-critical", { action: "advance", to: "implement" }],
  ["verify_review:fail-soft", { action: "advance", to: "implement" }],
  ["verify_review:budget-exhausted", { action: "failed", reason: "revision budget exhausted with blocking review" }],
  ["verify_review:fail-agent-protocol", { action: "failed", reason: "reviewer returned malformed AGENT_RESULT" }],

  ["close:success", { action: "advance", to: "retro" }],
  ["close:fail-gates", { action: "stay", message: "close gates not satisfied" }],
  ["close:fail-gh", { action: "stay", message: "GitHub PR creation failed" }],
  ["close:fail-agent-protocol", { action: "stay", message: "closer protocol error" }],

  ["pr_review:approved", { action: "advance", to: "retro" }],
  ["pr_review:changes-requested", { action: "advance", to: "implement" }],
  ["pr_review:pending", { action: "stay", message: "GitHub PR review still pending" }],
  ["pr_review:checks-failing", { action: "stay", message: "CI checks failing on PR" }],
  ["pr_review:fail-gh", { action: "stay", message: "gh pr sync failed" }],
]);

export function applicableOutcomes(phase: BfhPhase): readonly PhaseOutcome[] {
  return APPLICABLE[phase];
}

export function resolveOutcome(phase: BfhPhase, outcome: PhaseOutcome): OutcomeAction {
  const entry = MATRIX.get(`${phase}:${outcome}`);
  if (!entry) throw new UnknownOutcomeError(phase, outcome);
  return entry;
}

export function outcomeActionToStep(state: HarnessState, resolved: OutcomeAction): HarnessStep {
  if (resolved.action === "advance") return resolved.to;
  if (resolved.action === "failed") return "failed";
  return state.currentStep;
}

export function classifyScoutOutcome(rawText: string, subagentError?: string): ScoutOutcome {
  if (subagentError && /timeout/i.test(subagentError)) return "fail-timeout";
  const parsed = parseAgentResult(rawText);
  if (!agentResultParsedOk(parsed)) return "fail-agent-protocol";
  if (parsed.status === "failed") return "fail-agent-protocol";
  return "completed";
}

export function classifyVerifyReviewOutcome(
  state: HarnessState,
  review: HarnessReview,
  parseOk: boolean,
): VerifyReviewOutcome {
  if (!parseOk || review.verdict === "failed") return "fail-agent-protocol";

  const { critical } = getReviewCounts(review);
  if (critical > 0) {
    if (state.revisionCount >= state.revisionLimit) return "budget-exhausted";
    return "fail-critical";
  }

  if (review.verdict === "approved") {
    if (!isHandsOffLevel(state) && hasAdvisoryFindings(review)) return "pass-advisory";
    return "pass";
  }

  if (review.verdict === "needs_revision") {
    if (state.revisionCount >= state.revisionLimit) return "budget-exhausted";
    return "fail-soft";
  }

  return "fail-agent-protocol";
}

export function resolveVerifyReviewTransitionFromOutcome(
  state: HarnessState,
  review: HarnessReview,
  parseOk: boolean,
): { transition: HarnessStep; outcome: VerifyReviewOutcome; action: OutcomeAction } {
  const outcome = classifyVerifyReviewOutcome(state, review, parseOk);
  let action = resolveOutcome("verify_review", outcome);

  if (outcome === "fail-critical" || outcome === "fail-soft") {
    if (state.revisionCount >= state.revisionLimit) {
      const exhausted = resolveOutcome("verify_review", "budget-exhausted");
      return { transition: "failed", outcome: "budget-exhausted", action: exhausted };
    }
  }

  const transition = outcomeActionToStep(state, action);
  return { transition, outcome, action };
}

export function classifyPrReviewOutcome(snapshot: PrReviewSnapshot, ghError?: string): PrReviewOutcome {
  if (ghError) return "fail-gh";
  if (snapshot.checksFailing > 0) return "checks-failing";
  if (snapshot.reviewDecision === "APPROVED") return "approved";
  if (snapshot.reviewDecision === "CHANGES_REQUESTED" || snapshot.reviewDecision === "COMMENTED") {
    return "changes-requested";
  }
  return "pending";
}

export function resolvePrReviewTransitionFromOutcome(
  state: HarnessState,
  snapshot: PrReviewSnapshot,
  ghError?: string,
): { transition: HarnessStep; outcome: PrReviewOutcome; action: OutcomeAction } {
  const outcome = classifyPrReviewOutcome(snapshot, ghError);
  let action = resolveOutcome("pr_review", outcome);

  if (outcome === "changes-requested") {
    const limit = state.pr.externalRevisionLimit ?? 2;
    const count = state.pr.externalRevisionCount ?? 0;
    if (count >= limit) {
      action = { action: "failed", reason: "external PR review revision limit exhausted" };
      return { transition: "failed", outcome, action };
    }
  }

  const transition = outcomeActionToStep(state, action);
  return { transition, outcome, action };
}

export function classifyCloseOutcome(options: {
  readinessOk: boolean;
  ghError?: string;
}): CloseOutcome {
  if (options.readinessOk) return "success";
  if (options.ghError) return "fail-gh";
  return "fail-gates";
}

/** For selftests: every applicable pair must resolve. */
export function assertOutcomeMatrixExhaustive(): void {
  for (const phase of Object.keys(APPLICABLE) as BfhPhase[]) {
    for (const outcome of applicableOutcomes(phase)) {
      resolveOutcome(phase, outcome);
    }
  }
}
