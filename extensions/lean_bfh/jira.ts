import * as fs from "node:fs";
import {
  DEFAULT_JIRA_BASE_URL,
  JIRA_CONFIG_PATH,
  type JiraAuthMode,
  type JiraIssueSummary,
  type JiraStoredConfig,
} from "./types.ts";

type JiraApiJson = Record<string, unknown>;

type JiraAdfNode = {
  text?: string;
  content?: JiraAdfNode[];
};

type JiraIssueLink = {
  outwardIssue?: { key?: string };
  inwardIssue?: { key?: string };
  type?: { name?: string };
};

type JiraIssueFields = {
  summary?: string;
  issuetype?: { name?: string };
  status?: { name?: string };
  description?: unknown;
  labels?: unknown[];
  issuelinks?: JiraIssueLink[];
  [customFieldId: string]: unknown;
};

type JiraIssueResponse = {
  key?: string;
  fields?: JiraIssueFields;
};

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function readJiraConfigFile(): JiraStoredConfig {
  try {
    if (!fs.existsSync(JIRA_CONFIG_PATH)) return {};
    const raw = fs.readFileSync(JIRA_CONFIG_PATH, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as JiraStoredConfig) : {};
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

async function jiraFetch(restPath: string, init?: RequestInit): Promise<JiraApiJson> {
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
  const data = (text ? JSON.parse(text) : {}) as JiraApiJson & {
    errorMessages?: string[];
    message?: string;
  };
  if (!response.ok) {
    const errorMessages = Array.isArray(data.errorMessages) ? data.errorMessages.map(String) : [];
    const message = errorMessages.join("; ") || String(data.message ?? "") || text || `HTTP ${response.status}`;
    throw new Error(`Jira API error (${response.status}): ${message}`);
  }

  return data;
}

function jiraValueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const texts: string[] = [];
  const visit = (node: JiraAdfNode | string | null | undefined) => {
    if (!node) return;
    if (typeof node === "string") {
      texts.push(node);
      return;
    }
    if (typeof node === "object" && node && typeof node.text === "string") texts.push(node.text);
    if (typeof node === "object" && node && Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };
  visit(value as JiraAdfNode | string | null | undefined);
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

function customFieldIds(envKey: string): string[] {
  const raw = process.env[envKey]?.trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function extractLinkedTickets(issue: JiraIssueResponse): Array<{ key: string; type: string }> {
  const links = issue.fields?.issuelinks;
  if (!Array.isArray(links)) return [];

  const result: Array<{ key: string; type: string }> = [];
  for (const link of links) {
    const linked = link?.outwardIssue || link?.inwardIssue;
    if (!linked?.key) continue;
    result.push({ key: String(linked.key), type: String(link?.type?.name || "linked") });
  }
  return result;
}

export async function fetchIssue(issueKey: string): Promise<JiraIssueSummary> {
  const acFieldIds = customFieldIds("JIRA_ACCEPTANCE_FIELDS");
  const constraintFieldIds = customFieldIds("JIRA_CONSTRAINT_FIELDS");
  const fields = [
    "summary",
    "issuetype",
    "status",
    "description",
    "labels",
    "issuelinks",
    ...acFieldIds,
    ...constraintFieldIds,
  ].join(",");
  const issue = (await jiraFetch(
    `/issue/${encodeURIComponent(issueKey)}?fields=${fields}`,
  )) as JiraIssueResponse;
  const f = issue.fields ?? {};

  const acceptanceCriteriaExtras: string[] = [];
  for (const id of acFieldIds) {
    const text = jiraValueToText(f?.[id]);
    if (text) acceptanceCriteriaExtras.push(text);
  }

  const constraintsExtras: string[] = [];
  for (const id of constraintFieldIds) {
    const text = jiraValueToText(f?.[id]);
    if (text) constraintsExtras.push(text);
  }

  return {
    key: issue?.key ?? issueKey,
    title: String(f?.summary ?? ""),
    type: String(f?.issuetype?.name ?? ""),
    status: String(f?.status?.name ?? ""),
    description: jiraValueToText(f?.description),
    linkedTickets: extractLinkedTickets(issue),
    labels: Array.isArray(f?.labels) ? f.labels.map(String) : [],
    acceptanceCriteriaExtras,
    constraintsExtras,
  };
}
