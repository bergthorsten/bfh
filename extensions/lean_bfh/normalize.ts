import type { HarnessFinding, HarnessReview, HarnessState } from "./types.ts";
import {
  agentResultParsedOk,
  parseAgentResult,
  type ParsedAgentResult,
  type ReviewerFindingDetail,
  type ReviewerFindingsEnvelope,
  type ScoutFindingsEnvelope,
} from "./agent-result.ts";
import { buildReviewResult } from "./review.ts";

export function buildScoutInput(state: HarnessState, scoutFocus?: string): string {
  return [
    `Ticket: ${state.ticketKey}`,
    `Summary: ${state.summary}`,
    state.description ? `Description: ${state.description}` : undefined,
    state.acceptanceCriteria.length
      ? `Acceptance Criteria:\n${state.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
      : undefined,
    state.constraints.length
      ? `Known Constraints:\n${state.constraints.map((item) => `- ${item}`).join("\n")}`
      : undefined,
    scoutFocus ? `Extra Scout Focus: ${scoutFocus}` : undefined,
  ]
    .filter((v): v is string => Boolean(v))
    .join("\n\n");
}

export function shouldRetryAgentParse(rawText: string): boolean {
  return !agentResultParsedOk(parseAgentResult(rawText));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated)`;
}

function mapReviewerDetail(detail: ReviewerFindingDetail): HarnessFinding {
  const principleRef =
    typeof detail.principle === "string" && detail.principle.trim() ? detail.principle.trim() : undefined;
  return {
    severity: detail.severity,
    category: detail.category || detail.principle || "review",
    message: detail.message,
    file: detail.file,
    line: typeof detail.line === "number" ? detail.line : undefined,
    principleRef,
  };
}

export function normalizeScoutFromAgentResult(envelope: ParsedAgentResult, fallbackText: string): HarnessState["scout"] {
  const empty: HarnessState["scout"] = {
    relevantFiles: [],
    patterns: [],
    commands: [],
    constraints: [],
    summary: "",
  };

  if (!agentResultParsedOk(envelope)) {
    return normalizeScoutFromTextLegacy(fallbackText);
  }

  const findings = envelope.findings as ScoutFindingsEnvelope | undefined;
  if (!findings || typeof findings !== "object") {
    const summary =
      envelope.summary ||
      envelope.error ||
      (envelope.status === "failed" ? "Scout failed without structured findings." : "Scout returned no findings object.");
    return { ...empty, summary };
  }

  const relevantFiles = Array.isArray(findings.relevantFiles)
    ? findings.relevantFiles
        .filter((item) => item && typeof item.path === "string")
        .slice(0, 15)
        .map((item) => ({
          path: String(item.path).trim(),
          reason:
            typeof item.reason === "string" && item.reason.trim()
              ? item.reason.trim()
              : "Relevant to ticket scope",
        }))
    : [];

  const patterns = Array.isArray(findings.patterns)
    ? findings.patterns
        .filter((item) => item && typeof item.name === "string" && typeof item.description === "string")
        .slice(0, 8)
        .map((item) => ({
          name: String(item.name).trim(),
          file: typeof item.file === "string" && item.file.trim() ? item.file.trim() : undefined,
          description: String(item.description).trim(),
        }))
    : [];

  const commands = Array.isArray(findings.commands)
    ? findings.commands
        .filter((item) => typeof item === "string" && item.trim())
        .slice(0, 20)
        .map((item) => item.trim())
    : [];

  const constraints = Array.isArray(findings.constraints)
    ? findings.constraints
        .filter((item) => typeof item === "string" && item.trim())
        .slice(0, 20)
        .map((item) => item.trim())
    : [];

  const summary =
    envelope.summary?.trim() ||
    (typeof findings.suggestedApproach === "string" ? findings.suggestedApproach.trim() : "") ||
    (relevantFiles.length > 0 ? `Found ${relevantFiles.length} relevant file(s).` : "Scout completed.");

  return { relevantFiles, patterns, commands, constraints, summary: truncate(summary, 2000) };
}

export function normalizeReviewFromAgentResult(
  envelope: ParsedAgentResult,
  fallbackText: string,
): HarnessReview {
  if (!agentResultParsedOk(envelope)) {
    return normalizeMalformedReview(fallbackText, envelope.parseError ?? undefined);
  }

  const findingsEnv = envelope.findings as ReviewerFindingsEnvelope | undefined;
  const details = Array.isArray(findingsEnv?.details) ? findingsEnv.details : [];

  const findings: HarnessFinding[] = details
    .filter((item) => item && typeof item.message === "string")
    .slice(0, 40)
    .map(mapReviewerDetail);

  const criticalFromDetails = findings.filter((f) => f.severity === "critical").length;
  const criticalCount =
    typeof findingsEnv?.critical === "number" ? Math.max(findingsEnv.critical, criticalFromDetails) : criticalFromDetails;

  let verdict: HarnessReview["verdict"] = "approved";
  if (envelope.status === "failed") {
    verdict = "failed";
  } else if (envelope.status === "blocked" || criticalCount > 0) {
    verdict = "needs_revision";
  }

  const summary = envelope.summary?.trim()
    ? truncate(envelope.summary.trim(), 3000)
    : fallbackText.trim()
      ? truncate(fallbackText.trim(), 3000)
      : "Review completed.";

  return buildReviewResult({
    verdict,
    findings,
    summary,
    rubric: envelope.rubric,
  });
}

export function normalizeScoutFromText(scoutText: string): HarnessState["scout"] {
  const envelope = parseAgentResult(scoutText);
  if (agentResultParsedOk(envelope)) {
    return normalizeScoutFromAgentResult(envelope, scoutText);
  }
  return normalizeScoutFromTextLegacy(scoutText);
}

export function normalizeReviewFromText(reviewText: string): HarnessReview {
  const envelope = parseAgentResult(reviewText);
  if (agentResultParsedOk(envelope)) {
    return normalizeReviewFromAgentResult(envelope, reviewText);
  }
  return normalizeMalformedReview(reviewText, envelope.parseError ?? undefined);
}

function normalizeMalformedReview(reviewText: string, parseError?: string): HarnessReview {
  const text = reviewText.trim();
  const summary = text
    ? `Reviewer output did not contain a valid AGENT_RESULT block and cannot be used as approval.\n\n${truncate(text, 2500)}`
    : "Reviewer returned no content and cannot be used as approval.";

  return buildReviewResult({
    verdict: "failed",
    findings: [{
      severity: "critical",
      category: "agent-protocol",
      message: parseError ? `Reviewer protocol error: ${parseError}` : "Reviewer output was not valid AGENT_RESULT.",
    }],
    summary: truncate(summary, 3000),
  });
}

function normalizeScoutFromTextLegacy(scoutText: string): HarnessState["scout"] {
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

  const parseJsonCandidate = (candidate: string): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(candidate);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const parsed = parseJsonCandidate(text) || (fenced ? parseJsonCandidate(fenced) : undefined);

  if (parsed && typeof parsed === "object") {
    return normalizeScoutFromAgentResult(
      {
        status: "completed",
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        findings: parsed,
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
        parseError: null,
      },
      text,
    );
  }

  const commands = Array.from(
    new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .map((line) => line.match(/`([^`]+)`/)?.[1] || "")
        .filter((line) =>
          /^(rg|grep|find|ls|git|npm|pnpm|yarn|node|bun|pytest|go\s+test|cargo\s+test)\b/.test(line),
        ),
    ),
  ).slice(0, 12);

  return {
    relevantFiles: [],
    patterns: [],
    commands,
    constraints: [],
    summary: truncate(text, 2000),
  };
}

