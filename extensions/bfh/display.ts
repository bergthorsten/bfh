import { designReviewStatusLabel } from "./difficulty.ts";
import { formatMetricsSummary, readMetrics } from "./metrics.ts";
import { formatReviewCountsLine } from "./review.ts";
import type { HarnessState } from "./types.ts";

export function stateToolText(statePath: string, state: HarnessState): string {
  return [
    `State: ${statePath}`,
    `Step: ${state.currentStep}`,
    `Branch: ${state.git.branch} (base ${state.git.baseBranch})`,
    `Difficulty: ${state.difficulty}`,
    `Revision: ${state.revisionCount}/${state.revisionLimit}`,
    `Review: ${state.review.verdict} (${formatReviewCountsLine(state.review)})`,
    `Design: ${designReviewStatusLabel(state)}`,
    `Human: pre-implement=${state.human.preImplement.status}${state.human.preImplement.required ? " (required)" : ""}, pre-close=${state.human.preClose.status}`,
    `Evidence: ${state.evidence.length}`,
    `PR: ${state.pr.url || "(none)"}${state.pr.reviewDecision ? ` [${state.pr.reviewDecision}]` : ""}${typeof state.pr.checksFailing === "number" || typeof state.pr.checksPending === "number" ? ` checks=${state.pr.checksFailing ?? 0} failing/${state.pr.checksPending ?? 0} pending` : ""}`,
    `Verdict: ${state.finalVerdict}`,
  ].join("\n");
}

export function renderStatus(statePath: string, state: HarnessState): string {
  const latestEvidence = state.evidence.slice(-5).map((item) => {
    const passed = typeof item.passed === "boolean" ? ` passed=${item.passed}` : "";
    const command = item.command ? ` command=${item.command}` : "";
    return `- ${item.type}${passed}${command}: ${item.summary}`;
  });

  const metrics = readMetrics(statePath);
  const metricsLine = metrics ? formatMetricsSummary(metrics) : undefined;

  return [
    `# ${state.ticketKey} — ${state.summary || "BFH task"}`,
    "",
    stateToolText(statePath, state),
    ...(metricsLine ? ["", metricsLine] : []),
    "",
    "## Acceptance criteria",
    ...(state.acceptanceCriteria.length
      ? state.acceptanceCriteria.map((item) => `- ${item}`)
      : ["- (none recorded)"]),
    "",
    "## Open questions",
    ...(state.openQuestions.length
      ? state.openQuestions.map((q) => `- ${q.id}: ${q.question}${q.answer ? ` → ${q.answer}` : ""}`)
      : ["- (none)"]),
    "",
    "## Review",
    state.review.summary || "(no review summary)",
    `Counts: ${formatReviewCountsLine(state.review)}`,
    ...(state.review.rubric?.categories?.length
      ? [
          "",
          "### Rubric",
          ...state.review.rubric.categories.map((c) => `- ${c.category}: ${c.verdict} — ${c.detail}`),
        ]
      : []),
    ...(state.review.findings.length
      ? [
          "",
          "### Findings",
          ...state.review.findings.map((f) => {
            const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
            const ref = f.principleRef ? ` [${f.principleRef}]` : "";
            return `- ${f.severity}/${f.category}${ref}: ${f.message}${loc}`;
          }),
        ]
      : []),
    "",
    "## Latest evidence",
    ...(latestEvidence.length ? latestEvidence : ["- (none)"]),
  ].join("\n");
}
