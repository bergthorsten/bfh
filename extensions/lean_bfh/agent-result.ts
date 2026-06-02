export const AGENT_RESULT_START = "<<<AGENT_RESULT";
export const AGENT_RESULT_END = "AGENT_RESULT>>>";

export type AgentResultStatus = "completed" | "failed" | "blocked";

export type ReviewerRubricCategory = {
  category: string;
  verdict: string;
  detail: string;
};

export type ReviewerRubric = {
  role: "reviewer";
  categories: ReviewerRubricCategory[];
};

export type ReviewerFindingDetail = {
  severity: "critical" | "warning" | "info";
  category?: string;
  principle?: string;
  message: string;
  file?: string;
  line?: number | null;
};

export type ReviewerFindingsEnvelope = {
  critical: number;
  warnings: number;
  info: number;
  details: ReviewerFindingDetail[];
};

export type ScoutFindingsEnvelope = {
  relevantFiles: Array<{ path: string; reason: string }>;
  patterns: Array<{ name: string; file?: string; description: string }>;
  commands?: string[];
  constraints: string[];
  testBaseline?: unknown;
  suggestedApproach?: string;
};

export type AgentResultArtifacts = {
  commit: string | null;
  filesChanged: string[];
  testsPassed: boolean | null;
  screenshotUrls: string[];
  evidenceMarkers: string[];
  prUrl: string | null;
  prNumber: number | null;
};

export type ParsedAgentResult = {
  status: AgentResultStatus;
  summary: string;
  findings: unknown;
  rubric?: ReviewerRubric;
  artifacts: AgentResultArtifacts;
  error: string | null;
  /** Set when delimiters or JSON could not be parsed. */
  parseError: string | null;
};

const DEFAULT_ARTIFACTS: AgentResultArtifacts = {
  commit: null,
  filesChanged: [],
  testsPassed: null,
  screenshotUrls: [],
  evidenceMarkers: [],
  prUrl: null,
  prNumber: null,
};

function syntheticFailed(parseError: string): ParsedAgentResult {
  return {
    status: "failed",
    summary: "",
    findings: undefined,
    artifacts: { ...DEFAULT_ARTIFACTS },
    error: parseError,
    parseError,
  };
}

/**
 * Extract and validate an AGENT_RESULT JSON block from raw subagent output.
 * Uses lastIndexOf for the start delimiter so preamble discussion does not win.
 * Never throws.
 */
export function parseAgentResult(raw: string): ParsedAgentResult {
  const startIdx = raw.lastIndexOf(AGENT_RESULT_START);
  if (startIdx === -1) {
    return syntheticFailed("AGENT_RESULT start delimiter not found");
  }

  const afterStart = startIdx + AGENT_RESULT_START.length;
  const endIdx = raw.indexOf(AGENT_RESULT_END, afterStart);
  if (endIdx === -1) {
    return syntheticFailed("AGENT_RESULT end delimiter not found");
  }

  const jsonText = raw.slice(afterStart, endIdx).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return syntheticFailed(`AGENT_RESULT JSON parse error: ${msg}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return syntheticFailed("AGENT_RESULT is not a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  const statusRaw = obj.status;
  if (typeof statusRaw !== "string" || !["completed", "failed", "blocked"].includes(statusRaw)) {
    return syntheticFailed(`AGENT_RESULT invalid status: ${String(statusRaw)}`);
  }

  const artifactsRaw =
    typeof obj.artifacts === "object" && obj.artifacts !== null
      ? (obj.artifacts as Record<string, unknown>)
      : {};

  const artifacts: AgentResultArtifacts = {
    commit: typeof artifactsRaw.commit === "string" ? artifactsRaw.commit : null,
    filesChanged: Array.isArray(artifactsRaw.filesChanged)
      ? artifactsRaw.filesChanged.filter((v): v is string => typeof v === "string")
      : [],
    testsPassed: typeof artifactsRaw.testsPassed === "boolean" ? artifactsRaw.testsPassed : null,
    screenshotUrls: Array.isArray(artifactsRaw.screenshotUrls)
      ? artifactsRaw.screenshotUrls.filter((v): v is string => typeof v === "string")
      : [],
    evidenceMarkers: Array.isArray(artifactsRaw.evidenceMarkers)
      ? artifactsRaw.evidenceMarkers.filter((v): v is string => typeof v === "string")
      : [],
    prUrl: typeof artifactsRaw.prUrl === "string" ? artifactsRaw.prUrl : null,
    prNumber: typeof artifactsRaw.prNumber === "number" ? artifactsRaw.prNumber : null,
  };

  return {
    status: statusRaw as AgentResultStatus,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    findings: obj.findings,
    rubric: parseRubric(obj.rubric),
    artifacts,
    error: typeof obj.error === "string" ? obj.error : null,
    parseError: null,
  };
}

function parseRubric(raw: unknown): ReviewerRubric | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.role !== "reviewer") return undefined;
  if (!Array.isArray(obj.categories)) return undefined;
  const categories = obj.categories
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      category: typeof item.category === "string" ? item.category : "unknown",
      verdict: typeof item.verdict === "string" ? item.verdict : "na",
      detail: typeof item.detail === "string" ? item.detail : "",
    }));
  return { role: "reviewer", categories };
}

export function agentResultParsedOk(result: ParsedAgentResult): boolean {
  return result.parseError === null;
}
