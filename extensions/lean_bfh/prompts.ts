import type { HarnessState } from "./types.ts";
import { readBriefMissionSummary, briefPathFor } from "./brief.ts";
import { formatWorkingMemoryForPrompt, readWorkingMemory } from "./working-memory.ts";
import { harnessReadmePath } from "./harness-docs.ts";

function shortDescription(text: string, max = 3500): string {
  const compact = text.replace(/\r/g, "").trim();
  if (compact.length <= max) return compact || "(No Jira description provided.)";
  return `${compact.slice(0, max)}\n\n… [description truncated in prompt; full text is in state file]`;
}

function logDirHint(statePath: string): string {
  const ticketDir = statePath.replace(/\.state\.json$/, "");
  return `${ticketDir}/logs/`;
}

function implementerDisciplineBlock(statePath: string): string[] {
  const logs = logDirHint(statePath);
  return [
    "Implementer discipline:",
    `- Redirect test/build output to \`${logs}*.log\`; record summaries + log paths in \`bfh_state\` evidence (not raw stdout).`,
    "- On a failed approach: `git reset --hard` to the last good commit before retrying — do not stack broken commits.",
    "- Use small WIP commits per attempt; squash or clean up before close if your team expects a single commit.",
    "- Do not edit `.pi/bfh/**/tested.json`, `reviewed.json`, or other harness marker files by hand.",
  ];
}

export function createKickoffPrompt(statePath: string, state: HarnessState, cwd: string): string {
  const briefPath = briefPathFor(statePath);
  const mapPath = harnessReadmePath(cwd);

  return [
    `Start the lean BFH POC for ${state.ticketKey}.`,
    "",
    "You are the implementer/orchestrator inside a deterministic Pi-native workflow.",
    "Keep the state file current by using `bfh_state` after each phase.",
    "Do not skip the verify/review gate. Do not exceed two revision cycles.",
    "Prefer short summaries and log paths over raw command output.",
    "",
    "Mission brief (read first):",
    briefPath,
    "",
    "Harness map:",
    mapPath,
    "",
    "State file:",
    statePath,
    "",
    "Ticket:",
    `- Key: ${state.ticketKey}`,
    `- Summary: ${state.summary}`,
    `- Labels: ${state.labels.join(", ") || "(none)"}`,
    state.linkedTickets.length
      ? `- Linked: ${state.linkedTickets.map((t) => `${t.key} (${t.type})`).join(", ")}`
      : "- Linked: (none)",
    "",
    "Description:",
    shortDescription(state.description),
    "",
    "Acceptance criteria extracted so far:",
    ...(state.acceptanceCriteria.length
      ? state.acceptanceCriteria.map((item) => `- ${item}`)
      : ["- (none extracted; derive from ticket or ask targeted questions)"]),
    "",
    ...implementerDisciplineBlock(statePath),
    "",
    "Required phase contract:",
    "1. `bfh_state` action `advance` to `scout`, then gather concise advisory context: likely files, commands, patterns, constraints. Use `scout_auto` for automated subagent recon or patch `scout` manually.",
    "2. If there are real decision points, advance to `clarify`, ask the user targeted questions, and patch `openQuestions` with answers via `bfh_state` action `question`. Otherwise advance directly to `implement`.",
    "3. In `implement`, write a short plan, make the smallest safe change, run focused checks with output redirected to logs, and record evidence with action `evidence`.",
    "4. Advance to `verify_review`. Run tests, save log, `mark_tested`, then `verify_review` (or `/bfh-verify`).",
    "5. If the gate requests a fix and revision budget remains, action `advance` back to `implement` and address only the findings. The state tool increments the revision count automatically. Otherwise continue.",
    "6. Advance to `close` only when review is approved. Use `mark_tested` + `verify_review`, then `close_create` (or `/bfh-close`) — this moves to `pr_review`.",
    "7. In `pr_review`, run `pr_sync` or `/bfh-pr-sync` after colleagues review on GitHub. APPROVED → `retro`; CHANGES_REQUESTED → `implement` (re-verify, then close again).",
    "8. In `retro`, use `retro_run` or `/bfh-retro`, append `LEARNINGS.md`, then advance to `done` only when PR is approved (or explicit `pr.allowDoneWithoutPrApproval`).",
    "",
    "Stop and report if blocked. Keep this POC lean; avoid inventing extra process.",
  ].join("\n");
}

export function createResumePrompt(statePath: string, state: HarnessState, cwd: string): string {
  const mission = readBriefMissionSummary(statePath);
  const memoryBlock = formatWorkingMemoryForPrompt(readWorkingMemory(statePath));

  return [
    `Resume the lean BFH run for ${state.ticketKey}.`,
    "",
    ...(mission ? ["Mission:", mission, ""] : []),
    `Current step: ${state.currentStep}`,
    `Revision budget: ${state.revisionCount}/${state.revisionLimit}`,
    `State file: ${statePath}`,
    `Brief: ${briefPathFor(statePath)}`,
    `Harness map: ${harnessReadmePath(cwd)}`,
    "",
    ...(memoryBlock ? [memoryBlock, ""] : []),
    "First call `bfh_state` with action `read` to load the current state.",
    "Then continue from the current step using the same phase contract:",
    "scout → clarify? → implement → verify_review → close → pr_review → retro → done.",
    "",
    ...implementerDisciplineBlock(statePath),
    "",
    "Use `bfh_state` action `diff_context` during verify_review to get compact touched-file context.",
    "Do not skip review, and do not attempt another repair loop if the revision budget is exhausted.",
  ].join("\n");
}

export const KICKOFF_EDITOR_HINT =
  "\n\n---\nAdd context below (@files, notes). Press Enter to start. Use `/bfh --go` to skip this step.\n";
