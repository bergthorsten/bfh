import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";

type JiraAuthMode = "bearer" | "basic";

type JiraIssueSummary = {
  key: string;
  title: string;
  type: string;
  status: string;
  description: string;
  linkedTickets: Array<{ key: string; type: string }>;
};

type ChangedRange = { startLine?: number; endLine?: number };

type TouchedFile = {
  path: string;
  startLine?: number;
  endLine?: number;
  note?: string;
};

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const CUSTOM_ANSWER = "✍ Type custom answer";
const MAX_BRANCH_NAME_LENGTH = 60;
const BUILD_WORKFLOW_ENTRY_TYPE = "jira_build_workflow_state";

type BuildRepos = {
  srcDir: string;
  devenvDir: string;
};

type FreshReviewSubagentResult = {
  text: string;
  stopReason?: string;
  stderr: string;
  exitCode: number;
  usedSubagent: boolean;
};

type BuildWorkflowEntryData = {
  issueKey: string;
  branchName?: string;
  startedAt: string;
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
    "You are the reviewer subagent for a Jira /build workflow.",
    "Provide actionable suggestions only; do not edit files.",
    "",
    "Review contract:",
    systemPrompt,
    "",
    "Ticket + implementation context:",
    reviewerInput,
  ].join("\n");
}

function buildSubagentOrchestrationPrompt(systemPrompt: string, reviewerInput: string): string {
  const reviewerTask = buildSubagentReviewerTask(systemPrompt, reviewerInput);

  return [
    "Use the `subagent` tool to run a fresh-context `reviewer` agent exactly once.",
    "Do not perform the review directly in this parent agent.",
    "After the subagent returns, output only the reviewer output text.",
    "",
    "Call shape:",
    "subagent({ agent: \"reviewer\", task: <reviewer task>, context: \"fresh\", output: false, progress: false })",
    "",
    "Reviewer task:",
    "```",
    reviewerTask,
    "```",
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fresh-review-"));
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

function isBuildWorkflowActive(sessionManager: { getBranch: () => any[] }): boolean {
  const branch = sessionManager.getBranch();
  return branch.some((entry: any) => entry?.type === "custom" && entry?.customType === BUILD_WORKFLOW_ENTRY_TYPE);
}

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveBuildRepos(cwd: string): BuildRepos | undefined {
  let current = path.resolve(cwd);

  while (true) {
    const srcDir = path.join(current, "src");
    const devenvDir = path.join(current, "devenv");
    if (isDirectory(srcDir) && isDirectory(devenvDir)) {
      return { srcDir, devenvDir };
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function formatExecError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const anyError = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
  const stderr = Buffer.isBuffer(anyError.stderr)
    ? anyError.stderr.toString("utf8")
    : (anyError.stderr ?? "");
  const stdout = Buffer.isBuffer(anyError.stdout)
    ? anyError.stdout.toString("utf8")
    : (anyError.stdout ?? "");

  return [stderr.trim(), stdout.trim(), error.message].filter(Boolean).join("\n");
}

function runGit(repoDir: string, args: string[], step: string): string {
  try {
    return execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`${step} failed in ${repoDir}: ${formatExecError(error)}`);
  }
}

function assertGitRepo(repoDir: string) {
  runGit(repoDir, ["rev-parse", "--is-inside-work-tree"], "Verify git repository");
}

function branchExists(repoDir: string, branchName: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branchName}`], {
      cwd: repoDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function sanitizeBranchSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function createTicketBranchName(issueKey: string, issueTitle?: string): string {
  const prefix = `${issueKey}-`;
  const remaining = Math.max(0, MAX_BRANCH_NAME_LENGTH - prefix.length);
  const fallback = "work-item";

  if (remaining <= 0) return issueKey.slice(0, MAX_BRANCH_NAME_LENGTH);

  let slug = sanitizeBranchSlug(issueTitle || "") || fallback;

  if (slug.length > remaining) {
    slug = slug.slice(0, remaining).replace(/-+$/g, "");
    const lastDash = slug.lastIndexOf("-");
    if (lastDash >= 8) {
      slug = slug.slice(0, lastDash).replace(/-+$/g, "");
    }
    if (!slug) slug = fallback.slice(0, remaining).replace(/-+$/g, "");
  }

  const branchName = `${prefix}${slug}`.slice(0, MAX_BRANCH_NAME_LENGTH).replace(/-+$/g, "");
  return branchName || issueKey.slice(0, MAX_BRANCH_NAME_LENGTH);
}

function prepareBuildWorkspace(cwd: string, issueKey: string, issueTitle?: string): { srcDir: string; devenvDir: string; branchName: string } {
  const repos = resolveBuildRepos(cwd);
  if (!repos) {
    throw new Error(`Could not find sibling folders \"devenv\" and \"src\" from ${cwd}.`);
  }

  const { srcDir, devenvDir } = repos;
  assertGitRepo(srcDir);
  assertGitRepo(devenvDir);

  try {
    runGit(srcDir, ["checkout", "master"], "Check if src can checkout master");
  } catch (error) {
    throw new Error(
      [
        "Cannot checkout master in src. Please stage/commit/stash your local changes first, then retry /build.",
        error instanceof Error ? error.message : String(error),
      ].join("\n\n"),
    );
  }

  runGit(devenvDir, ["fetch", "origin", "main"], "Fetch devenv/main");
  runGit(devenvDir, ["checkout", "main"], "Checkout devenv/main");
  runGit(devenvDir, ["pull", "--ff-only", "origin", "main"], "Pull devenv/main");

  runGit(srcDir, ["fetch", "origin", "master"], "Fetch src/master");
  runGit(srcDir, ["pull", "--ff-only", "origin", "master"], "Pull src/master");

  const branchName = createTicketBranchName(issueKey, issueTitle);
  if (branchExists(srcDir, branchName)) {
    throw new Error(`Branch \"${branchName}\" already exists in src. Please delete it or rename the ticket slug.`);
  }

  runGit(srcDir, ["checkout", "-b", branchName], `Create branch ${branchName}`);
  return { srcDir, devenvDir, branchName };
}

function getEnv(name: string, required = true): string | undefined {
  const value = process.env[name]?.trim();
  if (!value && required) throw new Error(`Missing env var: ${name}`);
  return value;
}

function getJiraBaseUrl(): string {
  const raw = getEnv("JIRA_BASE_URL")!;
  return raw.replace(/\/+$/, "");
}

function getJiraAuthHeader(): string {
  const mode = (process.env.JIRA_AUTH_MODE?.trim().toLowerCase() || "bearer") as JiraAuthMode;
  const token = getEnv("JIRA_TOKEN")!;

  if (mode === "basic") {
    const email = getEnv("JIRA_EMAIL")!;
    return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  }

  return `Bearer ${token}`;
}

async function jiraFetch(pathSuffix: string, init?: RequestInit): Promise<any> {
  const url = `${getJiraBaseUrl()}/rest/api/2${pathSuffix}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: getJiraAuthHeader(),
      ...(init?.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const msg = data?.errorMessages?.join("; ") || data?.message || text || `HTTP ${response.status}`;
    throw new Error(`Jira API error (${response.status}): ${msg}`);
  }

  return data;
}

function compactText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function flattenJiraDescription(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;

  const parts: string[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object") {
      if (typeof node.text === "string") parts.push(node.text);
      if (Array.isArray(node.content)) walk(node.content);
    }
  };

  walk(value);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function toMinimalIssue(issue: any): JiraIssueSummary {
  const fields = issue?.fields ?? {};
  const statusName = fields?.status?.name;
  const statusCategory = fields?.status?.statusCategory?.name;

  return {
    key: issue?.key ?? "",
    title: fields?.summary ?? "",
    type: fields?.issuetype?.name ?? "",
    status:
      statusName && statusCategory
        ? `${statusName} (${statusCategory})`
        : (statusName ?? ""),
    description: compactText(flattenJiraDescription(fields?.description), 8000),
    linkedTickets: Array.isArray(fields?.issuelinks)
      ? fields.issuelinks.map((link: any) => {
          const direction = link?.inwardIssue ? "inward" : "outward";
          const linkedIssue = link?.inwardIssue ?? link?.outwardIssue ?? {};
          return {
            key: linkedIssue?.key ?? "",
            type: `${link?.type?.name ?? ""}:${direction}`,
          };
        })
      : [],
  };
}

async function fetchIssue(issueKey: string): Promise<JiraIssueSummary> {
  const fields = ["summary", "issuetype", "status", "description", "issuelinks"].join(",");
  const issue = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}?fields=${encodeURIComponent(fields)}`);
  return toMinimalIssue(issue);
}

function normalizeIssueKey(raw: string): string {
  return raw.trim().toUpperCase();
}

function createKickoffPrompt(issueKey: string, issue?: JiraIssueSummary): string {
  const ticketBlock = issue
    ? JSON.stringify(issue, null, 2)
    : JSON.stringify({ key: issueKey, note: "Ticket details unavailable. Ask user for missing context." }, null, 2);

  return [
    `Start a Jira-to-Production implementation workflow for ticket ${issueKey}.`,
    "",
    "Ticket context:",
    "```json",
    ticketBlock,
    "```",
    "",
    "Workflow contract (follow in this order):",
    "1) Read and understand the ticket + relevant code before coding.",
    "2) Keep decisions focused on: maintainable, stable, modern, easy-to-understand code.",
    "3) Before implementation, ask open questions using the `build_questionnaire` tool (user can select or type answers).",
    "4) After answers, publish a concrete TODO checklist and then implement step-by-step.",
    "5) Run validation checks/tests appropriate for the project.",
    "6) At the end, call `run_fresh_review` with ticket context + touched file/line ranges.",
    "7) Present the fresh-agent suggestions, but DO NOT apply them automatically.",
    "8) Ask the user which suggestions should be applied.",
    "",
    "Start now with ticket understanding and repository research.",
  ].join("\n");
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseDiffRanges(diffText: string, map: Map<string, ChangedRange[]>) {
  let currentFile: string | undefined;

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      if (currentFile) {
        const existing = map.get(currentFile) ?? [];
        map.set(currentFile, existing);
      }
      continue;
    }

    if (line.startsWith("+++ /dev/null")) {
      currentFile = undefined;
      continue;
    }

    if (!currentFile || !line.startsWith("@@")) continue;

    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;

    const start = toNumber(match[1]);
    const count = toNumber(match[2]) ?? 1;
    if (!start) continue;

    const safeCount = Math.max(count, 1);
    const end = start + safeCount - 1;

    map.get(currentFile)?.push({ startLine: start, endLine: end });
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
      // Ignore; git may not be available or repo may not exist.
    }
  };

  collectDiff(["diff", "--unified=0", "--no-color"]);
  collectDiff(["diff", "--cached", "--unified=0", "--no-color"]);

  const files: TouchedFile[] = [];
  for (const [filePath, ranges] of rangeMap.entries()) {
    const merged = mergeRanges(ranges);
    if (merged.length === 0) {
      files.push({ path: filePath });
      continue;
    }

    for (const range of merged) {
      files.push({
        path: filePath,
        startLine: range.startLine,
        endLine: range.endLine,
      });
    }
  }

  if (files.length >= maxFiles) return files.slice(0, maxFiles);

  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    for (const line of status.split(/\r?\n/)) {
      if (!line.startsWith("?? ")) continue;
      const filePath = line.slice(3).trim();
      if (!filePath) continue;
      if (files.some((f) => f.path === filePath)) continue;
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
    const line = lines[lineNo - 1] ?? "";
    out.push(`${String(lineNo).padStart(5, " ")} | ${line}`);
  }

  return out.join("\n");
}

function buildTouchedFileContext(cwd: string, touchedFiles: TouchedFile[]): {
  context: string;
  filesUsed: TouchedFile[];
} {
  const maxTotalChars = 70_000;
  const maxCharsPerFile = 10_000;
  const contextParts: string[] = [];
  const filesUsed: TouchedFile[] = [];
  let totalChars = 0;

  for (const touched of touchedFiles) {
    if (totalChars >= maxTotalChars) break;

    const absPath = path.isAbsolute(touched.path) ? touched.path : path.join(cwd, touched.path);
    if (!fs.existsSync(absPath)) {
      const missing = `## ${touched.path}\n(File not found on disk)\n`;
      contextParts.push(missing);
      totalChars += missing.length;
      filesUsed.push(touched);
      continue;
    }

    let content = "";
    try {
      content = fs.readFileSync(absPath, "utf8");
    } catch {
      const unreadable = `## ${touched.path}\n(File not readable as utf8 text)\n`;
      contextParts.push(unreadable);
      totalChars += unreadable.length;
      filesUsed.push(touched);
      continue;
    }

    const from = touched.startLine;
    const to = touched.endLine;
    const hasRange = typeof from === "number" && typeof to === "number";

    const snippet = hasRange
      ? renderSnippetWithLineNumbers(content, Math.max(1, from - 3), Math.max(to + 3, from))
      : renderSnippetWithLineNumbers(content, 1, Math.min(content.split(/\r?\n/).length, 140));

    const trimmedSnippet = snippet.length > maxCharsPerFile
      ? `${snippet.slice(0, maxCharsPerFile)}\n... (truncated)`
      : snippet;

    const block = [
      `## ${touched.path}`,
      touched.note ? `Note: ${touched.note}` : undefined,
      hasRange ? `Range: ${from}-${to}` : "Range: full-file preview",
      "```",
      trimmedSnippet,
      "```",
      "",
    ]
      .filter((v): v is string => Boolean(v))
      .join("\n");

    contextParts.push(block);
    totalChars += block.length;
    filesUsed.push(touched);
  }

  return { context: contextParts.join("\n"), filesUsed };
}

function getReviewSystemPrompt(): string {
  return [
    "You are a fresh senior code-review agent.",
    "Goal: provide actionable suggestions only (no code edits).",
    "Evaluate against these priorities: maintainable, stable, modern, easy-to-understand code.",
    "",
    "Output format:",
    "1) Strengths",
    "2) Risks / Defects",
    "3) Suggestions (prioritized)",
    "4) Open questions for the user",
    "",
    "Rules:",
    "- Be concrete and reference file paths + line ranges where possible.",
    "- Do NOT claim code was changed.",
    "- Do NOT include placeholder fluff.",
  ].join("\n");
}

const BuildQuestionSchema = Type.Object({
  id: Type.String({ description: "Stable identifier for this question" }),
  prompt: Type.String({ description: "Question shown to the user" }),
  options: Type.Optional(
    Type.Array(Type.String({ description: "Selectable answer" }), {
      description: "Optional predefined options",
    }),
  ),
  allowFreeText: Type.Optional(
    Type.Boolean({ description: "Allow typing a custom answer (default true)", default: true }),
  ),
});

const BuildQuestionnaireParams = Type.Object({
  title: Type.Optional(Type.String({ description: "Dialog title" })),
  questions: Type.Array(BuildQuestionSchema, { description: "Questions to ask the user" }),
});

const TouchedFileSchema = Type.Object({
  path: Type.String({ description: "Repository-relative file path" }),
  startLine: Type.Optional(Type.Number({ description: "Changed start line (1-based)" })),
  endLine: Type.Optional(Type.Number({ description: "Changed end line (1-based)" })),
  note: Type.Optional(Type.String({ description: "Optional note for reviewer context" })),
});

const FreshReviewParams = Type.Object({
  ticketKey: Type.String({ description: "Jira ticket key, e.g. PC-120" }),
  ticketSummary: Type.String({ description: "Ticket title/summary" }),
  ticketDescription: Type.Optional(Type.String({ description: "Ticket description" })),
  touchedFiles: Type.Optional(
    Type.Array(TouchedFileSchema, {
      description: "Touched files and changed line ranges. If omitted, tool derives from git diff.",
    }),
  ),
  implementationNotes: Type.Optional(Type.String({ description: "What was implemented" })),
  reviewFocus: Type.Optional(Type.String({ description: "Extra focus areas" })),
  maxFiles: Type.Optional(Type.Number({ description: "Max files to include when auto-discovering (default 25)", default: 25 })),
});

export default function jiraBuildWorkflow(pi: ExtensionAPI) {
  pi.registerCommand("build", {
    description: "Start Jira -> production workflow. Usage: /build PROJ-123",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until current work is done.", "warning");
        return;
      }

      let issueKey = normalizeIssueKey(args || "");

      if (!issueKey && ctx.hasUI) {
        const input = await ctx.ui.input("Ticket key", "e.g. PC-120");
        if (!input) return;
        issueKey = normalizeIssueKey(input);
      }

      if (!ISSUE_KEY_PATTERN.test(issueKey)) {
        ctx.ui.notify("Invalid ticket key. Expected format like PC-120", "error");
        return;
      }

      ctx.ui.notify(`Opening Jira ticket ${issueKey}...`, "info");

      let issue: JiraIssueSummary | undefined;
      try {
        issue = await fetchIssue(issueKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) {
          const proceed = await ctx.ui.confirm(
            "Jira lookup failed",
            `${message}\n\nContinue workflow without ticket body?`,
          );
          if (!proceed) return;
        } else {
          return;
        }
      }

      ctx.ui.notify("Preparing git workspace for /build...", "info");

      let workspace: { srcDir: string; devenvDir: string; branchName: string };
      try {
        workspace = prepareBuildWorkspace(ctx.cwd, issueKey, issue?.title);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      const sessionName = issue?.title ? `${issueKey}: ${issue.title}` : issueKey;
      pi.setSessionName(sessionName);

      ctx.ui.notify(
        [
          `Workspace ready: ${workspace.branchName}`,
          `devenv: ${workspace.devenvDir} (main up to date)`,
          `src: ${workspace.srcDir} (${workspace.branchName} checked out)`,
        ].join("\n"),
        "info",
      );

      const buildState: BuildWorkflowEntryData = {
        issueKey,
        branchName: workspace.branchName,
        startedAt: new Date().toISOString(),
      };
      pi.appendEntry(BUILD_WORKFLOW_ENTRY_TYPE, buildState);

      const kickoff = createKickoffPrompt(issueKey, issue);
      pi.sendUserMessage(kickoff);
    },
  });

  pi.registerTool({
    name: "build_questionnaire",
    label: "Build Questionnaire",
    description:
      "Ask clarifying questions before implementation. Supports fixed choices and typed answers.",
    promptSnippet: "Ask the user targeted clarification questions with selectable options and optional custom answers.",
    promptGuidelines: [
      "Use build_questionnaire when requirements are ambiguous before implementation.",
      "Ask concise, decision-focused questions and avoid assumptions.",
    ],
    parameters: BuildQuestionnaireParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Questionnaire requires interactive UI mode." }],
          details: { cancelled: true, reason: "no-ui" },
          isError: true,
        };
      }

      if (params.questions.length === 0) {
        return {
          content: [{ type: "text", text: "No questions provided." }],
          details: { cancelled: true, reason: "no-questions" },
          isError: true,
        };
      }

      const answers: Array<{ id: string; prompt: string; answer: string; mode: "selected" | "typed" }> = [];
      const title = params.title?.trim() || "Clarifying question";

      for (let i = 0; i < params.questions.length; i++) {
        const q = params.questions[i];
        const options = Array.isArray(q.options)
          ? q.options.map((v) => v.trim()).filter(Boolean)
          : [];
        const allowFreeText = q.allowFreeText !== false;
        const header = `${title} (${i + 1}/${params.questions.length})`;

        if (options.length === 0) {
          const typed = await ctx.ui.input(header, q.prompt);
          if (typed === undefined) {
            return {
              content: [{ type: "text", text: "User cancelled questionnaire." }],
              details: { cancelled: true, answers },
            };
          }

          answers.push({
            id: q.id,
            prompt: q.prompt,
            answer: typed.trim() || "(empty)",
            mode: "typed",
          });
          continue;
        }

        const selectOptions = allowFreeText ? [...options, CUSTOM_ANSWER] : options;
        const selected = await ctx.ui.select(`${header}\n${q.prompt}`, selectOptions);

        if (selected === undefined) {
          return {
            content: [{ type: "text", text: "User cancelled questionnaire." }],
            details: { cancelled: true, answers },
          };
        }

        if (selected === CUSTOM_ANSWER) {
          const typed = await ctx.ui.input(header, "Type your answer");
          if (typed === undefined) {
            return {
              content: [{ type: "text", text: "User cancelled questionnaire." }],
              details: { cancelled: true, answers },
            };
          }

          answers.push({
            id: q.id,
            prompt: q.prompt,
            answer: typed.trim() || "(empty)",
            mode: "typed",
          });
        } else {
          answers.push({
            id: q.id,
            prompt: q.prompt,
            answer: selected,
            mode: "selected",
          });
        }
      }

      const lines = answers.map((a) => `- ${a.id}: ${a.answer}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { cancelled: false, answers },
      };
    },
  });

  pi.registerTool({
    name: "run_fresh_review",
    label: "Run Fresh Review",
    description:
      "Run an isolated reviewer agent over touched files and ticket context. Returns suggestions only.",
    promptSnippet:
      "Run a fresh, context-isolated review pass after implementation and before final user handoff.",
    promptGuidelines: [
      "Use run_fresh_review after implementation is complete and before proposing final merge-ready output.",
      "Never auto-apply run_fresh_review suggestions; ask the user first.",
      "Only use this tool during an active /build workflow session.",
    ],
    parameters: FreshReviewParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!isBuildWorkflowActive(ctx.sessionManager)) {
        return {
          content: [{ type: "text", text: "run_fresh_review is only available inside an active /build workflow session." }],
          details: { ok: false, reason: "not-in-build-workflow" },
          isError: true,
        };
      }

      const maxFiles = Number.isFinite(params.maxFiles) && (params.maxFiles ?? 0) > 0
        ? Math.floor(params.maxFiles!)
        : 25;

      const touchedFiles = (params.touchedFiles?.length ?? 0) > 0
        ? params.touchedFiles!
        : discoverTouchedFiles(ctx.cwd, maxFiles);

      const contextBundle = buildTouchedFileContext(ctx.cwd, touchedFiles);
      const reviewerInput = [
        `Ticket: ${params.ticketKey}`,
        `Summary: ${params.ticketSummary}`,
        params.ticketDescription ? `Description: ${params.ticketDescription}` : undefined,
        params.implementationNotes ? `Implementation Notes: ${params.implementationNotes}` : undefined,
        params.reviewFocus ? `Extra Focus: ${params.reviewFocus}` : undefined,
        "",
        "Touched code context:",
        contextBundle.context || "(No touched file snippets found. Review based on ticket + notes only.)",
      ]
        .filter((v): v is string => Boolean(v))
        .join("\n");

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

      let subagentResult: FreshReviewSubagentResult;
      try {
        subagentResult = await runFreshReviewViaSubagent({
          cwd: ctx.cwd,
          reviewerInput,
          systemPrompt: getReviewSystemPrompt(),
          model,
          signal,
        });
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {
            ok: false,
            reason: "subagent-failed",
            ticketKey: params.ticketKey,
            model,
            filesRequested: touchedFiles,
            filesUsed: contextBundle.filesUsed,
          },
          isError: true,
        };
      }

      const text = subagentResult.text.trim() || "Fresh review produced no textual output.";
      return {
        content: [{ type: "text", text }],
        details: {
          ok: subagentResult.exitCode === 0,
          stopReason: subagentResult.stopReason,
          ticketKey: params.ticketKey,
          model,
          via: "subagent",
          filesRequested: touchedFiles,
          filesUsed: contextBundle.filesUsed,
        },
        isError: subagentResult.exitCode !== 0,
      };
    },
  });
}
