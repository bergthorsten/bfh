import type { GitEntryMode, HarnessState } from "./types.ts";
import { difficultyLabel } from "./difficulty.ts";
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

function difficultyRunModeBlock(state: HarnessState): string[] {
  const lines = [
    `Difficulty: level ${state.difficulty} — ${difficultyLabel(state.difficulty)}`,
  ];
  if (state.implementModelHint) {
    lines.push(`Suggested implementer model: ${state.implementModelHint}`);
  }
  return lines;
}

function gitContextBlock(state: HarnessState): string[] {
  return [
    "Git:",
    `- Branch: ${state.git.branch}`,
    `- Base: ${state.git.baseBranch}`,
    `- Entry mode: ${state.git.entryMode}`,
  ];
}

function entryModeExpectationsBlock(entryMode: GitEntryMode): string[] {
  switch (entryMode) {
    case "adopt-continue":
      return [
        "Existing branch work detected — continue implementation:",
        "- Treat scout as recon: map what is already done vs what remains.",
        "- Do not rewrite working code unless required for the ticket.",
        "- Build on existing commits; keep the change radius small.",
      ];
    case "adopt-verify":
      return [
        "Existing branch work detected — review & test focus:",
        "- You start at verify_review; do not run a full scout pass first.",
        "- Inspect the diff against the base branch before adding features.",
        "- Run focused checks, record evidence, then verify_review / close.",
        "- Only change code when verification reveals a real gap or defect.",
      ];
    case "adopt-fix":
      return [
        "Existing branch work detected — refine / fix focus:",
        "- You start at implement; scout was skipped.",
        "- Use ticket context plus git log/diff against base branch for orientation.",
        "- Prioritize corrections over new scope; keep fixes minimal.",
      ];
    case "resume":
      return [
        "Resuming an in-progress BFH run:",
        "- Stay on the recorded feature branch.",
        "- Continue from the current step; do not restart greenfield scout unless the step requires it.",
      ];
    default:
      return [];
  }
}

function workflowExpectationsBlock(state: HarnessState): string[] {
  const mode = state.git.entryMode;

  if (mode === "adopt-verify") {
    return [
      "Workflow expectations:",
      "1. You start at **verify_review** — scout was skipped for this adopt run.",
      "2. Inspect git diff/log against base branch (`bfh_state` diff_context + git as needed).",
      "3. Run focused checks, save logs, record evidence with `bfh_state` mark_tested.",
      "4. Run verify_review, then continue to close → pr_review → retro when gates pass.",
    ];
  }

  if (mode === "adopt-fix") {
    const designNote =
      state.difficulty === 3
        ? "   (Level 3 design review skipped — existing branch refine/fix.)"
        : undefined;
    return [
      "Workflow expectations:",
      "1. You start at **implement** — scout was skipped; use ticket + git diff/log for context.",
      ...(designNote ? [designNote] : []),
      "2. Refine or fix existing changes; keep scope minimal and aligned with acceptance criteria.",
      "3. Run focused checks, save logs, and record evidence with `bfh_state`.",
      "4. Run mark_tested and verify_review before close.",
      "5. Continue through PR review and retro as directed by the BFH state.",
    ];
  }

  if (mode === "adopt-continue") {
    const tail =
      state.difficulty === 1
        ? [
            "2. Proceed without internal human checkpoints; do not call `human_gate`.",
            "3. Implement what remains with a short plan.",
            "4. Run focused checks, save logs, and record evidence with `bfh_state`.",
            "5. Run mark_tested and verify_review before close.",
            "6. Continue through PR review and retro as directed by the BFH state.",
          ]
        : state.difficulty === 3
          ? [
              "2. Clarify only if a real decision blocks you; otherwise advance to implement.",
              "3. Implement remaining work; design review applies only to new direction choices.",
              "4. Run focused checks, save logs, and record evidence with `bfh_state`.",
              "5. Run mark_tested and verify_review before close; required human pre-close approval applies.",
              "6. Continue through PR review and retro as directed by the BFH state.",
            ]
          : [
              "2. Clarify only when a real decision blocks implementation.",
              "3. Implement what remains with a short plan.",
              "4. Run focused checks, save logs, and record evidence with `bfh_state`.",
              "5. Run mark_tested and verify_review before close. Required human pre-close approval applies.",
              "6. Continue through PR review and retro as directed by the BFH state.",
            ];

    return [
      "Workflow expectations:",
      "1. Scout (recon only): map what is already done on this branch vs what remains for the ticket.",
      ...tail,
    ];
  }

  const base = [
    "Workflow expectations:",
    "1. Start with scout: identify relevant files, existing patterns, checks, and risks.",
  ];

  if (state.difficulty === 1) {
    return [
      ...base,
      "2. Proceed without internal human checkpoints; do not call `human_gate`.",
      "3. Implement the smallest safe change with a short plan.",
      "4. Run focused checks, save logs, and record evidence with `bfh_state`.",
      "5. Run `mark_tested` and `verify_review` before close.",
      "6. Continue through PR review and retro as directed by the BFH state.",
    ];
  }

  if (state.difficulty === 3) {
    return [
      ...base,
      "2. Advance to **clarify** after scout. Mandatory design review before implement:",
      "   - Present **2 (preferred) or 3** solution directions via `bfh_state` action `design_gate` step `submit_options` (different angles, risks, mitigations).",
      "   - Wait for the human to pick a direction; record with `design_gate` step `record_choice` (include their steering notes).",
      "   - Submit a **short refined proposal** with `design_gate` step `submit_proposal`.",
      "   - Human accepts (`accept`) or declines with feedback (`decline` + comment); revise until approved.",
      "3. Only after design review status is `approved`, advance to implement.",
      "4. Implement the smallest safe change aligned with the approved proposal.",
      "5. Run focused checks, save logs, and record evidence with `bfh_state`.",
      "6. Run `mark_tested` and `verify_review` before close; required human pre-close approval applies.",
      "7. Continue through PR review and retro as directed by the BFH state.",
    ];
  }

  return [
    ...base,
    "2. Clarify only when a real decision blocks implementation; use `question` and `human_gate` when you need human input.",
    "3. Implement the smallest safe change with a short plan.",
    "4. Run focused checks, save logs, and record evidence with `bfh_state`.",
    "5. Run `mark_tested` and `verify_review` before close. Required human pre-close approval applies.",
    "6. Continue through PR review and retro as directed by the BFH state.",
  ];
}

export function createKickoffPrompt(statePath: string, state: HarnessState, _cwd: string): string {
  const briefPath = briefPathFor(statePath);

  return [
    `Work on ${state.ticketKey} using the BFH workflow.`,
    "",
    ...difficultyRunModeBlock(state),
    `Current step: ${state.currentStep}`,
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
    ...gitContextBlock(state),
    "",
    ...(() => {
      const entry = entryModeExpectationsBlock(state.git.entryMode);
      return entry.length ? [...entry, ""] : [];
    })(),
    ...deliveryGuidelinesBlock(statePath),
    "",
    ...workflowExpectationsBlock(state),
    "",
    "Stop and report if blocked. Keep the workflow lean; avoid inventing extra process beyond your difficulty level.",
  ].join("\n");
}

export function createResumePrompt(statePath: string, state: HarnessState, _cwd: string): string {
  const mission = readBriefMissionSummary(statePath);
  const memoryBlock = formatWorkingMemoryForPrompt(readWorkingMemory(statePath));

  return [
    `Resume the BFH workflow for ${state.ticketKey}.`,
    "",
    ...(mission ? ["Mission:", mission, ""] : []),
    ...difficultyRunModeBlock(state),
    `Current step: ${state.currentStep}`,
    ...(state.difficulty === 3
      ? [`Design review: ${state.designReview.status}`, ""]
      : []),
    `Revision budget: ${state.revisionCount}/${state.revisionLimit}`,
    `State file: ${statePath}`,
    `Brief: ${briefPathFor(statePath)}`,
    "",
    ...gitContextBlock(state),
    "",
    ...(entryModeExpectationsBlock("resume").length ? [...entryModeExpectationsBlock("resume"), ""] : []),
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
