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

export function runRetro(
  cwd: string,
  statePath: string,
  state: HarnessState,
  options?: { learning?: string; amendmentSummary?: string },
): RetroResult {
  const ticketKey = ticketKeyFromStatePath(statePath);
  const learning =
    options?.learning?.trim() ||
    (state.retroNotes.length ? state.retroNotes.join("; ") : `Completed ${ticketKey}: ${state.summary}`);

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
    amendmentPath = path.join(amendmentsDir, `${date}-${slugify(ticketKey)}.md`);
    if (!fs.existsSync(amendmentPath)) {
      fs.writeFileSync(
        amendmentPath,
        [
          `# Harness amendment proposal — ${ticketKey}`,
          "",
          `Date: ${date}`,
          "",
          "## Summary",
          amendmentSummary,
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

  fs.mkdirSync(ticketMarkerDir(statePath), { recursive: true });
  return { learningsPath, amendmentPath, appendedLearning, createdAmendment };
}
