import type { HarnessState } from "./types.ts";
import { readBriefMissionSummary, briefPathFor } from "./brief.ts";
import { formatWorkingMemoryForPrompt, readWorkingMemory } from "./working-memory.ts";

function shortDescription(text: string, max = 3500): string {
  const compact = text.replace(/\r/g, "").trim();
  if (compact.length <= max) return compact || "(No Jira description provided.)";
  return `${compact.slice(0, max)}\n\n… [description truncated in prompt; full text is in state file]`;
}

function jiraRequestSummary(state: HarnessState): string {
  if (state.acceptanceCriteria.length === 0) return shortDescription(state.description);

  const lines = state.description.replace(/\r/g, "").split("\n");
  const acceptanceStart = lines.findIndex((line) => /acceptance|akzeptanz|definition of done/i.test(line));
  if (acceptanceStart <= 0) return shortDescription(state.description);

  return shortDescription(lines.slice(0, acceptanceStart).join("\n"));
}

function logDirHint(statePath: string): string {
  const ticketDir = statePath.replace(/\.state\.json$/, "");
  return `${ticketDir}/logs/`;
}

function deliveryGuidelinesBlock(statePath: string): string[] {
  const logs = logDirHint(statePath);
  return [
    "Delivery guidelines:",
    "- You own this production change end-to-end: understand the request, deliver the smallest safe change, verify it, and keep BFH state accurate.",
    "- This may be a fix, a feature, or an improvement. Do not assume it is only bug fixing.",
    "- Write clean, modern, simple-to-understand code. Keep the change radius small.",
    "- Small refactors are acceptable only when they clearly reduce risk or make the requested change simpler now; avoid broad cleanup.",
    `- Redirect test/build output to \`${logs}*.log\`; record summaries + log paths in \`bfh_state\` evidence, not raw stdout.`,
    "- On a failed approach: `git reset --hard` to the last good commit before retrying — do not stack broken commits.",
    "- Do not edit `.pi/bfh/**/tested.json`, `reviewed.json`, or other harness marker files by hand.",
  ];
}

export function createKickoffPrompt(statePath: string, state: HarnessState, _cwd: string): string {
  const briefPath = briefPathFor(statePath);

  return [
    `Work on ${state.ticketKey} using the BFH workflow.`,
    "",
    `Run mode: ${state.human.autonomous ? "autonomous (internal human checkpoints disabled)" : "human-in-loop checkpoints enabled"}.`,
    "Keep the state file current with `bfh_state`. Do not skip testing or the verify/review gate.",
    "",
    "Ticket:",
    `${state.ticketKey} — ${state.summary}`,
    "",
    ...(state.labels.length ? ["Labels:", state.labels.join(", "), ""] : []),
    ...(state.linkedTickets.length
      ? ["Linked tickets:", state.linkedTickets.map((t) => `- ${t.key} (${t.type})`).join("\n"), ""]
      : []),
    "Request from Jira:",
    jiraRequestSummary(state),
    "",
    "Acceptance criteria:",
    ...(state.acceptanceCriteria.length
      ? state.acceptanceCriteria.map((item) => `- ${item}`)
      : ["- No acceptance criteria were extracted automatically; derive them from the Jira request or ask targeted questions."]),
    "",
    ...(state.constraints.length ? ["Known constraints:", ...state.constraints.map((item) => `- ${item}`), ""] : []),
    "Context:",
    `- Brief: ${briefPath}`,
    `- State: ${statePath}`,
    "",
    ...deliveryGuidelinesBlock(statePath),
    "",
    "Workflow expectations:",
    "1. Start with scout: identify relevant files, existing patterns, checks, and risks.",
    "2. Clarify only if a real decision blocks implementation. In human-in-loop mode, record required decisions with `human_gate`.",
    "3. Implement the smallest safe change with a short plan.",
    "4. Run focused checks, save logs, and record evidence with `bfh_state`.",
    "5. Run `mark_tested` and `verify_review` before close. If review finds issues, fix only those issues within the revision budget.",
    "6. Close only after review approval and required human pre-close approval. Then continue through PR review and retro as directed by the BFH state.",
    "",
    "Stop and report if blocked. Keep the workflow lean; avoid inventing extra process.",
  ].join("\n");
}

export function createResumePrompt(statePath: string, state: HarnessState, _cwd: string): string {
  const mission = readBriefMissionSummary(statePath);
  const memoryBlock = formatWorkingMemoryForPrompt(readWorkingMemory(statePath));

  return [
    `Resume the BFH workflow for ${state.ticketKey}.`,
    "",
    ...(mission ? ["Mission:", mission, ""] : []),
    `Current step: ${state.currentStep}`,
    `Revision budget: ${state.revisionCount}/${state.revisionLimit}`,
    `State file: ${statePath}`,
    `Brief: ${briefPathFor(statePath)}`,
    "",
    ...(memoryBlock ? [memoryBlock, ""] : []),
    "First call `bfh_state` with action `read` to load the current state.",
    "Then continue from the current step: scout → clarify? → implement → verify_review → close → pr_review → retro → done.",
    "",
    ...deliveryGuidelinesBlock(statePath),
    "",
    "Use `bfh_state` action `diff_context` during verify_review to get compact touched-file context.",
    "Do not skip review, and do not attempt another repair loop if the revision budget is exhausted.",
  ].join("\n");
}

export const KICKOFF_EDITOR_HINT =
  "\n\n---\nAdd context below (@files, notes). Press Enter to start. Use `/bfh --go` to skip this step.\n";
