import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type JiraAuthMode = "bearer" | "basic";

function getEnv(name: string, required = true): string | undefined {
  const value = process.env[name]?.trim();
  if (!value && required) throw new Error(`Missing env var: ${name}`);
  return value;
}

function getBaseUrl(): string {
  const raw = getEnv("JIRA_BASE_URL")!;
  return raw.replace(/\/+$/, "");
}

function getAuthHeader(): string {
  const mode = (process.env.JIRA_AUTH_MODE?.trim().toLowerCase() || "bearer") as JiraAuthMode;
  const token = getEnv("JIRA_TOKEN")!;

  if (mode === "basic") {
    const email = getEnv("JIRA_EMAIL")!;
    const encoded = Buffer.from(`${email}:${token}`).toString("base64");
    return `Basic ${encoded}`;
  }

  return `Bearer ${token}`;
}

async function jiraFetch(path: string, init?: RequestInit): Promise<any> {
  const url = `${getBaseUrl()}/rest/api/2${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: getAuthHeader(),
      ...(init?.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const msg =
      data?.errorMessages?.join("; ") ||
      data?.message ||
      text ||
      `HTTP ${response.status}`;
    throw new Error(`Jira API error (${response.status}): ${msg}`);
  }

  return data;
}

function toText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

const MINIMAL_ISSUE_FIELDS = [
  "summary",
  "issuetype",
  "status",
  "description",
  "created",
  "updated",
  "comment",
  "issuelinks",
] as const;

function formatDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 10) return null;
  return value.slice(0, 10);
}

function compactText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function toMinimalIssue(issue: any) {
  const fields = issue?.fields ?? {};
  const statusName = fields?.status?.name;
  const statusCategory = fields?.status?.statusCategory?.name;

  return {
    key: issue?.key,
    title: fields?.summary ?? "",
    type: fields?.issuetype?.name ?? "",
    status:
      statusName && statusCategory
        ? `${statusName} (${statusCategory})`
        : (statusName ?? ""),
    description: fields?.description ?? "",
    created: formatDate(fields?.created),
    updated: formatDate(fields?.updated),
    comments: Array.isArray(fields?.comment?.comments)
      ? fields.comment.comments.map((comment: any) => ({
          name: comment?.author?.displayName ?? comment?.author?.name ?? "",
          body: compactText(comment?.body, 300),
          created: formatDate(comment?.created),
        }))
      : [],
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

export default function jiraExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "jira_myself",
    label: "Jira Myself",
    description: "Get the current Jira user for the configured token",
    parameters: Type.Object({}),
    async execute() {
      const me = await jiraFetch("/myself");
      return {
        content: [{ type: "text", text: toText(me) }],
        details: me,
      };
    },
  });

  pi.registerTool({
    name: "jira_get_issue",
    label: "Jira Get Issue",
    description: "Get a Jira issue by key (minimal summary by default). Use full=true only if the user explicitly requests the raw/complete JSON payload.",
    parameters: Type.Object({
      issueKey: Type.String({ description: "Issue key, e.g. PROJ-123" }),
      fields: Type.Optional(Type.String({ description: "Comma-separated fields (used when full=true)" })),
      full: Type.Optional(Type.Boolean({ description: "Return full Jira JSON payload. Only use this if explicitly asked for 'full', 'raw' or 'all' details.", default: false })),
    }),
    async execute(_toolCallId, params: { issueKey: string; fields?: string; full?: boolean }) {
      const qs = new URLSearchParams();

      if (params.full) {
        if (params.fields?.trim()) qs.set("fields", params.fields.trim());
      } else {
        qs.set("fields", MINIMAL_ISSUE_FIELDS.join(","));
      }

      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const issue = await jiraFetch(`/issue/${encodeURIComponent(params.issueKey)}${suffix}`);

      if (params.full) {
        return {
          content: [{ type: "text", text: toText(issue) }],
          details: issue,
        };
      }

      const minimalIssue = toMinimalIssue(issue);
      return {
        content: [{ type: "text", text: toText(minimalIssue) }],
        details: minimalIssue,
      };
    },
  });

  pi.registerTool({
    name: "jira_search",
    label: "Jira Search",
    description: "Search Jira issues using JQL",
    parameters: Type.Object({
      jql: Type.String({ description: "JQL query string" }),
      maxResults: Type.Optional(Type.Number({ description: "Number of items (default 20)", default: 20 })),
      startAt: Type.Optional(Type.Number({ description: "Pagination offset (default 0)", default: 0 })),
      fields: Type.Optional(Type.String({ description: "Comma-separated fields" })),
    }),
    async execute(
      _toolCallId,
      params: { jql: string; maxResults?: number; startAt?: number; fields?: string },
    ) {
      const qs = new URLSearchParams({
        jql: params.jql,
        maxResults: String(params.maxResults ?? 20),
        startAt: String(params.startAt ?? 0),
      });
      if (params.fields?.trim()) qs.set("fields", params.fields.trim());

      const result = await jiraFetch(`/search?${qs.toString()}`);
      return {
        content: [{ type: "text", text: toText(result) }],
        details: result,
      };
    },
  });
}
