import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALLOWED_TRANSITIONS,
  HARNESS_ENTRY_TYPE,
  ISSUE_KEY_PATTERN,
  STATE_DIR,
  STEP_ORDER,
  type HarnessSessionEntry,
  type HarnessState,
  type HarnessStatePatch,
  type CreateStateOptions,
  type DifficultyLevel,
  type HarnessStep,
  type GitEntryMode,
  type HarnessGitState,
  type HumanGatePreClose,
  type HumanGatePreImplement,
  type JiraIssueSummary,
} from "./types.ts";
import { normalizeIssueKey } from "./args.ts";
import { loadBfhConfig, resolveImplementModelHint } from "./bfh-config.ts";
import { DEFAULT_BASE_BRANCH, deriveBranchName, resolveHarnessBaseBranch } from "./git-prep.ts";
import {
  applyHandsOffHumanBypass,
  createInitialDesignReview,
  DEFAULT_DIFFICULTY,
  designReviewBlocksImplement,
  isHandsOffLevel,
  requiresMandatoryDesignReview,
} from "./difficulty.ts";
import { ensureDesignReviewShape } from "./design-review.ts";
import { recordHarnessTransition } from "./metrics.ts";
import { doneBlockedReasons, readPrReviewMarker } from "./pr-sync.ts";
import { ensureReviewShape } from "./review.ts";

function extractAcceptanceCriteria(description: string): string[] {
  const lines = description.split(/\r?\n|(?=\s*[-*]\s+)/).map((line) => line.trim()).filter(Boolean);
  const criteria: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/acceptance|akzeptanz|done when|done-when|definition of done/.test(lower)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,6}\s|^[A-Z][A-Za-z ]+:$/.test(line) && criteria.length > 0) break;
    if (inSection || /^[-*]\s+\[[ xX]\]/.test(line)) {
      const cleaned = line.replace(/^[-*]\s+(\[[ xX]\]\s*)?/, "").trim();
      if (cleaned) criteria.push(cleaned);
    }
  }

  return Array.from(new Set(criteria)).slice(0, 12);
}

function extractConstraints(description: string, labels: string[]): string[] {
  const constraints = labels
    .filter((label) => /constraint|blocked|risk|security|migration|hotfix|no-|do-not/i.test(label))
    .map((label) => `label:${label}`);

  for (const line of description.split(/\r?\n/)) {
    if (/constraint|non-goal|out of scope|must not|do not|without/i.test(line)) {
      const trimmed = line.replace(/^[-*]\s+/, "").trim();
      if (trimmed) constraints.push(trimmed);
    }
  }

  return Array.from(new Set(constraints)).slice(0, 12);
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function ensureGitShape(state: HarnessState): void {
  const fallback: HarnessGitState = {
    branch: deriveBranchName(state.ticketKey, state.summary),
    baseBranch: DEFAULT_BASE_BRANCH,
    entryMode: "resume",
  };

  const input = state.git && typeof state.git === "object" ? state.git : fallback;
  const allowedModes = new Set<HarnessGitState["entryMode"]>([
    "greenfield",
    "adopt-continue",
    "adopt-verify",
    "adopt-fix",
    "resume",
  ]);
  const entryMode = allowedModes.has(input.entryMode as HarnessGitState["entryMode"])
    ? (input.entryMode as HarnessGitState["entryMode"])
    : fallback.entryMode;

  state.git = {
    branch: typeof input.branch === "string" && input.branch.trim() ? input.branch.trim() : fallback.branch,
    baseBranch:
      typeof input.baseBranch === "string" && input.baseBranch.trim()
        ? input.baseBranch.trim()
        : fallback.baseBranch,
    entryMode,
  };
}

function ensureHumanGatePreImplement(value: unknown): HumanGatePreImplement {
  const input = value && typeof value === "object" ? (value as Partial<HumanGatePreImplement>) : {};
  const required = Boolean(input.required);
  const allowedStatus = new Set<HumanGatePreImplement["status"]>(["not_needed", "pending", "approved"]);
  const status = allowedStatus.has(input.status as HumanGatePreImplement["status"])
    ? (input.status as HumanGatePreImplement["status"])
    : (required ? "pending" : "not_needed");

  return {
    required,
    status,
    comment: typeof input.comment === "string" ? input.comment : undefined,
    requestedAt: typeof input.requestedAt === "string" ? input.requestedAt : undefined,
    decidedAt: typeof input.decidedAt === "string" ? input.decidedAt : undefined,
  };
}

function ensureHumanGatePreClose(value: unknown): HumanGatePreClose {
  const input = value && typeof value === "object" ? (value as Partial<HumanGatePreClose>) : {};
  const allowedStatus = new Set<HumanGatePreClose["status"]>(["pending", "approved", "changes_requested"]);
  const status = allowedStatus.has(input.status as HumanGatePreClose["status"])
    ? (input.status as HumanGatePreClose["status"])
    : "pending";

  return {
    status,
    comment: typeof input.comment === "string" ? input.comment : undefined,
    requestedAt: typeof input.requestedAt === "string" ? input.requestedAt : undefined,
    decidedAt: typeof input.decidedAt === "string" ? input.decidedAt : undefined,
  };
}

function ensureDifficultyShape(state: HarnessState): void {
  const level = state.difficulty;
  if (level !== 1 && level !== 2 && level !== 3) {
    state.difficulty = DEFAULT_DIFFICULTY;
  }
  state.designReview = ensureDesignReviewShape(state.designReview, state.difficulty);
  if (typeof state.implementModelHint === "string") {
    state.implementModelHint = state.implementModelHint.trim() || undefined;
  }
}

function ensureHumanShape(state: HarnessState): void {
  const human = state.human && typeof state.human === "object" ? state.human : ({} as HarnessState["human"]);
  state.human = {
    preImplement: ensureHumanGatePreImplement(human.preImplement),
    preClose: ensureHumanGatePreClose(human.preClose),
  };
}

export function assertStateShape(state: HarnessState): void {
  const requiredTopLevel: Array<keyof HarnessState> = [
    "schemaVersion",
    "ticketKey",
    "summary",
    "description",
    "linkedTickets",
    "labels",
    "acceptanceCriteria",
    "constraints",
    "currentStep",
    "difficulty",
    "git",
    "designReview",
    "openQuestions",
    "scout",
    "implementationPlan",
    "revisionCount",
    "revisionLimit",
    "evidence",
    "review",
    "pr",
    "finalVerdict",
    "retroNotes",
    "createdAt",
    "updatedAt",
  ];

  for (const key of requiredTopLevel) {
    if (!(key in state)) throw new Error(`State validation failed: missing field '${key}'.`);
  }

  if (state.schemaVersion !== 1) {
    throw new Error(`State validation failed: unsupported schemaVersion '${state.schemaVersion}'.`);
  }
  if (!ISSUE_KEY_PATTERN.test(state.ticketKey)) {
    throw new Error(`State validation failed: invalid ticketKey '${state.ticketKey}'.`);
  }
  if (!STEP_ORDER.includes(state.currentStep) && state.currentStep !== "failed") {
    throw new Error(`State validation failed: invalid currentStep '${state.currentStep}'.`);
  }
  if (state.revisionCount < 0 || state.revisionLimit < 0) {
    throw new Error("State validation failed: revisionCount/revisionLimit must be >= 0.");
  }

  ensureDifficultyShape(state);
  ensureHumanShape(state);
  ensureGitShape(state);
  if (!Array.isArray(state.evidence) || !Array.isArray(state.acceptanceCriteria)) {
    throw new Error("State validation failed: evidence and acceptanceCriteria must be arrays.");
  }

  if (!state.review || typeof state.review !== "object") {
    throw new Error("State validation failed: review is required.");
  }
  if (!Array.isArray(state.review.findings)) {
    throw new Error("State validation failed: review.findings must be an array.");
  }
  const review = ensureReviewShape(state.review);
  state.review = review;
  for (const finding of review.findings) {
    if (!["critical", "warning", "info"].includes(finding.severity)) {
      throw new Error(`State validation failed: invalid finding severity '${finding.severity}'.`);
    }
    if (!finding.category || !finding.message) {
      throw new Error("State validation failed: finding requires category and message.");
    }
  }
}

export function readState(filePath: string): HarnessState {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as HarnessState;
  assertStateShape(parsed);
  return parsed;
}

export function statePathFor(cwd: string, issueKey: string): string {
  return path.join(cwd, STATE_DIR, `${issueKey}.state.json`);
}

export function stateDirFor(cwd: string): string {
  return path.join(cwd, STATE_DIR);
}

export function listStateFiles(cwd: string): string[] {
  const dir = stateDirFor(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".state.json"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

export function resolveStatePathFromArg(cwd: string, arg: string): string | undefined {
  const trimmed = arg.trim();
  if (!trimmed) return undefined;
  if (trimmed.endsWith(".json") || trimmed.includes(path.sep)) {
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  }
  const issueKey = normalizeIssueKey(trimmed);
  if (!ISSUE_KEY_PATTERN.test(issueKey)) return undefined;
  return statePathFor(cwd, issueKey);
}

export function writeState(filePath: string, state: HarnessState): HarnessState {
  state.updatedAt = new Date().toISOString();
  assertStateShape(state);
  writeJson(filePath, state);
  return state;
}

export function configureStateForDifficulty(
  state: HarnessState,
  difficulty: DifficultyLevel,
  cwd: string,
): void {
  const workflow = loadBfhConfig(cwd).workflow;
  state.difficulty = difficulty;
  state.designReview = createInitialDesignReview(difficulty, workflow.designReviewRevisionLimit);
  state.implementModelHint = resolveImplementModelHint(cwd, difficulty);
  if (difficulty === 1) {
    applyHandsOffHumanBypass(state, "Difficulty level 1: internal human checkpoints bypassed.");
  }
}

export function createState(issue: JiraIssueSummary, options: CreateStateOptions = {}): HarnessState {
  const cwd = options.cwd ?? process.cwd();
  const workflow = loadBfhConfig(cwd).workflow;
  const difficulty = options.difficulty ?? workflow.defaultDifficulty ?? DEFAULT_DIFFICULTY;
  const now = new Date().toISOString();
  const state: HarnessState = {
    schemaVersion: 1,
    ticketKey: issue.key,
    summary: issue.title,
    description: issue.description,
    linkedTickets: issue.linkedTickets,
    labels: issue.labels,
    acceptanceCriteria: Array.from(
      new Set([
        ...extractAcceptanceCriteria(issue.description),
        ...(issue.acceptanceCriteriaExtras ?? []),
      ]),
    ).slice(0, 16),
    constraints: Array.from(
      new Set([...extractConstraints(issue.description, issue.labels), ...(issue.constraintsExtras ?? [])]),
    ).slice(0, 16),
    currentStep: "intake",
    difficulty,
    git: options.git ?? {
      branch: deriveBranchName(issue.key, issue.title),
      baseBranch: resolveHarnessBaseBranch(cwd),
      entryMode: "greenfield",
    },
    implementModelHint: resolveImplementModelHint(cwd, difficulty),
    designReview: createInitialDesignReview(difficulty, workflow.designReviewRevisionLimit),
    human: {
      preImplement: {
        required: false,
        status: "not_needed",
      },
      preClose: {
        status: "pending",
      },
    },
    openQuestions: [],
    scout: {
      relevantFiles: [],
      patterns: [],
      commands: [],
      constraints: [],
      summary: "",
    },
    implementationPlan: [],
    revisionCount: 0,
    revisionLimit: workflow.verifyRevisionLimit,
    evidence: [],
    review: {
      verdict: "pending",
      findings: [],
      summary: "",
      counts: { critical: 0, warning: 0, info: 0 },
    },
    pr: {
      url: null,
      draft: true,
      reviewDecision: null,
      unresolvedThreads: 0,
      lastSyncedAt: null,
      checksFailing: 0,
      externalRevisionCount: 0,
      externalRevisionLimit: workflow.externalPrRevisionLimit,
    },
    finalVerdict: "pending",
    retroNotes: [],
    createdAt: now,
    updatedAt: now,
  };
  if (difficulty === 1) {
    applyHandsOffHumanBypass(state, "Difficulty level 1: internal human checkpoints bypassed.");
  }
  return state;
}

/** Initial workflow step when adopting an existing branch (skips scout where appropriate). */
export function resolveAdoptInitialStep(entryMode: GitEntryMode): HarnessStep {
  switch (entryMode) {
    case "adopt-verify":
      return "verify_review";
    case "adopt-fix":
      return "implement";
    case "adopt-continue":
      return "scout";
    default:
      return "intake";
  }
}

/** Apply mechanical entry-mode shortcuts after /bfh git prep on an existing branch. */
export function applyAdoptEntryMode(state: HarnessState): void {
  const initialStep = resolveAdoptInitialStep(state.git.entryMode);
  if (initialStep === "intake") return;

  const now = new Date().toISOString();
  state.currentStep = initialStep;

  if (state.git.entryMode === "adopt-fix" && requiresMandatoryDesignReview(state)) {
    state.designReview = {
      ...state.designReview,
      status: "approved",
      humanSteering: "Adopt mode: design review skipped for existing branch refine/fix.",
      decidedAt: now,
    };
  }

  if (state.git.entryMode === "adopt-verify" || state.git.entryMode === "adopt-fix") {
    state.scout.summary =
      "Scout skipped (adopt mode). Use ticket context, git log, and diff against base branch.";
    state.evidence.push({
      type: "note",
      summary: `Scout skipped; starting at ${initialStep} for entry mode ${state.git.entryMode}.`,
      createdAt: now,
    });
    return;
  }

  if (state.git.entryMode === "adopt-continue") {
    state.scout.summary =
      "Adopt mode: scout is recon only — map existing branch work vs remaining ticket scope.";
    state.evidence.push({
      type: "note",
      summary: "Adopt continue: starting at scout for branch recon.",
      createdAt: now,
    });
  }
}

export function activeStatePathFromSession(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as HarnessSessionEntry;
    if (entry?.type === "custom" && entry?.customType === HARNESS_ENTRY_TYPE) {
      const statePath = entry?.data?.statePath;
      if (typeof statePath === "string" && statePath) return statePath;
    }
  }
  return undefined;
}

export function resolveStatePath(ctx: ExtensionContext, explicit?: string): string {
  const candidate = explicit?.trim() || activeStatePathFromSession(ctx);
  if (!candidate) {
    throw new Error("No active lean BFH state. Start with /bfh PROJ-123 or pass statePath.");
  }
  return path.isAbsolute(candidate) ? candidate : path.resolve(ctx.cwd, candidate);
}

export function assertTransition(state: HarnessState, nextStep: HarnessStep): void {
  if (!ALLOWED_TRANSITIONS[state.currentStep]?.includes(nextStep)) {
    throw new Error(`Invalid transition: ${state.currentStep} -> ${nextStep}`);
  }

  if (state.currentStep === "verify_review" && nextStep === "implement" && state.revisionCount >= state.revisionLimit) {
    throw new Error(
      `Revision limit reached (${state.revisionCount}/${state.revisionLimit}). Do not loop back to implement.`,
    );
  }

  if (state.currentStep === "close" && nextStep === "implement") {
    if (isHandsOffLevel(state)) {
      throw new Error("close -> implement is not available at difficulty level 1. Continue via PR review feedback loop.");
    }
    if (state.human.preClose.status !== "changes_requested") {
      throw new Error("close -> implement requires human pre-close decision = changes_requested.");
    }
    if (state.revisionCount >= state.revisionLimit) {
      throw new Error(
        `Revision limit reached (${state.revisionCount}/${state.revisionLimit}). Do not loop back to implement.`,
      );
    }
  }

  if ((state.currentStep === "scout" || state.currentStep === "clarify") && nextStep === "implement") {
    if (designReviewBlocksImplement(state)) {
      throw new Error(
        `Transition to implement is blocked: design review must be approved (status=${state.designReview.status}). Use bfh_state design_gate on the clarify step.`,
      );
    }
    if (!isHandsOffLevel(state) && state.human.preImplement.required && state.human.preImplement.status !== "approved") {
      throw new Error(
        "Transition to implement is blocked: human pre-implement decision required but not approved.",
      );
    }
  }

  if (state.currentStep === "pr_review" && nextStep === "implement") {
    const limit = state.pr.externalRevisionLimit ?? 2;
    const count = state.pr.externalRevisionCount ?? 0;
    if (count >= limit) {
      throw new Error(
        `External PR review revision limit reached (${count}/${limit}). Do not loop back to implement.`,
      );
    }
  }
}

export function mergeStatePatch(state: HarnessState, patch: HarnessStatePatch | null | undefined): HarnessState {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return state;

  const forbidden = new Set([
    "schemaVersion",
    "ticketKey",
    "currentStep",
    "revisionCount",
    "revisionLimit",
    "createdAt",
    "updatedAt",
  ]);
  for (const key of Object.keys(patch)) {
    if (forbidden.has(key)) continue;
    const value = patch[key];

    if (key === "scout" && value && typeof value === "object") {
      state.scout = { ...state.scout, ...value };
    } else if (key === "designReview" && value && typeof value === "object") {
      state.designReview = ensureDesignReviewShape(
        { ...state.designReview, ...value },
        state.difficulty,
      );
    } else if (key === "human" && value && typeof value === "object") {
      state.human = {
        preImplement: { ...state.human.preImplement, ...((value as HarnessState["human"]).preImplement ?? {}) },
        preClose: { ...state.human.preClose, ...((value as HarnessState["human"]).preClose ?? {}) },
      };
      ensureHumanShape(state);
    } else if (key === "review" && value && typeof value === "object") {
      state.review = ensureReviewShape({ ...state.review, ...value });
    } else if (key === "pr" && value && typeof value === "object") {
      state.pr = { ...state.pr, ...value };
    } else if (key in state) {
      Object.assign(state, { [key]: value });
    }
  }

  return state;
}

export function applyAdvance(state: HarnessState, nextStep: HarnessStep, statePath?: string): void {
  const fromStep = state.currentStep;
  assertTransition(state, nextStep);
  if (state.currentStep === "verify_review" && nextStep === "implement") {
    state.revisionCount += 1;
    state.review.verdict = "needs_revision";
  }
  if (state.currentStep === "close" && nextStep === "implement") {
    state.revisionCount += 1;
    state.review.verdict = "needs_revision";
  }
  if (state.currentStep === "pr_review" && nextStep === "implement") {
    state.pr.externalRevisionCount = (state.pr.externalRevisionCount ?? 0) + 1;
  }
  if (nextStep === "close") {
    state.human.preClose = isHandsOffLevel(state)
      ? {
          status: "approved",
          comment: "Difficulty level 1: internal pre-close human gate bypassed.",
          requestedAt: new Date().toISOString(),
          decidedAt: new Date().toISOString(),
        }
      : {
          status: "pending",
          requestedAt: new Date().toISOString(),
        };
  }
  if (nextStep === "clarify" && state.difficulty === 3 && state.designReview.status === "not_applicable") {
    state.designReview.status = "awaiting_options";
  }
  if (nextStep === "done" && statePath) {
    const marker = readPrReviewMarker(statePath);
    const blocked = doneBlockedReasons(state, marker);
    if (blocked.length) throw new Error(blocked.join("; "));
  }
  state.currentStep = nextStep;
  if (nextStep === "done") state.finalVerdict = "success";
  if (nextStep === "failed") state.finalVerdict = "failed";
  if (statePath) {
    recordHarnessTransition(statePath, state, fromStep, nextStep, { allowed: true, trigger: "advance" });
  }
}

export { STEP_ORDER };
