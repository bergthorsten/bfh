import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverTouchedFiles } from "./git-diff.ts";
import { getReviewCounts, type HarnessReview } from "./review.ts";
import type { HarnessState } from "./types.ts";

export const MARKER_VERSION = 1;

export type TestedMarker = {
  version: typeof MARKER_VERSION;
  ticketKey: string;
  timestamp: string;
  outputHash: string;
  command?: string;
  passed: boolean;
  logPath?: string;
  writtenBy: string;
};

export type ReviewedMarker = {
  version: typeof MARKER_VERSION;
  ticketKey: string;
  timestamp: string;
  verdict: HarnessReview["verdict"];
  critical: number;
  warning: number;
  info: number;
  stateUpdatedAt: string;
  writtenBy: string;
};

export type ManualTestedMarker = {
  version: typeof MARKER_VERSION;
  ticketKey: string;
  timestamp: string;
  summary: string;
  writtenBy: string;
};

export function ticketKeyFromStatePath(statePath: string): string {
  const base = path.basename(statePath);
  if (!base.endsWith(".state.json")) {
    throw new Error(`Invalid state path (expected *.state.json): ${statePath}`);
  }
  return base.slice(0, -".state.json".length);
}

export function ticketMarkerDir(statePath: string): string {
  const dir = path.dirname(statePath);
  const ticketKey = ticketKeyFromStatePath(statePath);
  return path.join(dir, ticketKey);
}

export function testedMarkerPath(statePath: string): string {
  return path.join(ticketMarkerDir(statePath), "tested.json");
}

export function reviewedMarkerPath(statePath: string): string {
  return path.join(ticketMarkerDir(statePath), "reviewed.json");
}

export function manualTestedMarkerPath(statePath: string): string {
  return path.join(ticketMarkerDir(statePath), "manual-tested.json");
}

function ensureMarkerDir(statePath: string): string {
  const dir = ticketMarkerDir(statePath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMarker<T>(filePath: string, payload: T): void {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readMarker<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function hashTestOutput(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function writeTestedMarker(
  statePath: string,
  state: HarnessState,
  options: {
    outputContent: string;
    command?: string;
    passed?: boolean;
    logPath?: string;
    writtenBy?: string;
  },
): TestedMarker {
  ensureMarkerDir(statePath);
  const marker: TestedMarker = {
    version: MARKER_VERSION,
    ticketKey: state.ticketKey,
    timestamp: new Date().toISOString(),
    outputHash: hashTestOutput(options.outputContent),
    command: options.command,
    passed: options.passed !== false,
    logPath: options.logPath,
    writtenBy: options.writtenBy ?? "bfh_state:mark_tested",
  };
  writeMarker(testedMarkerPath(statePath), marker);
  return marker;
}

export function writeReviewedMarker(
  statePath: string,
  state: HarnessState,
  writtenBy = "bfh_state:verify_review",
): ReviewedMarker {
  const counts = getReviewCounts(state.review);
  ensureMarkerDir(statePath);
  const marker: ReviewedMarker = {
    version: MARKER_VERSION,
    ticketKey: state.ticketKey,
    timestamp: new Date().toISOString(),
    verdict: state.review.verdict,
    critical: counts.critical,
    warning: counts.warning,
    info: counts.info,
    stateUpdatedAt: state.updatedAt,
    writtenBy,
  };
  writeMarker(reviewedMarkerPath(statePath), marker);
  return marker;
}

export function writeManualTestedMarker(
  statePath: string,
  state: HarnessState,
  summary: string,
  writtenBy = "bfh_state:mark_manual_tested",
): ManualTestedMarker {
  ensureMarkerDir(statePath);
  const marker: ManualTestedMarker = {
    version: MARKER_VERSION,
    ticketKey: state.ticketKey,
    timestamp: new Date().toISOString(),
    summary: summary.trim() || "Manual verification recorded.",
    writtenBy,
  };
  writeMarker(manualTestedMarkerPath(statePath), marker);
  return marker;
}

export function readTestedMarker(statePath: string): TestedMarker | null {
  return readMarker<TestedMarker>(testedMarkerPath(statePath));
}

export function readReviewedMarker(statePath: string): ReviewedMarker | null {
  return readMarker<ReviewedMarker>(reviewedMarkerPath(statePath));
}

export function readManualTestedMarker(statePath: string): ManualTestedMarker | null {
  return readMarker<ManualTestedMarker>(manualTestedMarkerPath(statePath));
}

const SOURCE_LIKE = /\.(tsx?|jsx?|php|py|go|rs|java|rb|vue|svelte)$/i;

export function requiresManualTestedMarker(cwd: string): boolean {
  const touched = discoverTouchedFiles(cwd, 50);
  return touched.some((f) => SOURCE_LIKE.test(f.path));
}

function markerCountsMatchReview(marker: ReviewedMarker, review: HarnessReview): boolean {
  const counts = getReviewCounts(review);
  return marker.critical === counts.critical && marker.warning === counts.warning && marker.info === counts.info;
}

export function validateEvidenceMarkersForClose(
  cwd: string,
  statePath: string,
  state: HarnessState,
): string[] {
  const reasons: string[] = [];

  const tested = readTestedMarker(statePath);
  if (!tested) {
    reasons.push("missing filesystem marker: .pi/bfh/<ticket>/tested.json (use bfh_state mark_tested)");
  } else {
    if (tested.ticketKey !== state.ticketKey) {
      reasons.push(`tested.json ticketKey mismatch (${tested.ticketKey} vs ${state.ticketKey})`);
    }
    if (!tested.outputHash) reasons.push("tested.json missing outputHash");
    if (tested.passed === false) reasons.push("tested.json records passed=false");
  }

  const reviewed = readReviewedMarker(statePath);
  if (!reviewed) {
    reasons.push("missing filesystem marker: .pi/bfh/<ticket>/reviewed.json (run verify_review or mark_reviewed)");
  } else {
    if (reviewed.ticketKey !== state.ticketKey) {
      reasons.push(`reviewed.json ticketKey mismatch (${reviewed.ticketKey} vs ${state.ticketKey})`);
    }
    if (reviewed.critical > 0 && !state.review.allowCloseDespiteCritical) {
      reasons.push(`reviewed.json has critical=${reviewed.critical} (must be 0)`);
    }
    if (reviewed.verdict !== "approved") {
      reasons.push(`reviewed.json verdict is ${reviewed.verdict}, expected approved`);
    }
    if (!markerCountsMatchReview(reviewed, state.review)) {
      reasons.push("reviewed.json counts do not match state.review (re-run verify_review after state changes)");
    }
    if (reviewed.stateUpdatedAt !== state.updatedAt) {
      reasons.push("reviewed.json is stale relative to state.updatedAt (re-run verify_review)");
    }
  }

  if (requiresManualTestedMarker(cwd)) {
    const manual = readManualTestedMarker(statePath);
    if (!manual) {
      reasons.push(
        "missing filesystem marker: .pi/bfh/<ticket>/manual-tested.json (src-like files changed; use mark_manual_tested)",
      );
    }
  }

  return reasons;
}

export function resolveTestLogPath(cwd: string, logPath: string): string {
  return path.isAbsolute(logPath) ? logPath : path.resolve(cwd, logPath);
}
