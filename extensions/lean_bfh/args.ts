import type { HarnessStartArgs } from "./types.ts";

export function normalizeIssueKey(raw: string): string {
  return raw.trim().toUpperCase();
}

export function parseHarnessStartArgs(raw: string): HarnessStartArgs {
  const tokens = raw.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  const noJira = tokens.includes("--no-jira") || tokens.includes("-n");
  const autoGo = tokens.includes("--go") || tokens.includes("-g");
  const issueToken = tokens.find((t) => !t.startsWith("-")) || "";
  return { issueKey: normalizeIssueKey(issueToken), noJira, autoGo };
}
