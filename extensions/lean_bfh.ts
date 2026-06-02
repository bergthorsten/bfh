import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";

/**
 * Lean BFH (Bergfreunde Harness) POC
 *
 * This is intentionally small: the extension owns intake, state persistence,
 * transition validation, and the kickoff prompt. Pi/the active model still does
 * the implementation work with normal tools plus existing build_questionnaire
 * and run_fresh_review tools when available.
 */

type JiraAuthMode = "bearer" | "basic";

type JiraStoredConfig = {
  JIRA_BASE_URL?: string;
  JIRA_TOKEN?: string;
  JIRA_AUTH_MODE?: JiraAuthMode;
  JIRA_EMAIL?: string;
};

type HarnessStep =
  | "intake"
  | "scout"
  | "clarify"
  | "implement"
  | "verify_review"
  | "close"
  | "retro"
  | "done"
  | "failed";

type HarnessEvidence = {
  type: "test" | "manual" | "review" | "pr" | "note";
  command?: string;
  passed?: boolean;
  summary: string;
  logPath?: string;
  createdAt: string;
};

type HarnessFinding = {
  severity: "critical" | "warning" | "info";
  category: string;
  message: string;
  file?: string;
  line?: number;
};

type HarnessState = {
  schemaVersion: 1;
  ticketKey: string;
  summary: string;
  description: string;
  linkedTickets: Array<{ key: string; type: string }>;
  labels: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  currentStep: HarnessStep;
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
  review: {
    verdict: "pending" | "approved" | "needs_revision" | "failed";
    findings: HarnessFinding[];
    summary: string;
  };
  pr: {
    url: string | null;
    draft: boolean;
  };
  finalVerdict: "pending" | "success" | "failed";
  retroNotes: string[];
  createdAt: string;
  updatedAt: string;
};

type JiraIssueSummary = {
  key: string;
  title: string;
  type: string;
  status: string;
  description: string;
  linkedTickets: Array<{ key: string; type: string }>;
  labels: string[];
};

type ChangedRange = { startLine?: number; endLine?: number };

type TouchedFile = {
  path: string;
  startLine?: number;
  endLine?: number;
  note?: string;
};

type FreshReviewSubagentResult = {
  text: string;
  stopReason?: string;
  stderr: string;
  exitCode: number;
  usedSubagent: boolean;
};

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const DEFAULT_JIRA_BASE_URL = "https://portal.bergfreunde.de/jira";
const JIRA_CONFIG_PATH = path.join(os.homedir(), ".pi", "agents", "jira.json");
const HARNESS_ENTRY_TYPE = "lean_bfh_state";
const STATE_DIR = path.join(".pi", "bfh");

const STEP_ORDER: HarnessStep[] = [
  "intake",
  "scout",
  "clarify",
  "implement",
  "verify_review",
  "close",
  "retro",
  "done",
];

const ALLOWED_TRANSITIONS: Record<HarnessStep, HarnessStep[]> = {
  intake: ["scout", "clarify", "failed"],
  scout: ["clarify", "implement", "failed"],
  clarify: ["implement", "scout", "failed"],
  implement: ["verify_review", "failed"],
  verify_review: ["implement", "close", "failed"],
  close: ["retro", "failed"],
  retro: ["done", "failed"],
  done: [],
  failed: ["retro"],
};

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

function extractAssistantText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part: any) => part?.type === "text" && typeof part?.text === "string")
    .map((part: any) => String(part.text))
    .join("\n")
    .trim();
}

function hasSubagentToolCall(message: any): boolean {
  const content = message?.content;
  return Array.isArray(content)
    && content.some((part: any) => part?.type === "toolCall" && part?.name === "subagent");
}

function buildSubagentReviewerTask(systemPrompt: string, reviewerInput: string): string {
  return [
    "You are the reviewer subagent for a lean BFH verify/review gate.",
    "Provide actionable suggestions only; do not edit files.",
    "",
    "Review contract:",
    systemPrompt,
    "",
    "Ticket + implementation context:",
    reviewerInput,
  ].join("\n");
}

function buildScoutSubagentTask(scoutInput: string): string {
  return [
    "You are the scout subagent for a lean BFH run.",
    "Your job is read-only reconnaissance only. Do not modify files.",
    "",
    "Return STRICT JSON only (no markdown) with this shape:",
    "{",
    "  \"relevantFiles\": [{ \"path\": string, \"reason\": string }],",
    "  \"patterns\": [{ \"name\": string, \"file\"?: string, \"description\": string }],",
    "  \"commands\": [string],",
    "  \"constraints\": [string],",
    "  \"summary\": string",
    "}",
    "",
    "Prioritize concise, high-signal output (max ~8 files, ~8 commands).",
    "",
    "Ticket + repository context:",
    scoutInput,
  ].join("\n");
}

function buildSubagentInvocationPrompt(agent: "reviewer" | "scout", task: string): string {
  return [
    `Use the \`subagent\` tool to run a fresh-context \`${agent}\` agent exactly once.`,
    "Do not perform the requested work directly in this parent agent.",
    `After the subagent returns, output only the ${agent} output text.`,
    "",
    "Call shape:",
    `subagent({ agent: \"${agent}\", task: <task>, context: \"fresh\", output: false, progress: false })`,
    "",
    "Task:",
    "```",
    task,
    "```",
  ].join("\n");
}

function buildSubagentOrchestrationPrompt(systemPrompt: string, reviewerInput: string): string {
  const reviewerTask = buildSubagentReviewerTask(systemPrompt, reviewerInput);
  return buildSubagentInvocationPrompt("reviewer", reviewerTask);
}

function buildScoutSubagentOrchestrationPrompt(scoutInput: string): string {
  return buildSubagentInvocationPrompt("scout", buildScoutSubagentTask(scoutInput));
}

function normalizeIssueKey(raw: string): string {
  return raw.trim().toUpperCase();
}

function parseHarnessStartArgs(raw: string): { issueKey: string; noJira: boolean } {
  const tokens = raw.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  const noJira = tokens.includes("--no-jira") || tokens.includes("-n");
  const issueToken = tokens.find((t) => !t.startsWith("-")) || "";
  return { issueKey: normalizeIssueKey(issueToken), noJira };
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function readJiraConfigFile(): JiraStoredConfig {
  try {
    if (!fs.existsSync(JIRA_CONFIG_PATH)) return {};
    const raw = fs.readFileSync(JIRA_CONFIG_PATH, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as JiraStoredConfig : {};
  } catch {
    return {};
  }
}

function resolveJiraConfigValue(key: keyof JiraStoredConfig): string | undefined {
  const envValue = process.env[key]?.trim();
  if (envValue) return envValue;
  const fileValue = readJiraConfigFile()[key]?.trim();
  return fileValue || undefined;
}

function getBaseUrl(): string {
  return normalizeBaseUrl(resolveJiraConfigValue("JIRA_BASE_URL") || DEFAULT_JIRA_BASE_URL);
}

function getAuthHeader(): string {
  const mode = (resolveJiraConfigValue("JIRA_AUTH_MODE") || "bearer").toLowerCase() as JiraAuthMode;
  const token = resolveJiraConfigValue("JIRA_TOKEN");
  if (!token) throw new Error(`Missing Jira token. Set JIRA_TOKEN or add it to ${JIRA_CONFIG_PATH}.`);

  if (mode === "basic") {
    const email = resolveJiraConfigValue("JIRA_EMAIL");
    if (!email) throw new Error("Missing JIRA_EMAIL for basic Jira auth mode.");
    return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  }

  return `Bearer ${token}`;
}

async function jiraFetch(restPath: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${getBaseUrl()}/rest/api/2${restPath}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: getAuthHeader(),
      ...(init?.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data?.errorMessages?.join("; ") || data?.message || text || `HTTP ${response.status}`;
    throw new Error(`Jira API error (${response.status}): ${message}`);
  }

  return data;
}

function jiraValueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  // Jira Cloud-style Atlassian Document Format, plus generic recursive fallback.
  const texts: string[] = [];
  const visit = (node: any) => {
    if (!node) return;
    if (typeof node === "string") {
      texts.push(node);
      return;
    }
    if (typeof node?.text === "string") texts.push(node.text);
    if (Array.isArray(node?.content)) {
      for (const child of node.content) visit(child);
    }
  };
  visit(value);
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

function extractLinkedTickets(issue: any): Array<{ key: string; type: string }> {
  const links = issue?.fields?.issuelinks;
  if (!Array.isArray(links)) return [];

  const result: Array<{ key: string; type: string }> = [];
  for (const link of links) {
    const linked = link?.outwardIssue || link?.inwardIssue;
    if (!linked?.key) continue;
    result.push({ key: String(linked.key), type: String(link?.type?.name || "linked") });
  }
  return result;
}

async function fetchIssue(issueKey: string): Promise<JiraIssueSummary> {
  const fields = [
    "summary",
    "issuetype",
    "status",
    "description",
    "labels",
    "issuelinks",
  ].join(",");
  const issue = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}?fields=${fields}`);
  const f = issue?.fields ?? {};

  return {
    key: issue?.key ?? issueKey,
    title: String(f?.summary ?? ""),
    type: String(f?.issuetype?.name ?? ""),
    status: String(f?.status?.name ?? ""),
    description: jiraValueToText(f?.description),
    linkedTickets: extractLinkedTickets(issue),
    labels: Array.isArray(f?.labels) ? f.labels.map(String) : [],
  };
}

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

function statePathFor(cwd: string, issueKey: string): string {
  return path.join(cwd, STATE_DIR, `${issueKey}.state.json`);
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function assertStateShape(state: HarnessState): void {
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

  if (state.schemaVersion !== 1) throw new Error(`State validation failed: unsupported schemaVersion '${state.schemaVersion}'.`);
  if (!ISSUE_KEY_PATTERN.test(state.ticketKey)) throw new Error(`State validation failed: invalid ticketKey '${state.ticketKey}'.`);
  if (!STEP_ORDER.includes(state.currentStep) && state.currentStep !== "failed") {
    throw new Error(`State validation failed: invalid currentStep '${state.currentStep}'.`);
  }
  if (state.revisionCount < 0 || state.revisionLimit < 0) {
    throw new Error("State validation failed: revisionCount/revisionLimit must be >= 0.");
  }
  if (!Array.isArray(state.evidence) || !Array.isArray(state.acceptanceCriteria)) {
    throw new Error("State validation failed: evidence and acceptanceCriteria must be arrays.");
  }
}

function readState(filePath: string): HarnessState {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as HarnessState;
  assertStateShape(parsed);
  return parsed;
}

function stateDirFor(cwd: string): string {
  return path.join(cwd, STATE_DIR);
}

function listStateFiles(cwd: string): string[] {
  const dir = stateDirFor(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".state.json"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function resolveStatePathFromArg(cwd: string, arg: string): string | undefined {
  const trimmed = arg.trim();
  if (!trimmed) return undefined;
  if (trimmed.endsWith(".json") || trimmed.includes(path.sep)) {
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  }
  const issueKey = normalizeIssueKey(trimmed);
  if (!ISSUE_KEY_PATTERN.test(issueKey)) return undefined;
  return statePathFor(cwd, issueKey);
}

function writeState(filePath: string, state: HarnessState): HarnessState {
  state.updatedAt = new Date().toISOString();
  assertStateShape(state);
  writeJson(filePath, state);
  return state;
}

function createState(issue: JiraIssueSummary): HarnessState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    ticketKey: issue.key,
    summary: issue.title,
    description: issue.description,
    linkedTickets: issue.linkedTickets,
    labels: issue.labels,
    acceptanceCriteria: extractAcceptanceCriteria(issue.description),
    constraints: extractConstraints(issue.description, issue.labels),
    currentStep: "intake",
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
    revisionLimit: 2,
    evidence: [],
    review: {
      verdict: "pending",
      findings: [],
      summary: "",
    },
    pr: {
      url: null,
      draft: true,
    },
    finalVerdict: "pending",
    retroNotes: [],
    createdAt: now,
    updatedAt: now,
  };
}

function activeStatePathFromSession(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as any;
    if (entry?.type === "custom" && entry?.customType === HARNESS_ENTRY_TYPE) {
      const statePath = entry?.data?.statePath;
      if (typeof statePath === "string" && statePath) return statePath;
    }
  }
  return undefined;
}

function resolveStatePath(ctx: ExtensionContext, explicit?: string): string {
  const candidate = explicit?.trim() || activeStatePathFromSession(ctx);
  if (!candidate) {
    throw new Error("No active lean BFH state. Start with /bfh PROJ-123 or pass statePath.");
  }
  return path.isAbsolute(candidate) ? candidate : path.resolve(ctx.cwd, candidate);
}

function assertTransition(state: HarnessState, nextStep: HarnessStep): void {
  if (!ALLOWED_TRANSITIONS[state.currentStep]?.includes(nextStep)) {
    throw new Error(`Invalid transition: ${state.currentStep} -> ${nextStep}`);
  }

  if (state.currentStep === "verify_review" && nextStep === "implement" && state.revisionCount >= state.revisionLimit) {
    throw new Error(`Revision limit reached (${state.revisionCount}/${state.revisionLimit}). Do not loop back to implement.`);
  }
}

function mergeStatePatch(state: HarnessState, patch: any): HarnessState {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return state;

  const forbidden = new Set(["schemaVersion", "ticketKey", "currentStep", "revisionCount", "revisionLimit", "createdAt", "updatedAt"]);
  for (const key of Object.keys(patch)) {
    if (forbidden.has(key)) continue;
    const value = patch[key];

    if (key === "scout" && value && typeof value === "object") {
      state.scout = { ...state.scout, ...value };
    } else if (key === "review" && value && typeof value === "object") {
      state.review = { ...state.review, ...value };
    } else if (key === "pr" && value && typeof value === "object") {
      state.pr = { ...state.pr, ...value };
    } else if (key in state) {
      (state as any)[key] = value;
    }
  }

  return state;
}

function shortDescription(text: string, max = 3500): string {
  const compact = text.replace(/\r/g, "").trim();
  if (compact.length <= max) return compact || "(No Jira description provided.)";
  return `${compact.slice(0, max)}\n\n… [description truncated in prompt; full text is in state file]`;
}

function createKickoffPrompt(statePath: string, state: HarnessState): string {
  return [
    `Start the lean BFH POC for ${state.ticketKey}.`,
    "",
    "You are the implementer/orchestrator inside a deterministic Pi-native workflow.",
    "Keep the state file current by using `bfh_state` after each phase.",
    "Do not skip the verify/review gate. Do not exceed two revision cycles.",
    "Prefer short summaries and log paths over raw command output.",
    "",
    "State file:",
    statePath,
    "",
    "Ticket:",
    `- Key: ${state.ticketKey}`,
    `- Summary: ${state.summary}`,
    `- Labels: ${state.labels.join(", ") || "(none)"}`,
    state.linkedTickets.length ? `- Linked: ${state.linkedTickets.map((t) => `${t.key} (${t.type})`).join(", ")}` : "- Linked: (none)",
    "",
    "Description:",
    shortDescription(state.description),
    "",
    "Acceptance criteria extracted so far:",
    ...(state.acceptanceCriteria.length ? state.acceptanceCriteria.map((item) => `- ${item}`) : ["- (none extracted; derive from ticket or ask targeted questions)"]),
    "",
    "Required phase contract:",
    "1. `bfh_state` action `advance` to `scout`, then gather concise advisory context: likely files, commands, patterns, constraints. Use `scout_auto` for automated subagent recon or patch `scout` manually.",
    "2. If there are real decision points, advance to `clarify` and use `build_questionnaire`; patch `openQuestions` with answers. Otherwise advance directly to `implement`.",
    "3. In `implement`, write a short plan, make the smallest safe change, run focused checks with output redirected to logs, and record evidence with action `evidence`.",
    "4. Advance to `verify_review`. Run the combined gate: acceptance criteria, test evidence, diff quality, regressions, maintainability. Use `run_fresh_review` if available. Patch `review`.",
    "5. If the gate requests a fix and revision budget remains, action `advance` back to `implement` and address only the findings. The state tool increments the revision count automatically. Otherwise continue.",
    "6. Advance to `close` only when review is approved. Use `bfh_state` action `close_create` (or run `/bfh-close`) to enforce close gates and create a draft PR.",
    "7. Advance to `retro`. Append concise lessons to `LEARNINGS.md` if useful, patch `retroNotes`, then advance to `done`.",
    "",
    "Stop and report if blocked. Keep this POC lean; avoid inventing extra process.",
  ].join("\n");
}

function stateToolText(statePath: string, state: HarnessState): string {
  return [
    `State: ${statePath}`,
    `Step: ${state.currentStep}`,
    `Revision: ${state.revisionCount}/${state.revisionLimit}`,
    `Review: ${state.review.verdict}`,
    `Evidence: ${state.evidence.length}`,
    `PR: ${state.pr.url || "(none)"}`,
    `Verdict: ${state.finalVerdict}`,
  ].join("\n");
}

function renderStatus(statePath: string, state: HarnessState): string {
  const latestEvidence = state.evidence.slice(-5).map((item) => {
    const passed = typeof item.passed === "boolean" ? ` passed=${item.passed}` : "";
    const command = item.command ? ` command=${item.command}` : "";
    return `- ${item.type}${passed}${command}: ${item.summary}`;
  });

  return [
    `# ${state.ticketKey} — ${state.summary || "Lean BFH task"}`,
    "",
    stateToolText(statePath, state),
    "",
    "## Acceptance criteria",
    ...(state.acceptanceCriteria.length ? state.acceptanceCriteria.map((item) => `- ${item}`) : ["- (none recorded)"]),
    "",
    "## Open questions",
    ...(state.openQuestions.length ? state.openQuestions.map((q) => `- ${q.id}: ${q.question}${q.answer ? ` → ${q.answer}` : ""}`) : ["- (none)"]),
    "",
    "## Review",
    state.review.summary || "(no review summary)",
    ...(state.review.findings.length ? ["", ...state.review.findings.map((f) => `- ${f.severity}/${f.category}: ${f.message}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`)] : []),
    "",
    "## Latest evidence",
    ...(latestEvidence.length ? latestEvidence : ["- (none)"]),
  ].join("\n");
}

function evaluateCloseReadiness(state: HarnessState): { ok: boolean; reasons: string[]; prBody: string } {
  const reasons: string[] = [];
  const passedTests = state.evidence.some((e) => e.type === "test" && e.passed !== false);
  const reviewEvidence = state.evidence.some((e) => e.type === "review" && e.passed !== false);
  const criticalFindings = state.review.findings.filter((f) => f.severity === "critical");

  if (state.currentStep !== "close") reasons.push(`currentStep is ${state.currentStep}, expected close`);
  if (state.review.verdict !== "approved") reasons.push(`review verdict is ${state.review.verdict}, expected approved`);
  if (criticalFindings.length > 0) reasons.push(`${criticalFindings.length} critical review finding(s) remain`);
  if (!passedTests) reasons.push("no passing test evidence recorded");
  if (!reviewEvidence && state.review.verdict === "approved") reasons.push("no review evidence item recorded");

  const tested = state.evidence
    .filter((e) => e.type === "test" || e.type === "manual" || e.type === "review")
    .map((e) => `- ${e.type}: ${e.summary}${e.command ? ` (${e.command})` : ""}`);

  const risks = state.review.findings
    .filter((f) => f.severity !== "critical")
    .map((f) => `- ${f.severity}/${f.category}: ${f.message}`);

  const prBody = [
    "## Summary",
    state.summary || `Work for ${state.ticketKey}`,
    "",
    "## Acceptance criteria",
    ...(state.acceptanceCriteria.length ? state.acceptanceCriteria.map((item) => `- ${item}`) : ["- See Jira ticket"]),
    "",
    "## What was verified",
    ...(tested.length ? tested : ["- Verification evidence missing"]),
    "",
    "## Remaining risk",
    ...(risks.length ? risks : ["- None identified"]),
    "",
    "## Jira",
    state.ticketKey,
  ].join("\n");

  return { ok: reasons.length === 0, reasons, prBody };
}

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
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`${step} failed: ${formatExecError(error)}`);
  }
}

function detectDefaultBaseBranch(cwd: string): string {
  try {
    const originHead = runCommand(cwd, "git", ["symbolic-ref", "refs/remotes/origin/HEAD"], "Detect origin default branch");
    const match = originHead.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) return match[1];
  } catch {
    // Fallback below.
  }

  try {
    runCommand(cwd, "git", ["show-ref", "--verify", "refs/heads/main"], "Check main branch");
    return "main";
  } catch {
    // Fallback below.
  }

  try {
    runCommand(cwd, "git", ["show-ref", "--verify", "refs/heads/master"], "Check master branch");
    return "master";
  } catch {
    // Fallback below.
  }

  return "main";
}

function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/\S+/);
  return match?.[0]?.replace(/[)>.,;]+$/, "");
}

function createDefaultPrTitle(state: HarnessState): string {
  const summary = state.summary?.trim() || state.ticketKey;
  return `${state.ticketKey}: ${summary}`;
}

type CloseCreateOptions = {
  prTitle?: string;
  prBody?: string;
  baseBranch?: string;
  headBranch?: string;
  pushBranch?: boolean;
  autoAdvanceRetro?: boolean;
  dryRun?: boolean;
};

function executeCloseCreate(cwd: string, state: HarnessState, options: CloseCreateOptions): {
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
  const readiness = evaluateCloseReadiness(state);
  const prTitle = options.prTitle?.trim() || createDefaultPrTitle(state);
  const prBody = options.prBody ?? readiness.prBody;
  const autoAdvanceRetro = options.autoAdvanceRetro !== false;

  if (!readiness.ok) {
    return {
      ok: false,
      created: false,
      reasons: readiness.reasons,
      prTitle,
      prBody,
    };
  }

  const baseBranch = options.baseBranch?.trim() || detectDefaultBaseBranch(cwd);
  const headBranch = options.headBranch?.trim() || runCommand(cwd, "git", ["rev-parse", "--abbrev-ref", "HEAD"], "Detect current branch");
  const pushBranch = options.pushBranch !== false;

  if (options.dryRun) {
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
      throw error;
    }
  }

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

  if (autoAdvanceRetro && state.currentStep === "close") {
    applyAdvance(state, "retro");
  }

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

function createResumePrompt(statePath: string, state: HarnessState): string {
  return [
    `Resume the lean BFH run for ${state.ticketKey}.`,
    "",
    `Current step: ${state.currentStep}`,
    `Revision budget: ${state.revisionCount}/${state.revisionLimit}`,
    `State file: ${statePath}`,
    "",
    "First call `bfh_state` with action `read` to load the current state.",
    "Then continue from the current step using the same phase contract:",
    "scout → clarify? → implement → verify_review → close → retro → done.",
    "Use `bfh_state` action `diff_context` during verify_review to get compact touched-file context.",
    "Do not skip review, and do not attempt another repair loop if the revision budget is exhausted.",
  ].join("\n");
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDiffRanges(diff: string, map: Map<string, ChangedRange[]>): void {
  let currentFile: string | undefined;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      if (!map.has(currentFile)) map.set(currentFile, []);
      continue;
    }

    if (!currentFile || !line.startsWith("@@")) continue;
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;

    const start = toNumber(match[1]);
    const count = toNumber(match[2]) ?? 1;
    if (!start) continue;
    map.get(currentFile)?.push({ startLine: start, endLine: start + Math.max(count, 1) - 1 });
  }
}

function mergeRanges(ranges: ChangedRange[]): ChangedRange[] {
  const normalized = ranges
    .filter((r) => typeof r.startLine === "number" && typeof r.endLine === "number")
    .map((r) => ({
      startLine: Math.max(1, Math.floor(r.startLine!)),
      endLine: Math.max(Math.floor(r.startLine!), Math.floor(r.endLine!)),
    }))
    .sort((a, b) => a.startLine - b.startLine);

  if (normalized.length === 0) return [];
  const merged: ChangedRange[] = [normalized[0]];

  for (let i = 1; i < normalized.length; i++) {
    const prev = merged[merged.length - 1];
    const next = normalized[i];
    if (next.startLine <= (prev.endLine ?? 0) + 3) {
      prev.endLine = Math.max(prev.endLine ?? 0, next.endLine);
    } else {
      merged.push(next);
    }
  }

  return merged;
}

function discoverTouchedFiles(cwd: string, maxFiles: number): TouchedFile[] {
  const rangeMap = new Map<string, ChangedRange[]>();

  const collectDiff = (args: string[]) => {
    try {
      const output = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      parseDiffRanges(output, rangeMap);
    } catch {
      // Ignore non-git dirs or empty repositories.
    }
  };

  collectDiff(["diff", "--unified=0", "--no-color"]);
  collectDiff(["diff", "--cached", "--unified=0", "--no-color"]);

  const files: TouchedFile[] = [];
  for (const [filePath, ranges] of rangeMap.entries()) {
    const merged = mergeRanges(ranges);
    if (merged.length === 0) {
      files.push({ path: filePath });
    } else {
      for (const range of merged) files.push({ path: filePath, startLine: range.startLine, endLine: range.endLine });
    }
  }

  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    for (const line of status.split(/\r?\n/)) {
      if (!line.startsWith("?? ")) continue;
      const filePath = line.slice(3).trim();
      if (!filePath || files.some((f) => f.path === filePath)) continue;
      files.push({ path: filePath, note: "Untracked file" });
      if (files.length >= maxFiles) break;
    }
  } catch {
    // Ignore status failures.
  }

  return files.slice(0, maxFiles);
}

function renderSnippetWithLineNumbers(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  const safeStart = Math.max(1, startLine);
  const safeEnd = Math.min(lines.length, Math.max(safeStart, endLine));
  const out: string[] = [];

  for (let lineNo = safeStart; lineNo <= safeEnd; lineNo++) {
    out.push(`${String(lineNo).padStart(5, " ")} | ${lines[lineNo - 1] ?? ""}`);
  }

  return out.join("\n");
}

function buildTouchedFileContext(cwd: string, touchedFiles: TouchedFile[]): { context: string; filesUsed: TouchedFile[] } {
  const maxTotalChars = 40_000;
  const maxCharsPerFile = 8_000;
  const parts: string[] = [];
  const filesUsed: TouchedFile[] = [];
  let totalChars = 0;

  for (const touched of touchedFiles) {
    if (totalChars >= maxTotalChars) break;
    const absPath = path.isAbsolute(touched.path) ? touched.path : path.join(cwd, touched.path);
    let block: string;

    if (!fs.existsSync(absPath)) {
      block = `## ${touched.path}\n(File not found on disk)\n`;
    } else {
      try {
        const content = fs.readFileSync(absPath, "utf8");
        const hasRange = typeof touched.startLine === "number" && typeof touched.endLine === "number";
        const lineCount = content.split(/\r?\n/).length;
        const snippet = hasRange
          ? renderSnippetWithLineNumbers(content, Math.max(1, touched.startLine! - 4), touched.endLine! + 4)
          : renderSnippetWithLineNumbers(content, 1, Math.min(lineCount, 120));
        const trimmed = snippet.length > maxCharsPerFile ? `${snippet.slice(0, maxCharsPerFile)}\n... (truncated)` : snippet;
        block = [`## ${touched.path}`, touched.note ? `Note: ${touched.note}` : undefined, "```", trimmed, "```"].filter(Boolean).join("\n");
      } catch {
        block = `## ${touched.path}\n(File not readable as utf8 text)\n`;
      }
    }

    if (totalChars + block.length > maxTotalChars) break;
    parts.push(block);
    filesUsed.push(touched);
    totalChars += block.length;
  }

  return { context: parts.join("\n\n"), filesUsed };
}

function buildScoutInput(state: HarnessState, scoutFocus?: string): string {
  return [
    `Ticket: ${state.ticketKey}`,
    `Summary: ${state.summary}`,
    state.description ? `Description: ${state.description}` : undefined,
    state.acceptanceCriteria.length ? `Acceptance Criteria:\n${state.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}` : undefined,
    state.constraints.length ? `Known Constraints:\n${state.constraints.map((item) => `- ${item}`).join("\n")}` : undefined,
    scoutFocus ? `Extra Scout Focus: ${scoutFocus}` : undefined,
  ]
    .filter((v): v is string => Boolean(v))
    .join("\n\n");
}

function getReviewSystemPrompt(): string {
  return [
    "You are a fresh senior code-review agent.",
    "Goal: provide actionable suggestions only (no code edits).",
    "Evaluate against: acceptance criteria, stability, regressions, maintainability, readability.",
    "",
    "Output format:",
    "1) Strengths",
    "2) Risks / Defects",
    "3) Suggestions (prioritized)",
    "4) Open questions",
    "",
    "Rules:",
    "- Be concrete and reference file paths + line ranges where possible.",
    "- Explicitly state if approval is recommended or if revision is required.",
  ].join("\n");
}

async function runFreshReviewViaSubagent(options: {
  cwd: string;
  reviewerInput: string;
  systemPrompt: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<FreshReviewSubagentResult> {
  if (options.signal?.aborted) {
    throw new Error("Fresh review subagent aborted.");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-review-"));
  const inputPath = path.join(tmpDir, "review-input.md");
  const orchestrationPrompt = buildSubagentOrchestrationPrompt(options.systemPrompt, options.reviewerInput);
  fs.writeFileSync(inputPath, orchestrationPrompt, { encoding: "utf8" });

  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--tools",
    "subagent",
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(`@${inputPath}`);

  const invocation = getPiInvocation(args);
  let stdoutBuffer = "";
  let stderr = "";
  let latestAssistantText = "";
  let latestSubagentToolText = "";
  let stopReason: string | undefined;
  let usedSubagent = false;
  let aborted = false;

  const proc = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const processLine = (line: string) => {
    if (!line.trim()) return;

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event?.type === "message_end" && event?.message?.role === "assistant") {
      if (hasSubagentToolCall(event.message)) usedSubagent = true;
      const text = extractAssistantText(event.message);
      if (text) latestAssistantText = text;
      if (typeof event?.message?.stopReason === "string") stopReason = event.message.stopReason;
    }

    if (event?.type === "tool_result_end" && event?.message?.toolName === "subagent") {
      usedSubagent = true;
      const text = extractAssistantText(event.message);
      if (text) latestSubagentToolText = text;
    }

    if (event?.type === "turn_end" && Array.isArray(event?.toolResults)) {
      for (const toolResult of event.toolResults) {
        if (toolResult?.toolName === "subagent") {
          usedSubagent = true;
          const text = extractAssistantText(toolResult);
          if (text) latestSubagentToolText = text;
        }
      }
    }
  };

  const onAbort = () => {
    aborted = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  };

  if (options.signal) {
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.stdout.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      proc.on("error", (error) => reject(error));
      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        resolve(code ?? 0);
      });
    });

    if (aborted) throw new Error("Fresh review subagent aborted.");
    if (exitCode !== 0) {
      throw new Error(`Fresh review subagent failed (exit ${exitCode}): ${stderr.trim() || "no stderr output"}`);
    }
    if (!usedSubagent) {
      throw new Error("Fresh review failed: subagent tool was not used by the review runner.");
    }

    return {
      text: latestAssistantText || latestSubagentToolText,
      stopReason,
      stderr,
      exitCode,
      usedSubagent,
    };
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runScoutViaSubagent(options: {
  cwd: string;
  scoutInput: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<FreshReviewSubagentResult> {
  if (options.signal?.aborted) {
    throw new Error("Scout subagent aborted.");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-scout-"));
  const inputPath = path.join(tmpDir, "scout-input.md");
  const orchestrationPrompt = buildScoutSubagentOrchestrationPrompt(options.scoutInput);
  fs.writeFileSync(inputPath, orchestrationPrompt, { encoding: "utf8" });

  const args = ["--mode", "json", "-p", "--no-session", "--tools", "subagent"];
  if (options.model) args.push("--model", options.model);
  args.push(`@${inputPath}`);

  const invocation = getPiInvocation(args);
  let stdoutBuffer = "";
  let stderr = "";
  let latestAssistantText = "";
  let latestSubagentToolText = "";
  let stopReason: string | undefined;
  let usedSubagent = false;
  let aborted = false;

  const proc = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const processLine = (line: string) => {
    if (!line.trim()) return;

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event?.type === "message_end" && event?.message?.role === "assistant") {
      if (hasSubagentToolCall(event.message)) usedSubagent = true;
      const text = extractAssistantText(event.message);
      if (text) latestAssistantText = text;
      if (typeof event?.message?.stopReason === "string") stopReason = event.message.stopReason;
    }

    if (event?.type === "tool_result_end" && event?.message?.toolName === "subagent") {
      usedSubagent = true;
      const text = extractAssistantText(event.message);
      if (text) latestSubagentToolText = text;
    }

    if (event?.type === "turn_end" && Array.isArray(event?.toolResults)) {
      for (const toolResult of event.toolResults) {
        if (toolResult?.toolName === "subagent") {
          usedSubagent = true;
          const text = extractAssistantText(toolResult);
          if (text) latestSubagentToolText = text;
        }
      }
    }
  };

  const onAbort = () => {
    aborted = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  };

  if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.stdout.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      proc.on("error", (error) => reject(error));
      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        resolve(code ?? 0);
      });
    });

    if (aborted) throw new Error("Scout subagent aborted.");
    if (exitCode !== 0) {
      throw new Error(`Scout subagent failed (exit ${exitCode}): ${stderr.trim() || "no stderr output"}`);
    }
    if (!usedSubagent) {
      throw new Error("Scout failed: subagent tool was not used by the scout runner.");
    }

    return {
      text: latestAssistantText || latestSubagentToolText,
      stopReason,
      stderr,
      exitCode,
      usedSubagent,
    };
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function normalizeScoutFromText(scoutText: string): HarnessState["scout"] {
  const text = scoutText.trim();
  if (!text) {
    return {
      relevantFiles: [],
      patterns: [],
      commands: [],
      constraints: [],
      summary: "Scout returned no content.",
    };
  }

  const parseJsonCandidate = (candidate: string): any | undefined => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const parsed = parseJsonCandidate(text) || (fenced ? parseJsonCandidate(fenced) : undefined);

  if (parsed && typeof parsed === "object") {
    const relevantFiles = Array.isArray(parsed.relevantFiles)
      ? parsed.relevantFiles
        .filter((item: any) => item && typeof item.path === "string")
        .slice(0, 12)
        .map((item: any) => ({
          path: String(item.path).trim(),
          reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : "Relevant to ticket scope",
        }))
      : [];

    const patterns = Array.isArray(parsed.patterns)
      ? parsed.patterns
        .filter((item: any) => item && typeof item.name === "string" && typeof item.description === "string")
        .slice(0, 20)
        .map((item: any) => ({
          name: String(item.name).trim(),
          file: typeof item.file === "string" && item.file.trim() ? item.file.trim() : undefined,
          description: String(item.description).trim(),
        }))
      : [];

    const commands = Array.isArray(parsed.commands)
      ? parsed.commands.filter((item: any) => typeof item === "string" && item.trim()).slice(0, 20).map((item: string) => item.trim())
      : [];

    const constraints = Array.isArray(parsed.constraints)
      ? parsed.constraints.filter((item: any) => typeof item === "string" && item.trim()).slice(0, 20).map((item: string) => item.trim())
      : [];

    const summary = typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : (text.length > 1600 ? `${text.slice(0, 1600)}\n... (truncated)` : text);

    return { relevantFiles, patterns, commands, constraints, summary };
  }

  const commands = Array.from(new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => line.match(/`([^`]+)`/)?.[1] || "")
      .filter((line) => /^(rg|grep|find|ls|git|npm|pnpm|yarn|node|bun|pytest|go\s+test|cargo\s+test)\b/.test(line)),
  )).slice(0, 12);

  return {
    relevantFiles: [],
    patterns: [],
    commands,
    constraints: [],
    summary: text.length > 2000 ? `${text.slice(0, 2000)}\n... (truncated)` : text,
  };
}

function normalizeReviewFromText(reviewText: string): HarnessState["review"] {
  const text = reviewText.trim();
  if (!text) {
    return {
      verdict: "failed",
      findings: [{ severity: "critical", category: "review", message: "Fresh review returned no content." }],
      summary: "Fresh review produced no textual output.",
    };
  }

  const lower = text.toLowerCase();
  const needsRevision = /(needs\s+revision|must\s+fix|blocking|blocker|not\s+ready)/i.test(lower);
  const explicitlyApproved = /(approved|approve|ready\s+to\s+merge|no\s+major\s+issues)/i.test(lower);

  const findings: HarnessFinding[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const bullet = line.match(/^[-*]\s+(.*)$/)?.[1] || line;
    if (/(critical|blocker|must\s+fix|security)/i.test(bullet)) {
      findings.push({ severity: "critical", category: "review", message: bullet });
      continue;
    }
    if (/(warning|should\s+fix|risk|follow-up)/i.test(bullet)) {
      findings.push({ severity: "warning", category: "review", message: bullet });
      continue;
    }
    if (/\b(info|nit|optional)\b/i.test(bullet)) {
      findings.push({ severity: "info", category: "review", message: bullet });
    }
  }

  let verdict: HarnessState["review"]["verdict"] = "approved";
  if (findings.some((f) => f.severity === "critical")) verdict = "needs_revision";
  else if (needsRevision) verdict = "needs_revision";
  else if (!explicitlyApproved && findings.some((f) => f.severity === "warning")) verdict = "needs_revision";

  return {
    verdict,
    findings: findings.slice(0, 40),
    summary: text.length > 3000 ? `${text.slice(0, 3000)}\n... (truncated)` : text,
  };
}

function applyAdvance(state: HarnessState, nextStep: HarnessStep): void {
  assertTransition(state, nextStep);
  if (state.currentStep === "verify_review" && nextStep === "implement") {
    state.revisionCount += 1;
    state.review.verdict = "needs_revision";
  }
  state.currentStep = nextStep;
  if (nextStep === "done") state.finalVerdict = "success";
  if (nextStep === "failed") state.finalVerdict = "failed";
}

function runHarnessSelfTest(cwd: string): string {
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

  return ["Lean BFH self-test passed.", ...lines, `State fixture: ${tmpPath}`].join("\n");
}

const HarnessStateParams = Type.Object({
  statePath: Type.Optional(Type.String({ description: "Path to state JSON. Defaults to active /bfh session state." })),
  action: Type.String({ description: "read | patch | advance | evidence | question | verdict | diff_context | scout_auto | verify_review | close_check | close_create" }),
  patch: Type.Optional(Type.Any({ description: "Small JSON patch for patch action. currentStep/revision fields are ignored." })),
  nextStep: Type.Optional(Type.String({ description: "Target step for advance action." })),
  incrementRevision: Type.Optional(Type.Boolean({ description: "When advancing verify_review -> implement, increment revision count." })),
  evidence: Type.Optional(Type.Object({
    type: Type.String({ description: "test | manual | review | pr | note" }),
    command: Type.Optional(Type.String()),
    passed: Type.Optional(Type.Boolean()),
    summary: Type.String(),
    logPath: Type.Optional(Type.String()),
  })),
  question: Type.Optional(Type.Object({
    id: Type.String(),
    question: Type.String(),
    answer: Type.Optional(Type.String()),
  })),
  finalVerdict: Type.Optional(Type.String({ description: "success | failed | pending" })),
  maxFiles: Type.Optional(Type.Number({ description: "Max touched files for diff_context / verify_review (default 20)." })),
  implementationNotes: Type.Optional(Type.String({ description: "Short summary of what was implemented for review context." })),
  reviewFocus: Type.Optional(Type.String({ description: "Extra focus area for verify_review." })),
  scoutFocus: Type.Optional(Type.String({ description: "Extra focus area for scout_auto." })),
  prTitle: Type.Optional(Type.String({ description: "Optional PR title override for close_create." })),
  prBody: Type.Optional(Type.String({ description: "Optional PR body override for close_create." })),
  baseBranch: Type.Optional(Type.String({ description: "Optional PR base branch for close_create (defaults to origin default/main/master)." })),
  headBranch: Type.Optional(Type.String({ description: "Optional PR head branch for close_create (defaults to current branch)." })),
  pushBranch: Type.Optional(Type.Boolean({ description: "Push branch to origin before creating PR (default true)." })),
  autoAdvanceRetro: Type.Optional(Type.Boolean({ description: "Advance close -> retro automatically after PR creation (default true)." })),
  dryRun: Type.Optional(Type.Boolean({ description: "Validate readiness and return PR payload without pushing/creating PR." })),
});

export default function leanBfh(pi: ExtensionAPI) {
  const startHarness = async (args: string, ctx: ExtensionContext) => {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Agent is busy. Wait until current work is done.", "warning");
      return;
    }

    let { issueKey, noJira } = parseHarnessStartArgs(args || "");
    if (!issueKey && ctx.hasUI) {
      const input = await ctx.ui.input("Jira ticket key", "e.g. PC-120");
      if (!input) return;
      issueKey = normalizeIssueKey(input);
    }

    if (!ISSUE_KEY_PATTERN.test(issueKey)) {
      ctx.ui.notify("Invalid ticket key. Expected format like PC-120.", "error");
      return;
    }

    if (noJira) {
      ctx.ui.notify(`Starting harness for ${issueKey} without Jira lookup (--no-jira).`, "info");
    } else {
      ctx.ui.notify(`Fetching Jira ticket ${issueKey}...`, "info");
    }

    let issue: JiraIssueSummary;
    if (noJira) {
      issue = {
        key: issueKey,
        title: issueKey,
        type: "unknown",
        status: "unknown",
        description: "",
        linkedTickets: [],
        labels: [],
      };
    } else {
      try {
        issue = await fetchIssue(issueKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!ctx.hasUI) {
          ctx.ui.notify(`${message}\nHint: use /bfh ${issueKey} --no-jira for local/offline testing.`, "error");
          return;
        }

        const proceed = await ctx.ui.confirm(
          "Jira lookup failed",
          `${message}\n\nContinue with only the ticket key?`,
        );
        if (!proceed) return;

        issue = {
          key: issueKey,
          title: issueKey,
          type: "unknown",
          status: "unknown",
          description: "",
          linkedTickets: [],
          labels: [],
        };
      }
    }

    const state = createState(issue);
    const statePath = statePathFor(ctx.cwd, issueKey);
    writeState(statePath, state);

    pi.appendEntry(HARNESS_ENTRY_TYPE, {
      issueKey,
      statePath,
      startedAt: state.createdAt,
    });
    pi.setSessionName(`${issueKey}: ${state.summary || "Lean BFH"}`);

    ctx.ui.notify(`Lean BFH state created: ${statePath}`, "info");
    pi.sendUserMessage(createKickoffPrompt(statePath, state));
  };

  pi.registerCommand("bfh", {
    description: "Start lean BFH -> verified change POC. Usage: /bfh PROJ-123 [--no-jira]",
    handler: startHarness,
  });

  pi.registerCommand("bfh-status", {
    description: "Show lean BFH state. Usage: /bfh-status [TICKET-123|state-path]",
    handler: async (args, ctx) => {
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found in this repo/session.", "warning");
        return;
      }

      const state = readState(statePath);
      ctx.ui.notify(renderStatus(statePath, state), state.finalVerdict === "failed" ? "error" : "info");
    },
  });

  pi.registerCommand("bfh-list", {
    description: "List lean BFH state files in this repo.",
    handler: async (_args, ctx) => {
      const files = listStateFiles(ctx.cwd);
      if (files.length === 0) {
        ctx.ui.notify("No lean BFH state files found.", "info");
        return;
      }

      const lines = files.slice(0, 20).map((file) => {
        try {
          const state = readState(file);
          return `- ${state.ticketKey}: ${state.currentStep}, rev ${state.revisionCount}/${state.revisionLimit}, ${state.finalVerdict} — ${state.summary}`;
        } catch {
          return `- ${file}: unreadable`;
        }
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("bfh-selftest", {
    description: "Run local deterministic smoke checks for lean BFH state machine.",
    handler: async (_args, ctx) => {
      try {
        const report = runHarnessSelfTest(ctx.cwd);
        ctx.ui.notify(report, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Lean BFH self-test failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("bfh-resume", {
    description: "Resume lean BFH state. Usage: /bfh-resume [TICKET-123|state-path]",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until current work is done.", "warning");
        return;
      }

      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found to resume.", "warning");
        return;
      }

      const state = readState(statePath);
      pi.appendEntry(HARNESS_ENTRY_TYPE, {
        issueKey: state.ticketKey,
        statePath,
        resumedAt: new Date().toISOString(),
      });
      pi.setSessionName(`${state.ticketKey}: ${state.summary || "Lean BFH"}`);
      ctx.ui.notify(`Resuming lean BFH: ${statePath}`, "info");
      pi.sendUserMessage(createResumePrompt(statePath, state));
    },
  });

  pi.registerCommand("bfh-scout", {
    description: "Run automated scout subagent and patch state.scout. Usage: /bfh-scout [TICKET-123|state-path]",
    handler: async (args, ctx) => {
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found to scout.", "warning");
        return;
      }

      const state = readState(statePath);
      if (state.currentStep !== "scout") {
        ctx.ui.notify(`Current step is ${state.currentStep}. Move to scout first.`, "warning");
        return;
      }

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      let scoutResult: FreshReviewSubagentResult;
      try {
        scoutResult = await runScoutViaSubagent({
          cwd: ctx.cwd,
          scoutInput: buildScoutInput(state),
          model,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Scout helper failed: ${message}`, "error");
        return;
      }

      const normalized = normalizeScoutFromText(scoutResult.text);
      state.scout = normalized;
      state.evidence.push({
        type: "note",
        summary: "Automated scout reconnaissance captured via scout subagent.",
        createdAt: new Date().toISOString(),
      });
      writeState(statePath, state);

      ctx.ui.notify([
        stateToolText(statePath, state),
        "",
        "Scout summary:",
        normalized.summary || "(none)",
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("bfh-verify", {
    description: "Run verify/review helper for active harness state. Usage: /bfh-verify [TICKET-123|state-path]",
    handler: async (args, ctx) => {
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found to verify.", "warning");
        return;
      }

      const state = readState(statePath);
      if (state.currentStep !== "verify_review") {
        ctx.ui.notify(`Current step is ${state.currentStep}. Move to verify_review first.`, "warning");
        return;
      }

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const touchedFiles = discoverTouchedFiles(ctx.cwd, 20);
      const contextBundle = buildTouchedFileContext(ctx.cwd, touchedFiles);
      const reviewerInput = [
        `Ticket: ${state.ticketKey}`,
        `Summary: ${state.summary}`,
        state.description ? `Description: ${state.description}` : undefined,
        "",
        "Touched code context:",
        contextBundle.context || "(No touched file snippets found. Review based on ticket context only.)",
      ]
        .filter((v): v is string => Boolean(v))
        .join("\n");

      let subagentResult: FreshReviewSubagentResult;
      try {
        subagentResult = await runFreshReviewViaSubagent({
          cwd: ctx.cwd,
          reviewerInput,
          systemPrompt: getReviewSystemPrompt(),
          model,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`verify/review helper failed: ${message}`, "error");
        return;
      }

      const normalized = normalizeReviewFromText(subagentResult.text);
      state.review = normalized;
      state.evidence.push({
        type: "review",
        passed: normalized.verdict === "approved",
        summary: normalized.verdict === "approved"
          ? "Fresh verify/review passed."
          : "Fresh verify/review requested revisions.",
        createdAt: new Date().toISOString(),
      });

      if (normalized.verdict === "approved") {
        applyAdvance(state, "close");
      } else if (state.revisionCount < state.revisionLimit) {
        applyAdvance(state, "implement");
      } else {
        applyAdvance(state, "failed");
      }

      writeState(statePath, state);
      ctx.ui.notify([
        stateToolText(statePath, state),
        "",
        "Reviewer summary:",
        normalized.summary,
      ].join("\n"), state.currentStep === "failed" ? "error" : "info");
    },
  });

  pi.registerCommand("bfh-close", {
    description: "Run close helper and create a draft PR. Usage: /bfh-close [TICKET-123|state-path]",
    handler: async (args, ctx) => {
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found to close.", "warning");
        return;
      }

      const state = readState(statePath);

      let result: ReturnType<typeof executeCloseCreate>;
      try {
        result = executeCloseCreate(ctx.cwd, state, {
          pushBranch: true,
          autoAdvanceRetro: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Close helper failed: ${message}`, "error");
        return;
      }

      if (!result.ok) {
        ctx.ui.notify([
          "Close helper blocked:",
          ...(result.reasons || []).map((r) => `- ${r}`),
          "",
          "Draft PR body if blockers are resolved:",
          result.prBody,
        ].join("\n"), "warning");
        return;
      }

      writeState(statePath, state);
      ctx.ui.notify([
        stateToolText(statePath, state),
        "",
        `Draft PR: ${result.prUrl}`,
        `Base: ${result.baseBranch}`,
        `Head: ${result.headBranch}`,
        result.created ? "Created new draft PR." : "Reused existing draft PR.",
      ].join("\n"), "info");
    },
  });

  pi.registerTool({
    name: "bfh_state",
    label: "BFH State",
    description: "Read or update the lean BFH task state with deterministic transition checks.",
    promptSnippet: "Read/update lean BFH state for Jira-driven work.",
    promptGuidelines: [
      "Use bfh_state during /bfh runs to record phase progress, evidence, review verdicts, and PR/retro notes.",
      "Use bfh_state action `advance` instead of directly editing currentStep; it enforces the revision limit and valid transitions.",
      "Use bfh_state action `diff_context` during verify_review to get compact git diff/status snippets without dumping entire files.",
      "Use bfh_state action `scout_auto` during scout for automated read-only scout subagent reconnaissance.",
      "Use bfh_state action `verify_review` to run the combined review gate and auto-advance to implement/close/failed.",
      "Use bfh_state action `close_create` to enforce close gates and create a draft PR safely.",
      "Use bfh_state action `close_check` when you only need readiness + PR body without creating a PR.",
    ],
    parameters: HarnessStateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const statePath = resolveStatePath(ctx, params.statePath);
      const state = readState(statePath);
      const action = String(params.action || "read").trim().toLowerCase();

      if (action === "read") {
        return {
          content: [{ type: "text", text: `${stateToolText(statePath, state)}\n\n${JSON.stringify(state, null, 2)}` }],
          details: { ok: true, statePath, state },
        };
      }

      if (action === "scout_auto") {
        if (state.currentStep !== "scout") {
          throw new Error(`scout_auto action requires currentStep=scout (found ${state.currentStep}).`);
        }

        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const scoutInput = buildScoutInput(state, params.scoutFocus);
        const scoutResult = await runScoutViaSubagent({
          cwd: ctx.cwd,
          scoutInput,
          model,
          signal: _signal,
        });

        const normalized = normalizeScoutFromText(scoutResult.text);
        state.scout = normalized;
        state.evidence.push({
          type: "note",
          summary: "Automated scout reconnaissance captured via scout subagent.",
          createdAt: new Date().toISOString(),
        });
        writeState(statePath, state);

        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              "scout_auto: OK",
              "",
              "Scout summary:",
              normalized.summary || "(none)",
              "",
              "Relevant files:",
              ...(normalized.relevantFiles.length
                ? normalized.relevantFiles.map((item) => `- ${item.path}: ${item.reason}`)
                : ["- (none)"]),
            ].join("\n"),
          }],
          details: {
            ok: true,
            statePath,
            scout: normalized,
            model,
          },
        };
      }

      if (action === "diff_context") {
        const maxFiles = Number.isFinite(params.maxFiles) && (params.maxFiles ?? 0) > 0
          ? Math.floor(params.maxFiles!)
          : 20;
        const touchedFiles = discoverTouchedFiles(ctx.cwd, maxFiles);
        const bundle = buildTouchedFileContext(ctx.cwd, touchedFiles);
        const summary = touchedFiles.length
          ? touchedFiles.map((f) => `- ${f.path}${f.startLine ? `:${f.startLine}-${f.endLine}` : ""}${f.note ? ` (${f.note})` : ""}`).join("\n")
          : "(No touched files detected from git diff/status.)";

        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              "Touched files:",
              summary,
              "",
              "Compact touched-file context:",
              bundle.context || "(No readable touched-file snippets.)",
            ].join("\n"),
          }],
          details: { ok: true, statePath, touchedFiles, filesUsed: bundle.filesUsed },
        };
      }

      if (action === "verify_review") {
        if (state.currentStep !== "verify_review") {
          throw new Error(`verify_review action requires currentStep=verify_review (found ${state.currentStep}).`);
        }

        const maxFiles = Number.isFinite(params.maxFiles) && (params.maxFiles ?? 0) > 0
          ? Math.floor(params.maxFiles!)
          : 20;
        const touchedFiles = discoverTouchedFiles(ctx.cwd, maxFiles);
        const bundle = buildTouchedFileContext(ctx.cwd, touchedFiles);
        const reviewerInput = [
          `Ticket: ${state.ticketKey}`,
          `Summary: ${state.summary}`,
          state.description ? `Description: ${state.description}` : undefined,
          params.implementationNotes ? `Implementation Notes: ${params.implementationNotes}` : undefined,
          params.reviewFocus ? `Extra Focus: ${params.reviewFocus}` : undefined,
          "",
          "Touched code context:",
          bundle.context || "(No touched file snippets found. Review based on ticket context only.)",
        ]
          .filter((v): v is string => Boolean(v))
          .join("\n");

        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const subagentResult = await runFreshReviewViaSubagent({
          cwd: ctx.cwd,
          reviewerInput,
          systemPrompt: getReviewSystemPrompt(),
          model,
          signal: _signal,
        });

        const normalized = normalizeReviewFromText(subagentResult.text);
        state.review = normalized;
        state.evidence.push({
          type: "review",
          passed: normalized.verdict === "approved",
          summary: normalized.verdict === "approved"
            ? "Fresh verify/review passed."
            : "Fresh verify/review requested revisions.",
          createdAt: new Date().toISOString(),
        });

        let transition: HarnessStep;
        if (normalized.verdict === "approved") transition = "close";
        else if (state.revisionCount < state.revisionLimit) transition = "implement";
        else transition = "failed";

        applyAdvance(state, transition);
        writeState(statePath, state);

        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              `verify_review transition: ${transition}`,
              "",
              "Fresh reviewer output:",
              normalized.summary,
            ].join("\n"),
          }],
          details: {
            ok: transition !== "failed",
            statePath,
            transition,
            touchedFiles,
            filesUsed: bundle.filesUsed,
            review: normalized,
            model,
          },
          isError: transition === "failed",
        };
      }

      if (action === "close_create") {
        const result = executeCloseCreate(ctx.cwd, state, {
          prTitle: params.prTitle,
          prBody: params.prBody,
          baseBranch: params.baseBranch,
          headBranch: params.headBranch,
          pushBranch: params.pushBranch,
          autoAdvanceRetro: params.autoAdvanceRetro,
          dryRun: params.dryRun,
        });

        if (!result.ok) {
          return {
            content: [{
              type: "text",
              text: [
                "Close create: BLOCKED",
                "",
                ...(result.reasons || []).map((r) => `- ${r}`),
                "",
                "Draft PR body if blockers are resolved:",
                result.prBody,
              ].join("\n"),
            }],
            details: {
              ok: false,
              statePath,
              reasons: result.reasons || [],
              prTitle: result.prTitle,
              prBody: result.prBody,
            },
            isError: true,
          };
        }

        if (!result.dryRun) writeState(statePath, state);

        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              result.dryRun ? "Close create: DRY RUN (no PR created)" : "Close create: OK",
              `Base: ${result.baseBranch}`,
              `Head: ${result.headBranch}`,
              `PR: ${result.prUrl || "(not created)"}`,
              "",
              "Draft PR body:",
              result.prBody,
            ].join("\n"),
          }],
          details: {
            ok: true,
            statePath,
            dryRun: Boolean(result.dryRun),
            created: result.created,
            prUrl: result.prUrl,
            baseBranch: result.baseBranch,
            headBranch: result.headBranch,
            prTitle: result.prTitle,
            prBody: result.prBody,
          },
        };
      }

      if (action === "close_check") {
        const readiness = evaluateCloseReadiness(state);
        return {
          content: [{
            type: "text",
            text: readiness.ok
              ? [`Close check: OK`, "", "Draft PR body:", readiness.prBody].join("\n")
              : [`Close check: BLOCKED`, "", ...readiness.reasons.map((r) => `- ${r}`), "", "Draft PR body if blockers are resolved:", readiness.prBody].join("\n"),
          }],
          details: { ok: readiness.ok, statePath, reasons: readiness.reasons, prBody: readiness.prBody },
          isError: !readiness.ok,
        };
      }

      if (action === "patch") {
        mergeStatePatch(state, params.patch);
        writeState(statePath, state);
        return {
          content: [{ type: "text", text: stateToolText(statePath, state) }],
          details: { ok: true, statePath, state },
        };
      }

      if (action === "question") {
        if (!params.question) throw new Error("question action requires question payload.");
        const existing = state.openQuestions.find((q) => q.id === params.question!.id);
        if (existing) {
          existing.question = params.question.question;
          existing.answer = params.question.answer;
        } else {
          state.openQuestions.push(params.question as any);
        }
        writeState(statePath, state);
        return {
          content: [{ type: "text", text: stateToolText(statePath, state) }],
          details: { ok: true, statePath, state },
        };
      }

      if (action === "evidence") {
        if (!params.evidence) throw new Error("evidence action requires evidence payload.");
        state.evidence.push({
          ...(params.evidence as any),
          createdAt: new Date().toISOString(),
        });
        writeState(statePath, state);
        return {
          content: [{ type: "text", text: stateToolText(statePath, state) }],
          details: { ok: true, statePath, state },
        };
      }

      if (action === "advance") {
        const nextStep = String(params.nextStep || "") as HarnessStep;
        if (!STEP_ORDER.includes(nextStep) && nextStep !== "failed") {
          throw new Error(`Invalid nextStep: ${params.nextStep}`);
        }
        applyAdvance(state, nextStep);
        writeState(statePath, state);
        return {
          content: [{ type: "text", text: stateToolText(statePath, state) }],
          details: { ok: true, statePath, state },
        };
      }

      if (action === "verdict") {
        const verdict = String(params.finalVerdict || "pending");
        if (!["success", "failed", "pending"].includes(verdict)) throw new Error(`Invalid finalVerdict: ${verdict}`);
        state.finalVerdict = verdict as HarnessState["finalVerdict"];
        writeState(statePath, state);
        return {
          content: [{ type: "text", text: stateToolText(statePath, state) }],
          details: { ok: true, statePath, state },
        };
      }

      throw new Error(`Unknown bfh_state action: ${action}`);
    },
  });
}
