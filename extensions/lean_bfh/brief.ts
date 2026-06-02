import * as fs from "node:fs";
import * as path from "node:path";
import { ticketKeyFromStatePath } from "./evidence-markers.ts";
import type { HarnessState } from "./types.ts";

export function briefPathFor(statePath: string): string {
  const ticketKey = ticketKeyFromStatePath(statePath);
  const dir = path.dirname(statePath);
  return path.join(dir, `${ticketKey}.brief.md`);
}

function formatMissionBlock(state: HarnessState, repoLabel: string): string {
  const doneWhen =
    state.acceptanceCriteria.length > 0
      ? state.acceptanceCriteria.slice(0, 3).join("; ")
      : "Review approved, tests pass, draft PR opened.";
  return [
    "> **Mission:** " + (state.summary || state.ticketKey),
    "> **Ticket:** " + state.ticketKey,
    "> **Repo:** " + repoLabel,
    "> **Done when:** " + doneWhen,
  ].join("\n");
}

export function createBrief(statePath: string, state: HarnessState, cwd: string): string {
  const filePath = briefPathFor(statePath);
  if (fs.existsSync(filePath)) return filePath;

  const repoLabel = path.basename(cwd) || cwd;
  const acLines = state.acceptanceCriteria.length
    ? state.acceptanceCriteria.map((item) => `- ${item}`)
    : ["- (derive from ticket or clarify with user)"];

  const body = [
    formatMissionBlock(state, repoLabel),
    "",
    `# ${state.ticketKey}: ${state.summary || "BFH run"}`,
    "",
    "## Acceptance criteria",
    ...acLines,
    "",
    "## Progress log",
    "",
    `### ${new Date().toISOString().slice(0, 10)} — intake`,
    "- Harness started.",
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}

export function readBriefMissionSummary(statePath: string): string | undefined {
  const filePath = briefPathFor(statePath);
  if (!fs.existsSync(filePath)) return undefined;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const block: string[] = [];
  for (const line of lines) {
    if (line.startsWith("> ")) {
      block.push(line.slice(2));
      continue;
    }
    if (block.length > 0) break;
  }
  return block.length ? block.join("\n") : undefined;
}

export function appendBriefProgress(statePath: string, phase: string, summary: string): void {
  const filePath = briefPathFor(statePath);
  if (!fs.existsSync(filePath)) return;

  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const entry = [`### ${stamp} — ${phase}`, `- ${summary.trim() || "(no summary)"}`, ""].join("\n");
  fs.appendFileSync(filePath, entry, "utf8");
}

export function readBriefExcerpt(statePath: string, maxChars = 2000): string | undefined {
  const filePath = briefPathFor(statePath);
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n\n… [brief truncated; full file: ${filePath}]`;
}
