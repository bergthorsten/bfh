import { isHandsOffLevel } from "./difficulty.ts";
import type { HarnessFinding, HarnessState, HarnessStep } from "./types.ts";
import type { ReviewerRubric } from "./agent-result.ts";
import { resolveVerifyReviewTransitionFromOutcome } from "./outcome-table.ts";

export type ReviewFindingCounts = {
  critical: number;
  warning: number;
  info: number;
};

export type HarnessReview = HarnessState["review"];

export function countFindingSeverities(findings: HarnessFinding[]): ReviewFindingCounts {
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const f of findings) {
    if (f.severity === "critical") critical += 1;
    else if (f.severity === "warning") warning += 1;
    else if (f.severity === "info") info += 1;
  }
  return { critical, warning, info };
}

export function getReviewCounts(review: HarnessReview): ReviewFindingCounts {
  if (review.counts) return review.counts;
  return countFindingSeverities(review.findings);
}

export function hasCriticalFindings(review: HarnessReview): boolean {
  return getReviewCounts(review).critical > 0;
}

export function hasAdvisoryFindings(review: HarnessReview): boolean {
  const counts = getReviewCounts(review);
  return counts.warning > 0 || counts.info > 0;
}

export function requiresPostReviewHumanGate(state: HarnessState, review: HarnessReview): boolean {
  if (isHandsOffLevel(state)) return false;
  if (hasCriticalFindings(review)) return false;
  return review.verdict === "approved" && hasAdvisoryFindings(review);
}

export function formatAdvisoryFindingsList(review: HarnessReview): string {
  const advisories = review.findings.filter((f) => f.severity === "warning" || f.severity === "info");
  if (!advisories.length) return "(no advisory findings listed)";
  return advisories
    .map((f) => {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      return `- ${f.severity}/${f.category}: ${f.message}${loc}`;
    })
    .join("\n");
}

export function openPostReviewGate(state: HarnessState, review: HarnessReview): void {
  const now = new Date().toISOString();
  state.human.postReview = {
    status: "pending",
    requestedAt: now,
    comment: `Advisory findings (${formatReviewCountsLine(review)}). Human decision required before close.`,
  };
}

export function ensureReviewShape(review: HarnessReview): HarnessReview {
  const counts = review.counts ?? countFindingSeverities(review.findings);
  return { ...review, counts };
}

export function buildReviewResult(options: {
  verdict: HarnessReview["verdict"];
  findings: HarnessFinding[];
  summary: string;
  rubric?: ReviewerRubric;
}): HarnessReview {
  const counts = countFindingSeverities(options.findings);
  return {
    verdict: options.verdict,
    findings: options.findings,
    summary: options.summary,
    counts,
    rubric: options.rubric,
  };
}

/**
 * After verify_review: critical → implement if budget; clean pass → close;
 * advisories at L2/L3 → stay for human post_review gate; L1 advisories → close.
 */
export function resolveVerifyReviewTransition(
  state: HarnessState,
  review: HarnessReview,
  parseOk = true,
): HarnessStep {
  return resolveVerifyReviewTransitionFromOutcome(state, review, parseOk).transition;
}

export function closeBlockedByCriticalFindings(state: HarnessState): boolean {
  if (state.review.allowCloseDespiteCritical) return false;
  return hasCriticalFindings(state.review);
}

export function formatReviewCountsLine(review: HarnessReview): string {
  const c = getReviewCounts(review);
  return `${c.critical} critical, ${c.warning} warning, ${c.info} info`;
}
