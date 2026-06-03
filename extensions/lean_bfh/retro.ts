import * as fs from "node:fs";
import * as path from "node:path";
import { ticketKeyFromStatePath, ticketMarkerDir } from "./evidence-markers.ts";
import { stateDirFor } from "./state.ts";
import type { HarnessState } from "./types.ts";

export type RetroResult = {
  learningsPath: string;
  amendmentPath?: string;
  appendedLearning: boolean;
  createdAmendment: boolean;
};

type RetroPriority = "high" | "medium" | "low";
type RetroSignal = {
  priority: RetroPriority;
  detail: string;
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function dedupeAppendLine(filePath: string, line: string): boolean {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${line}\n`, "utf8");
    return true;
  }
  const existing = fs.readFileSync(filePath, "utf8");
  if (existing.includes(line)) return false;
  fs.appendFileSync(filePath, `${existing.endsWith("\n") ? "" : "\n"}${line}\n`, "utf8");
  return true;
}

function hasPassingTestEvidence(state: HarnessState): boolean {
  return state.evidence.some((entry) => entry.type === "test" && entry.passed === true);
}

function deriveRetroSignals(state: HarnessState): RetroSignal[] {
  const signals: RetroSignal[] = [];

  if (!hasPassingTestEvidence(state)) {
    signals.push({
      priority: "high",
      detail: "No passing automated test evidence recorded during this run.",
    });
  }

  if (state.revisionCount > 0) {
    signals.push({
      priority: state.revisionCount >= state.revisionLimit ? "high" : "medium",
      detail: `Repair loop was used ${state.revisionCount} time(s) before close/readiness.`,
    });
  }

  if (state.review.counts.critical > 0) {
    signals.push({
      priority: "high",
      detail: `${state.review.counts.critical} critical review finding(s) appeared in verify_review.`,
    });
  }

  if (state.review.counts.warning > 0) {
    signals.push({
      priority: "low",
      detail: `${state.review.counts.warning} warning-level review finding(s) remained.`,
    });
  }

  if ((state.pr.externalRevisionCount ?? 0) > 0 || state.pr.reviewDecision === "CHANGES_REQUESTED") {
    signals.push({
      priority: "medium",
      detail: `GitHub PR review requested changes ${state.pr.externalRevisionCount ?? 0} time(s).`,
    });
  }

  return signals;
}

function buildAutoLearning(ticketKey: string, state: HarnessState, signals: RetroSignal[]): string {
  if (signals.length === 0) return `Completed ${ticketKey}: ${state.summary}`;
  return signals
    .slice(0, 3)
    .map((signal) => signal.detail)
    .join(" ");
}

function inferPriority(summary: string, signals: RetroSignal[]): RetroPriority {
  if (signals.some((signal) => signal.priority === "high")) return "high";
  if (/critical|fail|blocked|regression|security|secret|broken|timeout/i.test(summary)) return "high";
  if (signals.some((signal) => signal.priority === "medium")) return "medium";
  return "low";
}

function inferTargetArea(summary: string): string {
  if (/scout/i.test(summary)) return "agents/scout.md";
  if (/review|verify/i.test(summary)) return "agents/reviewer.md";
  if (/close|pr|github/i.test(summary)) return "extensions/lean_bfh/close.ts";
  return "extensions/lean_bfh/tool.ts";
}

function findExistingAmendmentBySummary(amendmentsDir: string, date: string, summarySlug: string): string | undefined {
  if (!summarySlug || !fs.existsSync(amendmentsDir)) return undefined;
  const prefix = `${date}-`;
  const suffix = `-${summarySlug}.md`;
  return fs
    .readdirSync(amendmentsDir)
    .find((name) => name.startsWith(prefix) && name.endsWith(suffix));
}

function compactSignalSummary(signals: RetroSignal[]): string {
  if (signals.length === 0) return "No significant run signals detected.";
  return signals
    .slice(0, 2)
    .map((signal) => `${signal.priority}: ${signal.detail}`)
    .join(" | ");
}

export function runRetro(
  cwd: string,
  statePath: string,
  state: HarnessState,
  options?: { learning?: string; amendmentSummary?: string },
): RetroResult {
  const ticketKey = ticketKeyFromStatePath(statePath);
  const signals = deriveRetroSignals(state);
  const learning =
    options?.learning?.trim() ||
    (state.retroNotes.length ? state.retroNotes.join("; ") : buildAutoLearning(ticketKey, state, signals));

  const learningsPath = path.join(cwd, "LEARNINGS.md");
  const bullet = `- ${new Date().toISOString().slice(0, 10)} **${ticketKey}**: ${learning}`;
  const appendedLearning = dedupeAppendLine(learningsPath, bullet);

  let amendmentPath: string | undefined;
  let createdAmendment = false;
  const amendmentSummary = options?.amendmentSummary?.trim();

  if (amendmentSummary) {
    const amendmentsDir = path.join(stateDirFor(cwd), "amendments");
    fs.mkdirSync(amendmentsDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const ticketSlug = slugify(ticketKey);
    const summarySlug = slugify(amendmentSummary);

    const existing = findExistingAmendmentBySummary(amendmentsDir, date, summarySlug);
    if (existing) {
      amendmentPath = path.join(amendmentsDir, existing);
    } else {
      amendmentPath = path.join(amendmentsDir, `${date}-${ticketSlug}-${summarySlug || "amendment"}.md`);
      if (!fs.existsSync(amendmentPath)) {
        const priority = inferPriority(amendmentSummary, signals);
        const targetArea = inferTargetArea(amendmentSummary);
        fs.writeFileSync(
          amendmentPath,
          [
            `# Harness amendment proposal — ${ticketKey}`,
            "",
            `Date: ${date}`,
            `Priority: ${priority}`,
            `Triggered by: ${ticketKey} — ${compactSignalSummary(signals)}`,
            `Target area: ${targetArea}`,
            "",
            "## Summary",
            amendmentSummary,
            "",
            "## Proposed change",
            "Describe the smallest concrete harness/prompt/doc change to apply.",
            "",
            "## Rationale",
            "Explain why this change reduces repeat failures or review churn.",
            "",
            "## Status",
            "Staged for human review — do not auto-apply to the extension.",
            "",
          ].join("\n"),
          "utf8",
        );
        createdAmendment = true;
      }
    }
  }

  fs.mkdirSync(ticketMarkerDir(statePath), { recursive: true });
  return { learningsPath, amendmentPath, appendedLearning, createdAmendment };
}
