import { execFileSync } from "node:child_process";
import { resolveHarnessBaseBranch } from "./git-prep.ts";
import { readBriefExcerpt } from "./brief.ts";
import { validateEvidenceMarkersForClose } from "./evidence-markers.ts";
import { classifyCloseOutcome, resolveOutcome } from "./outcome-table.ts";
import { closeBlockedByCriticalFindings, formatReviewCountsLine, getReviewCounts } from "./review.ts";
import { recordCloseAttempt } from "./metrics.ts";
import { applyAdvance } from "./state.ts";
import type { HarnessState } from "./types.ts";

function formatExecError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const anyError = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
  const stderr = Buffer.isBuffer(anyError.stderr) ? anyError.stderr.toString("utf8") : (anyError.stderr ?? "");
  const stdout = Buffer.isBuffer(anyError.stdout) ? anyError.stdout.toString("utf8") : (anyError.stdout ?? "");
  return [stderr.trim(), stdout.trim(), anyError.message].filter(Boolean).join("\n");
}

function runCommand(cwd: string, command: string, args: string[], step: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`${step} failed: ${formatExecError(error)}`);
  }
}

export function resolveBaseBranch(cwd: string, explicit?: string, state?: HarnessState): string {
  if (explicit?.trim()) return explicit.trim();
  if (state?.git?.baseBranch) return state.git.baseBranch;
  return resolveHarnessBaseBranch(cwd);
}

export function assertCleanWorkingTree(cwd: string): void {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
  if (status) {
    const preview = status.split(/\r?\n/).slice(0, 12).join("\n");
    throw new Error(
      `Working tree is not clean. Commit or stash changes before close_create.\n${preview}${status.split(/\r?\n/).length > 12 ? "\n…" : ""}`,
    );
  }
}


function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/\S+/);
  return match?.[0]?.replace(/[)>.,;]+$/, "");
}

function createDefaultPrTitle(state: HarnessState): string {
  const summary = state.summary?.trim() || state.ticketKey;
  return `${state.ticketKey}: ${summary}`;
}

export function evaluateCloseReadiness(
  cwd: string,
  statePath: string,
  state: HarnessState,
): { ok: boolean; reasons: string[]; prBody: string } {
  const reasons: string[] = [];
  const passedTests = state.evidence.some((e) => e.type === "test" && e.passed !== false);
  const reviewEvidence = state.evidence.some((e) => e.type === "review" && e.passed !== false);
  const counts = getReviewCounts(state.review);

  if (state.currentStep !== "close") reasons.push(`currentStep is ${state.currentStep}, expected close`);
  if (state.review.verdict !== "approved") reasons.push(`review verdict is ${state.review.verdict}, expected approved`);
  if (state.difficulty !== 1 && state.human.preClose.status !== "approved") {
    reasons.push("human pre-close approval missing (set via bfh_state action human_gate)");
  }
  if (closeBlockedByCriticalFindings(state)) {
    reasons.push(
      `${counts.critical} critical review finding(s) remain (set review.allowCloseDespiteCritical to override)`,
    );
  }
  if (!passedTests) reasons.push("no passing test evidence recorded");
  if (!reviewEvidence && state.review.verdict === "approved") reasons.push("no review evidence item recorded");

  reasons.push(...validateEvidenceMarkersForClose(cwd, statePath, state));

  const tested = state.evidence
    .filter((e) => e.type === "test" || e.type === "manual" || e.type === "review")
    .map((e) => `- ${e.type}: ${e.summary}${e.command ? ` (${e.command})` : ""}`);

  const risks = state.review.findings
    .filter((f) => f.severity !== "critical")
    .map((f) => {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      const ref = f.principleRef ? ` [${f.principleRef}]` : "";
      return `- ${f.severity}/${f.category}${ref}: ${f.message}${loc}`;
    });

  const rubricLines =
    state.review.rubric?.categories?.map((c) => `- ${c.category}: ${c.verdict} — ${c.detail}`) ?? [];

  const briefExcerpt = readBriefExcerpt(statePath, 1200);

  const prBody = [
    "## Summary",
    state.summary || `Work for ${state.ticketKey}`,
    ...(briefExcerpt ? ["", "### Mission / progress (from brief)", briefExcerpt] : []),
    "",
    "## Acceptance criteria",
    ...(state.acceptanceCriteria.length ? state.acceptanceCriteria.map((item) => `- ${item}`) : ["- See Jira ticket"]),
    "",
    "## What was verified",
    ...(tested.length ? tested : ["- Verification evidence missing"]),
    "",
    "## Review",
    `Findings: ${formatReviewCountsLine(state.review)}`,
    "",
    "## Human checkpoints",
    `- difficulty: level ${state.difficulty}`,
    `- pre-implement: ${state.human.preImplement.status}${state.human.preImplement.comment ? ` — ${state.human.preImplement.comment}` : ""}`,
    `- pre-close: ${state.human.preClose.status}${state.human.preClose.comment ? ` — ${state.human.preClose.comment}` : ""}`,
    ...(rubricLines.length ? ["", "### Rubric", ...rubricLines] : []),
    "",
    "## Remaining risk",
    ...(risks.length ? risks : ["- None identified"]),
    "",
    "## Jira",
    state.ticketKey,
  ].join("\n");

  return { ok: reasons.length === 0, reasons, prBody };
}

export type CloseCreateOptions = {
  prTitle?: string;
  prBody?: string;
  baseBranch?: string;
  headBranch?: string;
  pushBranch?: boolean;
  autoAdvanceRetro?: boolean;
  /** When auto-advancing after PR create, go to pr_review (default) or retro if skipPrReview. */
  skipPrReview?: boolean;
  dryRun?: boolean;
  /** Require `git status --porcelain` empty before push (default true). */
  requireCleanTree?: boolean;
};

export function executeCloseCreate(
  cwd: string,
  statePath: string,
  state: HarnessState,
  options: CloseCreateOptions,
): {
  ok: boolean;
  created: boolean;
  prUrl?: string;
  baseBranch?: string;
  headBranch?: string;
  prTitle: string;
  prBody: string;
  reasons?: string[];
  dryRun?: boolean;
} {
  const readiness = evaluateCloseReadiness(cwd, statePath, state);
  const prTitle = options.prTitle?.trim() || createDefaultPrTitle(state);
  const prBody = options.prBody ?? readiness.prBody;
  const autoAdvanceRetro = options.autoAdvanceRetro !== false;

  if (!readiness.ok) {
    const outcome = classifyCloseOutcome({ readinessOk: false });
    resolveOutcome("close", outcome);
    recordCloseAttempt(statePath, state, false, readiness.reasons);
    return {
      ok: false,
      created: false,
      reasons: readiness.reasons,
      prTitle,
      prBody,
    };
  }

  const baseBranch = resolveBaseBranch(cwd, options.baseBranch, state);
  const headBranch =
    options.headBranch?.trim() ||
    state.git?.branch ||
    runCommand(cwd, "git", ["rev-parse", "--abbrev-ref", "HEAD"], "Detect current branch");
  const pushBranch = options.pushBranch !== false;

  if (options.dryRun) {
    recordCloseAttempt(statePath, state, true);
    return {
      ok: true,
      created: false,
      baseBranch,
      headBranch,
      prTitle,
      prBody,
      dryRun: true,
    };
  }

  runCommand(cwd, "git", ["rev-parse", "--is-inside-work-tree"], "Verify git repository");
  if (options.requireCleanTree !== false) {
    assertCleanWorkingTree(cwd);
  }
  if (pushBranch) {
    runCommand(cwd, "git", ["push", "-u", "origin", headBranch], `Push branch ${headBranch}`);
  }

  const createArgs = [
    "pr",
    "create",
    "--draft",
    "--title",
    prTitle,
    "--body",
    prBody,
    "--base",
    baseBranch,
    "--head",
    headBranch,
  ];

  let createOutput = "";
  let created = true;
  try {
    createOutput = runCommand(cwd, "gh", createArgs, "Create draft PR");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const existingUrl = extractFirstUrl(message);
    if (/already exists/i.test(message) && existingUrl) {
      createOutput = existingUrl;
      created = false;
    } else {
      classifyCloseOutcome({ readinessOk: true, ghError: message });
      resolveOutcome("close", "fail-gh");
      throw error;
    }
  }

  resolveOutcome("close", "success");

  const prUrl = extractFirstUrl(createOutput);
  if (!prUrl) {
    throw new Error(`Draft PR creation did not return a PR URL. Output: ${createOutput || "(empty)"}`);
  }

  state.pr.url = prUrl;
  state.pr.draft = true;
  state.evidence.push({
    type: "pr",
    passed: true,
    command: "gh pr create --draft",
    summary: created ? `Draft PR created: ${prUrl}` : `Draft PR already exists: ${prUrl}`,
    createdAt: new Date().toISOString(),
  });

  if (autoAdvanceRetro !== false && state.currentStep === "close") {
    applyAdvance(state, options.skipPrReview ? "retro" : "pr_review", statePath);
  }

  recordCloseAttempt(statePath, state, true);
  return {
    ok: true,
    created,
    prUrl,
    baseBranch,
    headBranch,
    prTitle,
    prBody,
  };
}
