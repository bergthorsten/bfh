import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { loadBfhConfig } from "./bfh-config.ts";
import type { GitEntryMode, HarnessGitState } from "./types.ts";

export const DEFAULT_BASE_BRANCH = "master";
export const MAX_BRANCH_NAME_LENGTH = 50;

export type GitPrepResult = HarnessGitState & {
  commitsAhead: number;
  commitLog: string;
};

type UiContext = Pick<ExtensionContext, "hasUI" | "ui">;

function formatExecError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const anyError = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
  const stderr = Buffer.isBuffer(anyError.stderr) ? anyError.stderr.toString("utf8") : (anyError.stderr ?? "");
  const stdout = Buffer.isBuffer(anyError.stdout) ? anyError.stdout.toString("utf8") : (anyError.stdout ?? "");
  return [stderr.trim(), stdout.trim(), anyError.message].filter(Boolean).join("\n");
}

export function runGit(cwd: string, args: string[], step: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`${step} failed: ${formatExecError(error)}`);
  }
}

export function runGitOptional(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args, args.join(" "));
  } catch {
    return null;
  }
}

export function resolveHarnessBaseBranch(cwd: string): string {
  return loadBfhConfig(cwd).workflow.baseBranch || DEFAULT_BASE_BRANCH;
}

/** Slugify text for branch name suffix (lowercase, hyphenated). */
export function slugifyBranch(text: string, maxLength = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength);
}

/** Bergfreunde branch naming: TICKET-slug-from-summary (max 50 chars, ticket prefix preserved). */
export function deriveBranchName(
  ticketKey: string,
  summary: string,
  maxLength = MAX_BRANCH_NAME_LENGTH,
): string {
  const prefix = `${ticketKey}-`;
  const slugBudget = Math.max(maxLength - prefix.length, 0);
  if (slugBudget <= 0) return ticketKey.slice(0, maxLength);

  const slug = slugifyBranch(summary, slugBudget);
  const branch = slug ? `${prefix}${slug}` : ticketKey;
  return branch.slice(0, maxLength);
}

export function assertGitRepository(cwd: string): void {
  runGit(cwd, ["rev-parse", "--is-inside-work-tree"], "Verify git repository");
}

export function getWorkingTreeStatus(cwd: string): string {
  return runGit(cwd, ["status", "--porcelain"], "git status").trim();
}

export function getCurrentBranch(cwd: string): string {
  return runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], "Detect current branch");
}

export function branchExistsLocally(cwd: string, branch: string): boolean {
  return runGitOptional(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;
}

export function branchExistsRemotely(cwd: string, branch: string): boolean {
  return runGitOptional(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]) !== null;
}

export function countCommitsAhead(cwd: string, baseBranch: string, branch: string): number {
  const count = runGitOptional(cwd, ["rev-list", "--count", `${baseBranch}..${branch}`]);
  if (!count) return 0;
  const parsed = Number.parseInt(count, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function commitLogAhead(cwd: string, baseBranch: string, branch: string, limit = 8): string {
  return (
    runGitOptional(cwd, [
      "log",
      `--max-count=${limit}`,
      "--oneline",
      "--no-decorate",
      `${baseBranch}..${branch}`,
    ]) ?? ""
  );
}

export async function confirmCleanWorkingTree(
  cwd: string,
  ctx: UiContext,
  actionLabel: string,
): Promise<boolean> {
  const status = getWorkingTreeStatus(cwd);
  if (!status) return true;

  const preview = status.split(/\r?\n/).slice(0, 12).join("\n");
  const suffix = status.split(/\r?\n/).length > 12 ? "\n…" : "";
  const message = `Uncommitted changes block ${actionLabel}:\n${preview}${suffix}`;

  if (!ctx.hasUI) {
    ctx.ui.notify(`${message}\nCommit, stash, or discard changes and retry.`, "error");
    return false;
  }

  const choice = await ctx.ui.select(message, [
    "Stash changes and continue",
    "Discard all changes and continue",
    "I'll fix it manually (retry later)",
  ]);

  if (!choice || choice.startsWith("I'll fix")) {
    ctx.ui.notify("Clean up your working tree, then run the command again.", "warning");
    return false;
  }
  if (choice.startsWith("Stash")) {
    runGit(cwd, ["stash", "push", "-u", "-m", `bfh: auto-stash before ${actionLabel}`], "git stash");
    return true;
  }
  if (choice.startsWith("Discard")) {
    runGit(cwd, ["reset", "--hard"], "git reset");
    runGit(cwd, ["clean", "-fd"], "git clean");
    return true;
  }

  return false;
}

function checkoutBaseBranch(cwd: string, baseBranch: string): void {
  if (branchExistsLocally(cwd, baseBranch)) {
    runGit(cwd, ["checkout", baseBranch], `Checkout ${baseBranch}`);
    return;
  }
  if (branchExistsRemotely(cwd, baseBranch)) {
    runGit(cwd, ["checkout", "-B", baseBranch, `origin/${baseBranch}`], `Checkout ${baseBranch} from origin`);
    return;
  }
  throw new Error(`Base branch '${baseBranch}' not found locally or on origin.`);
}

function syncBaseBranch(cwd: string, baseBranch: string): void {
  runGit(cwd, ["fetch", "origin"], "git fetch");
  checkoutBaseBranch(cwd, baseBranch);
  runGit(cwd, ["pull", "origin", baseBranch], `Pull origin/${baseBranch}`);
}

function checkoutFeatureBranch(cwd: string, branch: string): void {
  if (branchExistsLocally(cwd, branch)) {
    runGit(cwd, ["checkout", branch], `Checkout ${branch}`);
    return;
  }
  if (branchExistsRemotely(cwd, branch)) {
    runGit(cwd, ["checkout", "-b", branch, `origin/${branch}`], `Checkout tracking branch ${branch}`);
    return;
  }
  runGit(cwd, ["checkout", "-b", branch], `Create branch ${branch}`);
}

async function resolveAdoptEntryMode(
  ctx: UiContext,
  branch: string,
  commitsAhead: number,
): Promise<GitEntryMode> {
  if (commitsAhead <= 0) return "greenfield";

  if (!ctx.hasUI) return "adopt-continue";

  const choice = await ctx.ui.select(
    `Branch '${branch}' already has ${commitsAhead} commit(s) ahead of base. How should BFH start?`,
    [
      "Continue implementation (default)",
      "Review & test only",
      "Refine / fix existing work",
    ],
  );

  if (choice?.startsWith("Review")) return "adopt-verify";
  if (choice?.startsWith("Refine")) return "adopt-fix";
  return "adopt-continue";
}

export async function prepareGitForStart(
  cwd: string,
  ctx: UiContext,
  input: { ticketKey: string; summary: string },
): Promise<GitPrepResult | null> {
  assertGitRepository(cwd);

  if (!(await confirmCleanWorkingTree(cwd, ctx, `/bfh ${input.ticketKey}`))) {
    return null;
  }

  const baseBranch = resolveHarnessBaseBranch(cwd);
  const branch = deriveBranchName(input.ticketKey, input.summary);

  syncBaseBranch(cwd, baseBranch);

  const hadLocal = branchExistsLocally(cwd, branch);
  const hadRemote = branchExistsRemotely(cwd, branch);
  checkoutFeatureBranch(cwd, branch);

  const commitsAhead = countCommitsAhead(cwd, baseBranch, branch);
  const commitLog = commitsAhead > 0 ? commitLogAhead(cwd, baseBranch, branch) : "";

  let entryMode: GitEntryMode = "greenfield";
  if (hadLocal || hadRemote) {
    entryMode = await resolveAdoptEntryMode(ctx, branch, commitsAhead);
  }

  ctx.ui.notify(`Git ready: on '${branch}' (base ${baseBranch}, mode ${entryMode})`, "info");

  return {
    branch,
    baseBranch,
    entryMode,
    commitsAhead,
    commitLog,
  };
}

export async function prepareGitForResume(
  cwd: string,
  ctx: UiContext,
  git: HarnessGitState,
): Promise<boolean> {
  assertGitRepository(cwd);

  if (!(await confirmCleanWorkingTree(cwd, ctx, `/bfh-resume ${git.branch}`))) {
    return false;
  }

  const current = getCurrentBranch(cwd);
  if (current === git.branch) {
    ctx.ui.notify(`Already on branch '${git.branch}'.`, "info");
    return true;
  }

  checkoutFeatureBranch(cwd, git.branch);
  ctx.ui.notify(`Checked out branch '${git.branch}'.`, "info");
  return true;
}
