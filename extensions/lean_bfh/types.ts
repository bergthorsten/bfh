import * as path from "node:path";
import * as os from "node:os";

export type JiraAuthMode = "bearer" | "basic";

export type JiraStoredConfig = {
  JIRA_BASE_URL?: string;
  JIRA_TOKEN?: string;
  JIRA_AUTH_MODE?: JiraAuthMode;
  JIRA_EMAIL?: string;
};

export type HarnessStep =
  | "intake"
  | "scout"
  | "clarify"
  | "implement"
  | "verify_review"
  | "close"
  | "pr_review"
  | "retro"
  | "done"
  | "failed";

export type PrReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | "COMMENTED"
  | "PENDING"
  | "DISMISSED"
  | "UNKNOWN";

export type HarnessEvidence = {
  type: "test" | "manual" | "review" | "pr" | "note";
  command?: string;
  passed?: boolean;
  summary: string;
  logPath?: string;
  createdAt: string;
};

export type HarnessFinding = {
  severity: "critical" | "warning" | "info";
  category: string;
  message: string;
  file?: string;
  line?: number;
  /** e.g. `enforced/3` or golden-principle id from reviewer */
  principleRef?: string;
};

export type ReviewRubricEntry = {
  category: string;
  verdict: string;
  detail: string;
};

export type HarnessReview = {
  verdict: "pending" | "approved" | "needs_revision" | "failed";
  findings: HarnessFinding[];
  summary: string;
  counts: {
    critical: number;
    warning: number;
    info: number;
  };
  rubric?: {
    role: "reviewer";
    categories: ReviewRubricEntry[];
  };
  /** Human override: allow close_create despite critical findings (logged in evidence). */
  allowCloseDespiteCritical?: boolean;
};

export type HumanGatePreImplement = {
  required: boolean;
  status: "not_needed" | "pending" | "approved";
  comment?: string;
  requestedAt?: string;
  decidedAt?: string;
};

export type HumanGatePreClose = {
  status: "pending" | "approved" | "changes_requested";
  comment?: string;
  requestedAt?: string;
  decidedAt?: string;
};

export type HarnessState = {
  schemaVersion: 1;
  ticketKey: string;
  summary: string;
  description: string;
  linkedTickets: Array<{ key: string; type: string }>;
  labels: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  currentStep: HarnessStep;
  human: {
    /** If true, internal human checkpoints are bypassed for this run. */
    autonomous?: boolean;
    preImplement: HumanGatePreImplement;
    preClose: HumanGatePreClose;
  };
  openQuestions: Array<{ id: string; question: string; answer?: string }>;
  scout: {
    relevantFiles: Array<{ path: string; reason: string }>;
    patterns: Array<{ name: string; file?: string; description: string }>;
    commands: string[];
    constraints: string[];
    summary: string;
  };
  implementationPlan: string[];
  revisionCount: number;
  revisionLimit: number;
  evidence: HarnessEvidence[];
  review: HarnessReview;
  pr: {
    url: string | null;
    draft: boolean;
    reviewDecision?: PrReviewDecision | null;
    unresolvedThreads?: number;
    lastSyncedAt?: string | null;
    checksFailing?: number;
    externalRevisionCount?: number;
    externalRevisionLimit?: number;
    /** Human override: advance to done without GitHub PR approval. */
    allowDoneWithoutPrApproval?: boolean;
  };
  finalVerdict: "pending" | "success" | "failed";
  retroNotes: string[];
  createdAt: string;
  updatedAt: string;
};

/** Evidence payload for bfh_state (createdAt added on write). */
export type HarnessEvidenceInput = Omit<HarnessEvidence, "createdAt">;

export type HarnessOpenQuestion = HarnessState["openQuestions"][number];

/** Patch fields allowed via bfh_state patch (forbidden keys ignored). */
export type HarnessStatePatch = Partial<
  Omit<
    HarnessState,
    | "schemaVersion"
    | "ticketKey"
    | "currentStep"
    | "revisionCount"
    | "revisionLimit"
    | "createdAt"
    | "updatedAt"
  >
>;

export type JiraIssueSummary = {
  key: string;
  title: string;
  type: string;
  status: string;
  description: string;
  linkedTickets: Array<{ key: string; type: string }>;
  labels: string[];
  acceptanceCriteriaExtras?: string[];
  constraintsExtras?: string[];
};

export type ChangedRange = { startLine?: number; endLine?: number };

export type TouchedFile = {
  path: string;
  startLine?: number;
  endLine?: number;
  note?: string;
};

export type SubagentRunResult = {
  text: string;
  stopReason?: string;
  stderr: string;
  exitCode: number;
  usedSubagent: boolean;
};

/** Minimal pi session branch entry for harness state path lookup. */
export type HarnessSessionEntry = {
  type?: string;
  customType?: string;
  data?: { statePath?: string };
};

/** pi --mode json stream events (subset used by subagent runner). */
export type PiJsonContentPart =
  | { type: "text"; text: string }
  | { type: "toolCall"; name?: string };

export type PiJsonMessage = {
  role?: string;
  content?: string | PiJsonContentPart[];
  stopReason?: string;
  toolName?: string;
};

export type PiJsonEvent = {
  type?: string;
  message?: PiJsonMessage;
  toolResults?: PiJsonMessage[];
};

export type HarnessStartArgs = {
  issueKey: string;
  noJira: boolean;
  autoGo: boolean;
  autonomous: boolean;
};

export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
export const DEFAULT_JIRA_BASE_URL = "https://portal.bergfreunde.de/jira";
export const JIRA_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "jira.json");
export const HARNESS_ENTRY_TYPE = "lean_bfh_state";
export const STATE_DIR = path.join(".pi", "bfh");

export const STEP_ORDER: HarnessStep[] = [
  "intake",
  "scout",
  "clarify",
  "implement",
  "verify_review",
  "close",
  "pr_review",
  "retro",
  "done",
];

export const ALLOWED_TRANSITIONS: Record<HarnessStep, HarnessStep[]> = {
  intake: ["scout", "clarify", "failed"],
  scout: ["clarify", "implement", "failed"],
  clarify: ["implement", "scout", "failed"],
  implement: ["verify_review", "failed"],
  verify_review: ["implement", "close", "failed"],
  close: ["implement", "pr_review", "retro", "failed"],
  pr_review: ["retro", "implement", "failed"],
  retro: ["done", "failed"],
  done: [],
  failed: ["retro"],
};
