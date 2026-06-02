import * as fs from "node:fs";
import * as path from "node:path";
import { agentResultParsedOk, parseAgentResult } from "./agent-result.ts";
import { evaluateCloseReadiness } from "./close.ts";
import {
  readReviewedMarker,
  writeReviewedMarker,
  writeTestedMarker,
} from "./evidence-markers.ts";
import { normalizeReviewFromText, normalizeScoutFromText } from "./normalize.ts";
import { clearAgentPromptCache, loadAgentPrompt } from "./prompt-loader.ts";
import { createBrief, readBriefMissionSummary, briefPathFor } from "./brief.ts";
import {
  assertOutcomeMatrixExhaustive,
  classifyScoutOutcome,
  resolveOutcome,
  resolvePrReviewTransitionFromOutcome,
  resolveVerifyReviewTransitionFromOutcome,
} from "./outcome-table.ts";
import { AGENT_RESULT_END, AGENT_RESULT_START } from "./agent-result.ts";
import {
  doneBlockedReasons,
  parseGitHubPrUrl,
  readPrReviewMarker,
  writePrReviewMarker,
  type PrReviewSnapshot,
} from "./pr-sync.ts";
import { ensureHarnessReadme, ensurePrinciplesFile } from "./harness-docs.ts";
import { buildReviewResult, resolveVerifyReviewTransition } from "./review.ts";
import { runRetro } from "./retro.ts";
import { applyAdvance, assertStateShape, createState, readState, writeState } from "./state.ts";
import { mergeWorkingMemory, readWorkingMemory, updateWorkingMemory } from "./working-memory.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function runAgentResultSelfTests(lines: string[]): void {
  const scoutEnvelope = {
    status: "completed",
    summary: "Found auth module",
    findings: {
      relevantFiles: [{ path: "src/auth.ts", reason: "ticket mentions login" }],
      patterns: [{ name: "service-layer", description: "thin controllers" }],
      commands: ["pnpm test"],
      constraints: ["no new deps"],
    },
    artifacts: {
      commit: null,
      filesChanged: [],
      testsPassed: null,
      screenshotUrls: [],
      evidenceMarkers: [],
      prUrl: null,
      prNumber: null,
    },
    error: null,
  };

  const scoutRaw = `Scout notes\n<<<AGENT_RESULT\n${JSON.stringify(scoutEnvelope)}\nAGENT_RESULT>>>`;
  const scoutParsed = parseAgentResult(scoutRaw);
  assert(agentResultParsedOk(scoutParsed), "scout AGENT_RESULT should parse");
  const scoutNorm = normalizeScoutFromText(scoutRaw);
  assert(scoutNorm.relevantFiles[0]?.path === "src/auth.ts", "scout normalization should map relevantFiles");
  lines.push("✓ AGENT_RESULT scout parse + normalize");

  const reviewEnvelope = {
    status: "blocked",
    summary: "Critical finding in diff",
    rubric: {
      role: "reviewer",
      categories: [{ category: "scope-discipline", verdict: "fail", detail: "unrelated file changed" }],
    },
    findings: {
      critical: 1,
      warnings: 0,
      info: 0,
      details: [
        {
          severity: "critical",
          category: "scope-discipline",
          message: "Unrelated churn in package.json",
          file: "package.json",
          line: 1,
        },
      ],
    },
    artifacts: {
      commit: null,
      filesChanged: [],
      testsPassed: null,
      screenshotUrls: [],
      evidenceMarkers: [],
      prUrl: null,
      prNumber: null,
    },
    error: null,
  };

  const reviewRaw = `<<<AGENT_RESULT\n${JSON.stringify(reviewEnvelope)}\nAGENT_RESULT>>>`;
  const reviewNorm = normalizeReviewFromText(reviewRaw);
  assert(reviewNorm.verdict === "needs_revision", "blocked review should need revision");
  assert(reviewNorm.findings.some((f) => f.severity === "critical"), "review should include critical finding");
  lines.push("✓ AGENT_RESULT reviewer parse + normalize (blocked)");

  const malformed = parseAgentResult("no delimiter here");
  assert(!agentResultParsedOk(malformed), "malformed output should set parseError");
  lines.push("✓ AGENT_RESULT malformed output fails parse cleanly");

  clearAgentPromptCache();
  for (const agent of ["scout", "reviewer", "closer"] as const) {
    const prompt = loadAgentPrompt(agent);
    assert(prompt.includes("AGENT_RESULT"), `${agent} prompt should require AGENT_RESULT block`);
    assert(prompt.length > 200, `${agent} prompt should have substantive body`);
  }
  lines.push("✓ agents/scout.md, reviewer.md, closer.md load from package");
}

function makeReviewReadyState(): ReturnType<typeof createState> {
  const state = createState({
    key: "PC-103",
    title: "H3 transition test",
    type: "task",
    status: "todo",
    description: "",
    linkedTickets: [],
    labels: [],
  });
  applyAdvance(state, "scout");
  applyAdvance(state, "implement");
  applyAdvance(state, "verify_review");
  state.evidence.push({
    type: "test",
    passed: true,
    summary: "unit tests passed",
    createdAt: new Date().toISOString(),
  });
  return state;
}

function seedCloseMarkers(cwd: string, statePath: string, state: ReturnType<typeof createState>): void {
  writeTestedMarker(statePath, state, {
    outputContent: "PASS 12 tests\n",
    command: "bun test",
    passed: true,
    writtenBy: "selftest",
  });
  writeState(statePath, state);
  writeReviewedMarker(statePath, state, "selftest");
}

function runH3SelfTests(cwd: string, lines: string[]): void {
  const statePath = path.join(cwd, ".pi", "bfh", "PC-103.state.json");

  const warningOnly = makeReviewReadyState();
  warningOnly.ticketKey = "PC-103";
  warningOnly.review = buildReviewResult({
    verdict: "approved",
    findings: [
      {
        severity: "warning",
        category: "test-sufficiency",
        message: "Consider adding a regression test",
        principleRef: "advisory/coverage",
      },
    ],
    summary: "Approved with advisory findings.",
    rubric: {
      role: "reviewer",
      categories: [{ category: "test-sufficiency", verdict: "fail", detail: "no new test file" }],
    },
  });
  const warnTransition = resolveVerifyReviewTransition(warningOnly, warningOnly.review);
  assert(warnTransition === "close", "warning-only -> close");
  applyAdvance(warningOnly, warnTransition);
  warningOnly.evidence.push({
    type: "review",
    passed: true,
    summary: "review passed with warnings",
    createdAt: new Date().toISOString(),
  });
  writeState(statePath, warningOnly);
  seedCloseMarkers(cwd, statePath, warningOnly);
  const warnClose = evaluateCloseReadiness(cwd, statePath, warningOnly);
  assert(warnClose.ok, `warning-only should pass close_check: ${warnClose.reasons.join("; ")}`);
  lines.push("✓ H3: warning/info-only review advances to close and passes close_check");

  const critical = makeReviewReadyState();
  critical.ticketKey = "PC-103";
  critical.review = buildReviewResult({
    verdict: "needs_revision",
    findings: [
      {
        severity: "critical",
        category: "scope-discipline",
        message: "Unrelated package.json change",
        file: "package.json",
        line: 1,
        principleRef: "enforced/scope",
      },
    ],
    summary: "Blocking issues found.",
  });
  assert(resolveVerifyReviewTransition(critical, critical.review) === "implement", "critical -> implement");
  const critState = { ...critical, currentStep: "close" as const, review: { ...critical.review, verdict: "approved" as const } };
  writeState(statePath, critState);
  seedCloseMarkers(cwd, statePath, critState);
  const reviewed = readReviewedMarker(statePath);
  if (reviewed) {
    reviewed.critical = 1;
    fs.writeFileSync(
      path.join(cwd, ".pi", "bfh", "PC-103", "reviewed.json"),
      `${JSON.stringify(reviewed, null, 2)}\n`,
    );
  }
  const critClose = evaluateCloseReadiness(cwd, statePath, critState);
  assert(!critClose.ok, "critical in reviewed.json should block close_check");
  lines.push("✓ H3: critical findings block close_check");

  const override = makeReviewReadyState();
  override.ticketKey = "PC-103";
  override.currentStep = "close";
  override.review = buildReviewResult({
    verdict: "approved",
    findings: [
      {
        severity: "critical",
        category: "review",
        message: "Human accepted risk",
        principleRef: "enforced/1",
      },
    ],
    summary: "Override path.",
  });
  override.review.allowCloseDespiteCritical = true;
  override.evidence.push({
    type: "review",
    passed: true,
    summary: "review with human override",
    createdAt: new Date().toISOString(),
  });
  writeState(statePath, override);
  seedCloseMarkers(cwd, statePath, override);
  const reviewedOverride = readReviewedMarker(statePath);
  if (reviewedOverride) {
    reviewedOverride.critical = 1;
    fs.writeFileSync(
      path.join(cwd, ".pi", "bfh", "PC-103", "reviewed.json"),
      `${JSON.stringify(reviewedOverride, null, 2)}\n`,
    );
  }
  const overrideClose = evaluateCloseReadiness(cwd, statePath, override);
  assert(overrideClose.ok, `override should allow close: ${overrideClose.reasons.join("; ")}`);
  lines.push("✓ H3: allowCloseDespiteCritical permits close despite critical findings");
}

function runH4SelfTests(cwd: string, lines: string[]): void {
  const statePath = path.join(cwd, ".pi", "bfh", "PC-104.state.json");
  const state = makeReviewReadyState();
  state.ticketKey = "PC-104";
  applyAdvance(state, "close");
  state.review = buildReviewResult({
    verdict: "approved",
    findings: [],
    summary: "Clean review.",
  });
  state.evidence.push({
    type: "review",
    passed: true,
    summary: "approved",
    createdAt: new Date().toISOString(),
  });
  writeState(statePath, state);

  const withoutMarkers = evaluateCloseReadiness(cwd, statePath, state);
  assert(!withoutMarkers.ok, "close without markers should be blocked");
  assert(
    withoutMarkers.reasons.some((r) => r.includes("tested.json")),
    "should mention tested.json",
  );
  lines.push("✓ H4: missing tested.json blocks close_check");

  seedCloseMarkers(cwd, statePath, state);
  const withMarkers = evaluateCloseReadiness(cwd, statePath, state);
  assert(withMarkers.ok, `close with markers should pass: ${withMarkers.reasons.join("; ")}`);
  lines.push("✓ H4: tested.json + reviewed.json satisfy close_check");

  const tampered = readState(statePath);
  tampered.review = buildReviewResult({ verdict: "approved", findings: [], summary: "Tampered state only." });
  writeState(statePath, tampered);
  const stale = evaluateCloseReadiness(cwd, statePath, tampered);
  assert(!stale.ok, "patching state.review without refreshing reviewed.json should block close");
  assert(
    stale.reasons.some((r) => r.includes("stale") || r.includes("do not match")),
    "should detect stale or mismatched reviewed.json",
  );
  lines.push("✓ H4: state.review patch alone cannot bypass reviewed.json");
}

function runH5SelfTests(cwd: string, lines: string[]): void {
  const statePath = path.join(cwd, ".pi", "bfh", "PC-105.state.json");
  const state = createState({
    key: "PC-105",
    title: "Brief test",
    type: "task",
    status: "todo",
    description: "",
    linkedTickets: [],
    labels: [],
    acceptanceCriteriaExtras: ["Ship feature X"],
  });
  writeState(statePath, state);
  createBrief(statePath, state, cwd);
  assert(fs.existsSync(briefPathFor(statePath)), "brief.md should exist");
  const mission = readBriefMissionSummary(statePath);
  assert(mission?.includes("PC-105"), "mission block should include ticket");
  lines.push("✓ H5: brief.md created with mission summary");
}

function runH6SelfTests(lines: string[]): void {
  assertOutcomeMatrixExhaustive();
  const state = makeReviewReadyState();
  state.revisionCount = 0;
  const approved = buildReviewResult({ verdict: "approved", findings: [], summary: "ok" });
  const pass = resolveVerifyReviewTransitionFromOutcome(state, approved, true);
  assert(pass.transition === "close" && pass.outcome === "pass", "approved -> close");
  const critical = buildReviewResult({
    verdict: "needs_revision",
    findings: [{ severity: "critical", category: "bug", message: "blocker" }],
    summary: "fix",
  });
  const crit = resolveVerifyReviewTransitionFromOutcome(state, critical, true);
  assert(crit.transition === "implement" && crit.outcome === "fail-critical", "critical -> implement");
  resolveOutcome("close", "fail-gates");

  const scoutFailedRaw = `${AGENT_RESULT_START}\n${JSON.stringify({
    status: "failed",
    summary: "scout agent error",
    artifacts: {},
    error: "boom",
  })}\n${AGENT_RESULT_END}`;
  assert(classifyScoutOutcome(scoutFailedRaw) === "fail-agent-protocol", "scout status failed -> fail-agent-protocol");

  lines.push("✓ H6: outcome table resolves scout/verify/close pairs");
}

function runM2SelfTests(cwd: string, lines: string[]): void {
  const statePath = path.join(cwd, ".pi", "bfh", "PC-106.state.json");
  const state = createState({
    key: "PC-106",
    title: "Memory test",
    type: "task",
    status: "todo",
    description: "",
    linkedTickets: [],
    labels: [],
  });
  writeState(statePath, state);
  updateWorkingMemory(statePath, { failedApproaches: ["tried foo", "tried foo"] });
  const merged = mergeWorkingMemory(readWorkingMemory(statePath)!, { failedApproaches: ["tried bar"] });
  assert(merged.failedApproaches.length === 2, "dedupe failed approaches");
  lines.push("✓ M2: working-memory merge dedupes failedApproaches");
}

function runM3SelfTests(cwd: string, lines: string[]): void {
  const statePath = path.join(cwd, ".pi", "bfh", "PC-107.state.json");
  const state = createState({
    key: "PC-107",
    title: "Retro test",
    type: "task",
    status: "todo",
    description: "",
    linkedTickets: [],
    labels: [],
  });
  writeState(statePath, state);
  const result = runRetro(cwd, statePath, state, {
    learning: "Selftest retro bullet",
    amendmentSummary: "Consider stricter scout timeout",
  });
  assert(result.appendedLearning, "should append learning");
  assert(result.createdAmendment && result.amendmentPath, "should stage amendment");
  const learnings = fs.readFileSync(path.join(cwd, "LEARNINGS.md"), "utf8");
  assert(learnings.includes("Selftest retro bullet"), "LEARNINGS.md should contain bullet");
  lines.push("✓ M3: retro_run appends LEARNINGS and stages amendment");
}

function runPrReviewSelfTests(cwd: string, lines: string[]): void {
  const parsed = parseGitHubPrUrl("https://github.com/acme/shop/pull/42");
  assert(parsed?.owner === "acme" && parsed.number === 42, "parse GitHub PR URL");

  const statePath = path.join(cwd, ".pi", "bfh", "PC-108.state.json");
  const state = createState({
    key: "PC-108",
    title: "PR review gate",
    type: "task",
    status: "todo",
    description: "",
    linkedTickets: [],
    labels: [],
  });
  state.pr.url = "https://github.com/acme/shop/pull/42";
  applyAdvance(state, "scout");
  applyAdvance(state, "implement");
  applyAdvance(state, "verify_review");
  applyAdvance(state, "close");
  applyAdvance(state, "pr_review");
  writeState(statePath, state);

  const snapshot: PrReviewSnapshot = {
    prUrl: state.pr.url!,
    prNumber: 42,
    state: "OPEN",
    isDraft: true,
    reviewDecision: "CHANGES_REQUESTED",
    unresolvedThreads: 2,
    reviewCommentCount: 2,
    checksPending: 0,
    checksFailing: 0,
    threads: [{ path: "src/a.ts", line: 10, body: "Please fix" }],
    syncedAt: new Date().toISOString(),
  };
  writePrReviewMarker(statePath, state, snapshot);
  state.pr.reviewDecision = "CHANGES_REQUESTED";
  assert(doneBlockedReasons(state, readPrReviewMarker(statePath)).length > 0, "done blocked without approval");

  const approved = { ...snapshot, reviewDecision: "APPROVED" as const };
  writePrReviewMarker(statePath, state, approved);
  state.pr.reviewDecision = "APPROVED";
  state.pr.allowDoneWithoutPrApproval = false;
  assert(doneBlockedReasons(state, readPrReviewMarker(statePath)).length === 0, "done allowed when approved");

  const { transition, outcome } = resolvePrReviewTransitionFromOutcome(state, approved);
  assert(outcome === "approved" && transition === "retro", "approved PR → retro");

  const changes = { ...snapshot, reviewDecision: "CHANGES_REQUESTED" as const };
  const back = resolvePrReviewTransitionFromOutcome(state, changes);
  assert(back.outcome === "changes-requested" && back.transition === "implement", "changes → implement");

  resolveOutcome("pr_review", "pending");
  lines.push("✓ PR review: gh sync outcomes, done gate, pr-review.json");
}

function runDocsSelfTests(cwd: string, lines: string[]): void {
  ensurePrinciplesFile(cwd);
  ensureHarnessReadme(cwd);
  assert(fs.existsSync(path.join(cwd, ".pi", "bfh", "principles.md")), "principles.md");
  assert(fs.existsSync(path.join(cwd, ".pi", "bfh", "README.md")), "harness README");
  lines.push("✓ M4/M5: principles.md and .pi/bfh/README.md ensured");
}

export function runHarnessSelfTest(cwd: string): string {
  const lines: string[] = [];
  const sample = createState({
    key: "POC-1",
    title: "Self-test harness state",
    type: "task",
    status: "todo",
    description: "Acceptance criteria:\n- state transitions are guarded",
    linkedTickets: [],
    labels: [],
  });

  assertStateShape(sample);
  lines.push("✓ createState produces a valid state shape");

  applyAdvance(sample, "scout");
  applyAdvance(sample, "implement");
  applyAdvance(sample, "verify_review");
  applyAdvance(sample, "implement");
  lines.push("✓ verify_review -> implement increments revisionCount (1)");

  applyAdvance(sample, "verify_review");
  applyAdvance(sample, "implement");
  lines.push("✓ second repair loop allowed (2/2)");

  applyAdvance(sample, "verify_review");
  let blocked = false;
  try {
    applyAdvance(sample, "implement");
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error("Expected revision cap to block a third verify_review -> implement transition.");
  lines.push("✓ third repair loop correctly blocked by revision limit");

  const tmpPath = path.join(cwd, ".pi", "bfh", "POC-SELFTEST.state.json");
  writeState(tmpPath, sample);
  const loaded = readState(tmpPath);
  assertStateShape(loaded);
  lines.push("✓ state read/write path preserves a valid shape");

  runAgentResultSelfTests(lines);
  runH3SelfTests(cwd, lines);
  runH4SelfTests(cwd, lines);
  runH5SelfTests(cwd, lines);
  runH6SelfTests(lines);
  runM2SelfTests(cwd, lines);
  runM3SelfTests(cwd, lines);
  runPrReviewSelfTests(cwd, lines);
  runDocsSelfTests(cwd, lines);

  const warnOnly = makeReviewReadyState();
  assert(
    resolveVerifyReviewTransition(warnOnly, warnOnly.review) ===
      resolveVerifyReviewTransitionFromOutcome(warnOnly, warnOnly.review, true).transition,
    "review transition matches outcome table",
  );

  return ["Lean BFH self-test passed.", ...lines, `State fixture: ${tmpPath}`].join("\n");
}
