import { execFileSync } from "node:child_process";

export type PrChecksWaitConfig = {
  enabled: boolean;
  initialDelayMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
};

export type PrCheckRun = {
  name: string;
  state?: string;
  bucket?: string;
  workflow?: string;
  link?: string;
  description?: string;
};

export type PrChecksStatus = "success" | "failure" | "pending" | "disabled";

export type PrChecksWaitResult = {
  status: PrChecksStatus;
  attempts: number;
  checks: PrCheckRun[];
  checksPassing: number;
  checksPending: number;
  checksFailing: number;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  summary: string;
};

const FAIL_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "CANCELED", "TIMED_OUT", "ACTION_REQUIRED", "STALE"]);
const PENDING_STATES = new Set(["PENDING", "QUEUED", "REQUESTED", "WAITING", "IN_PROGRESS", "EXPECTED", "STARTUP_FAILURE"]);
const PASS_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function sleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function formatExecError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const anyError = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
  const stderr = Buffer.isBuffer(anyError.stderr) ? anyError.stderr.toString("utf8") : (anyError.stderr ?? "");
  const stdout = Buffer.isBuffer(anyError.stdout) ? anyError.stdout.toString("utf8") : (anyError.stdout ?? "");
  return [stderr.trim(), stdout.trim(), anyError.message].filter(Boolean).join("\n");
}

function normalizeCheck(raw: Record<string, unknown>): PrCheckRun {
  return {
    name: String(raw.name || raw.workflow || "unnamed check"),
    state: typeof raw.state === "string" ? raw.state : undefined,
    bucket: typeof raw.bucket === "string" ? raw.bucket : undefined,
    workflow: typeof raw.workflow === "string" ? raw.workflow : undefined,
    link: typeof raw.link === "string" ? raw.link : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
}

function readPrChecks(cwd: string, prUrl: string): PrCheckRun[] {
  const args = ["pr", "checks", prUrl, "--json", "name,state,bucket,workflow,link,description"];
  try {
    const raw = execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map((item) => normalizeCheck(item as Record<string, unknown>)) : [];
  } catch (error) {
    const anyError = error as Error & { stdout?: string | Buffer };
    const stdout = Buffer.isBuffer(anyError.stdout) ? anyError.stdout.toString("utf8") : (anyError.stdout ?? "");
    // `gh pr checks` can exit non-zero when checks are failing while still returning useful JSON.
    if (stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout.trim());
        return Array.isArray(parsed) ? parsed.map((item) => normalizeCheck(item as Record<string, unknown>)) : [];
      } catch {
        // Fall through to the clearer gh error below.
      }
    }
    const message = formatExecError(error);
    if (/no checks|no status checks|checks? (have )?not (been )?reported/i.test(message)) {
      return [];
    }
    throw new Error(`gh ${args.join(" ")} failed: ${message}`);
  }
}

export function summarizePrChecks(checks: PrCheckRun[]): Pick<PrChecksWaitResult, "status" | "checksPassing" | "checksPending" | "checksFailing" | "summary"> {
  if (checks.length === 0) {
    return {
      status: "pending",
      checksPassing: 0,
      checksPending: 0,
      checksFailing: 0,
      summary: "No GitHub status checks are reported yet.",
    };
  }

  let checksPassing = 0;
  let checksPending = 0;
  let checksFailing = 0;

  for (const check of checks) {
    const bucket = String(check.bucket || "").toLowerCase();
    const state = String(check.state || "").toUpperCase();
    if (bucket === "fail" || bucket === "cancel" || FAIL_STATES.has(state)) {
      checksFailing += 1;
    } else if (bucket === "pending" || PENDING_STATES.has(state)) {
      checksPending += 1;
    } else if (bucket === "pass" || bucket === "skipping" || PASS_STATES.has(state)) {
      checksPassing += 1;
    } else {
      checksPending += 1;
    }
  }

  const status: PrChecksStatus = checksFailing > 0 ? "failure" : checksPending > 0 ? "pending" : "success";
  return {
    status,
    checksPassing,
    checksPending,
    checksFailing,
    summary: `${checksPassing} passing, ${checksPending} pending, ${checksFailing} failing`,
  };
}

export function formatFailingChecks(checks: PrCheckRun[], limit = 8): string[] {
  return checks
    .filter((check) => {
      const bucket = String(check.bucket || "").toLowerCase();
      const state = String(check.state || "").toUpperCase();
      return bucket === "fail" || bucket === "cancel" || FAIL_STATES.has(state);
    })
    .slice(0, limit)
    .map((check) => {
      const state = check.state ? ` [${check.state}]` : "";
      const link = check.link ? ` — ${check.link}` : "";
      return `- ${check.name}${state}${link}`;
    });
}

export function waitForPrChecks(cwd: string, prUrl: string, config: PrChecksWaitConfig): PrChecksWaitResult {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  if (!config.enabled) {
    const completedAt = new Date().toISOString();
    return {
      status: "disabled",
      attempts: 0,
      checks: [],
      checksPassing: 0,
      checksPending: 0,
      checksFailing: 0,
      startedAt,
      completedAt,
      elapsedMs: 0,
      summary: "GitHub PR checks wait is disabled by BFH config.",
    };
  }

  const maxAttempts = Math.max(1, Math.floor(config.maxAttempts));
  let latestChecks: PrCheckRun[] = [];
  let latest = summarizePrChecks(latestChecks);

  sleepMs(Math.max(0, Math.floor(config.initialDelayMs)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    latestChecks = readPrChecks(cwd, prUrl);
    latest = summarizePrChecks(latestChecks);
    if (latest.status === "success" || latest.status === "failure") {
      const completed = Date.now();
      return {
        ...latest,
        attempts: attempt,
        checks: latestChecks,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        elapsedMs: completed - started,
      };
    }
    if (attempt < maxAttempts) sleepMs(Math.max(0, Math.floor(config.pollIntervalMs)));
  }

  const completed = Date.now();
  return {
    ...latest,
    attempts: maxAttempts,
    checks: latestChecks,
    startedAt,
    completedAt: new Date(completed).toISOString(),
    elapsedMs: completed - started,
    summary: `${latest.summary}; timed out waiting for GitHub checks after ${maxAttempts} attempt(s).`,
  };
}
