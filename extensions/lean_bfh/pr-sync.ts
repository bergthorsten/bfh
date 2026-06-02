import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { ticketMarkerDir } from "./evidence-markers.ts";
import type { HarnessState, PrReviewDecision } from "./types.ts";

export const PR_REVIEW_MARKER_VERSION = 1;

export type { PrReviewDecision };

export type PrReviewThread = {
  path?: string;
  line?: number;
  body: string;
  author?: string;
  createdAt?: string;
};

export type PrReviewSnapshot = {
  prUrl: string;
  prNumber: number;
  state: string;
  isDraft: boolean;
  reviewDecision: PrReviewDecision;
  unresolvedThreads: number;
  reviewCommentCount: number;
  checksPending: number;
  checksFailing: number;
  threads: PrReviewThread[];
  syncedAt: string;
};

export type PrReviewMarker = {
  version: typeof PR_REVIEW_MARKER_VERSION;
  ticketKey: string;
  timestamp: string;
  reviewDecision: PrReviewDecision;
  unresolvedThreads: number;
  reviewCommentCount: number;
  checksFailing: number;
  stateUpdatedAt: string;
  writtenBy: string;
};

export function prReviewMarkerPath(statePath: string): string {
  return `${ticketMarkerDir(statePath)}/pr-review.json`;
}

function formatExecError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const anyError = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
  const stderr = Buffer.isBuffer(anyError.stderr) ? anyError.stderr.toString("utf8") : (anyError.stderr ?? "");
  const stdout = Buffer.isBuffer(anyError.stdout) ? anyError.stdout.toString("utf8") : (anyError.stdout ?? "");
  return [stderr.trim(), stdout.trim(), anyError.message].filter(Boolean).join("\n");
}

function runGh(cwd: string, args: string[]): string {
  try {
    return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new Error(`gh ${args.join(" ")} failed: ${formatExecError(error)}`);
  }
}

export function parseGitHubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function normalizeReviewDecision(raw: string | undefined | null): PrReviewDecision {
  const v = String(raw || "UNKNOWN").toUpperCase();
  if (
    v === "APPROVED" ||
    v === "CHANGES_REQUESTED" ||
    v === "REVIEW_REQUIRED" ||
    v === "COMMENTED" ||
    v === "PENDING" ||
    v === "DISMISSED"
  ) {
    return v;
  }
  return "UNKNOWN";
}

function readMarker<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readPrReviewMarker(statePath: string): PrReviewMarker | null {
  return readMarker<PrReviewMarker>(prReviewMarkerPath(statePath));
}

export function writePrReviewMarker(statePath: string, state: HarnessState, snapshot: PrReviewSnapshot): PrReviewMarker {
  const dir = ticketMarkerDir(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const marker: PrReviewMarker = {
    version: PR_REVIEW_MARKER_VERSION,
    ticketKey: state.ticketKey,
    timestamp: snapshot.syncedAt,
    reviewDecision: snapshot.reviewDecision,
    unresolvedThreads: snapshot.unresolvedThreads,
    reviewCommentCount: snapshot.reviewCommentCount,
    checksFailing: snapshot.checksFailing,
    stateUpdatedAt: state.updatedAt,
    writtenBy: "bfh_state:pr_sync",
  };
  fs.writeFileSync(prReviewMarkerPath(statePath), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return marker;
}

export function syncPrReviewFromGitHub(cwd: string, prUrl: string): PrReviewSnapshot {
  const parsed = parseGitHubPrUrl(prUrl);
  if (!parsed) throw new Error(`Not a GitHub pull request URL: ${prUrl}`);

  const viewRaw = runGh(cwd, [
    "pr",
    "view",
    prUrl,
    "--json",
    "number,state,isDraft,reviewDecision,statusCheckRollup,reviews",
  ]);
  const view = JSON.parse(viewRaw) as {
    number: number;
    state: string;
    isDraft: boolean;
    reviewDecision?: string;
    statusCheckRollup?: Array<{ state?: string; conclusion?: string }>;
    reviews?: Array<{ state?: string; body?: string; author?: { login?: string } }>;
  };

  const checks = view.statusCheckRollup ?? [];
  const checksFailing = checks.filter((c) => c.conclusion === "FAILURE" || c.state === "FAILURE").length;
  const checksPending = checks.filter((c) => c.state === "PENDING" || c.conclusion === "PENDING").length;

  let reviewCommentCount = 0;
  const threads: PrReviewThread[] = [];
  try {
    const commentsRaw = runGh(cwd, [
      "api",
      `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments`,
      "--paginate",
    ]);
    const comments = JSON.parse(commentsRaw) as Array<{
      path?: string;
      line?: number;
      body?: string;
      user?: { login?: string };
      created_at?: string;
    }>;
    if (Array.isArray(comments)) {
      reviewCommentCount = comments.length;
      for (const c of comments.slice(0, 20)) {
        if (!c.body?.trim()) continue;
        threads.push({
          path: c.path,
          line: c.line,
          body: c.body.trim().slice(0, 500),
          author: c.user?.login,
          createdAt: c.created_at,
        });
      }
    }
  } catch {
    // Review comments are optional; reviewDecision still applies.
  }

  const latestReviews = view.reviews ?? [];
  const hasChangesRequested = latestReviews.some((r) => String(r.state).toUpperCase() === "CHANGES_REQUESTED");

  let reviewDecision = normalizeReviewDecision(view.reviewDecision);
  if (hasChangesRequested && reviewDecision !== "APPROVED") {
    reviewDecision = "CHANGES_REQUESTED";
  }

  const unresolvedThreads = reviewCommentCount;

  return {
    prUrl,
    prNumber: view.number ?? parsed.number,
    state: view.state ?? "UNKNOWN",
    isDraft: Boolean(view.isDraft),
    reviewDecision,
    unresolvedThreads,
    reviewCommentCount,
    checksPending,
    checksFailing,
    threads,
    syncedAt: new Date().toISOString(),
  };
}

export function applyPrSnapshotToState(state: HarnessState, snapshot: PrReviewSnapshot): void {
  state.pr.url = snapshot.prUrl;
  state.pr.draft = snapshot.isDraft;
  state.pr.reviewDecision = snapshot.reviewDecision;
  state.pr.unresolvedThreads = snapshot.unresolvedThreads;
  state.pr.lastSyncedAt = snapshot.syncedAt;
  state.pr.checksFailing = snapshot.checksFailing;
}

export function prReviewBlockedForDone(state: HarnessState): boolean {
  if (state.pr.allowDoneWithoutPrApproval) return false;
  if (!state.pr.url) return false;
  return state.pr.reviewDecision !== "APPROVED";
}

export function doneBlockedReasons(state: HarnessState, marker: PrReviewMarker | null): string[] {
  const reasons: string[] = [];
  if (!state.pr.url) return reasons;
  if (state.pr.allowDoneWithoutPrApproval) return reasons;

  const decision = marker?.reviewDecision ?? state.pr.reviewDecision;
  if (decision !== "APPROVED") {
    reasons.push(
      `GitHub PR reviewDecision is ${decision ?? "unknown"} (run pr_sync after colleague approval, or patch pr.allowDoneWithoutPrApproval)`,
    );
  }
  if (marker && marker.stateUpdatedAt !== state.updatedAt) {
    reasons.push("pr-review.json is stale relative to state.updatedAt (re-run pr_sync)");
  }
  return reasons;
}

export function formatPrReviewSummary(snapshot: PrReviewSnapshot): string {
  const lines = [
    `PR #${snapshot.prNumber} (${snapshot.state}${snapshot.isDraft ? ", draft" : ""})`,
    `reviewDecision: ${snapshot.reviewDecision}`,
    `review comments: ${snapshot.reviewCommentCount}`,
    `checks failing: ${snapshot.checksFailing}, pending: ${snapshot.checksPending}`,
  ];
  if (snapshot.threads.length) {
    lines.push("", "Recent review comments:");
    for (const t of snapshot.threads.slice(0, 8)) {
      const loc = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "(general)";
      lines.push(`- ${loc}: ${t.body.slice(0, 120)}${t.body.length > 120 ? "…" : ""}`);
    }
  }
  return lines.join("\n");
}
