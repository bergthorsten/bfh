import { loadBfhConfig, resolveJiraConfigPath } from "./bfh-config.ts";
import type { JiraIssueSummary } from "./types.ts";

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

function getAuthHeader(cwd: string): string {
  const { jira } = loadBfhConfig(cwd);
  const token = jira.token;
  if (!token) {
    throw new Error(`Missing Jira token. Set JIRA_TOKEN or add jira.token to ${resolveJiraConfigPath(cwd)}.`);
  }

  if (jira.authMode === "basic") {
    if (!jira.email) throw new Error("Missing jira.email (or JIRA_EMAIL) for basic Jira auth mode.");
    return `Basic ${Buffer.from(`${jira.email}:${token}`).toString("base64")}`;
  }

  return `Bearer ${token}`;
}

async function jiraFetch(cwd: string, restPath: string, init?: RequestInit): Promise<JiraApiJson> {
  const { jira } = loadBfhConfig(cwd);
  const response = await fetch(`${jira.baseUrl}/rest/api/2${restPath}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: getAuthHeader(cwd),
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

export async function fetchIssue(issueKey: string, cwd: string): Promise<JiraIssueSummary> {
  const { jira } = loadBfhConfig(cwd);
  const fields = [
    "summary",
    "issuetype",
    "status",
    "description",
    "labels",
    "issuelinks",
    ...jira.acceptanceFields,
    ...jira.constraintFields,
  ].join(",");
  const issue = (await jiraFetch(
    cwd,
    `/issue/${encodeURIComponent(issueKey)}?fields=${fields}`,
  )) as JiraIssueResponse;
  const f = issue.fields ?? {};

  const acceptanceCriteriaExtras: string[] = [];
  for (const id of jira.acceptanceFields) {
    const text = jiraValueToText(f?.[id]);
    if (text) acceptanceCriteriaExtras.push(text);
  }

  const constraintsExtras: string[] = [];
  for (const id of jira.constraintFields) {
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
