import { Type } from "typebox";

export const HarnessStateParams = Type.Object({
  statePath: Type.Optional(Type.String({ description: "Path to state JSON. Defaults to active /bfh session state." })),
  action: Type.String({
    description:
      "read | patch | advance | evidence | question | verdict | diff_context | scout_auto | verify_review | mark_tested | mark_reviewed | mark_manual_tested | human_gate | update_memory | retro_run | pr_sync | close_check | close_create",
  }),
  patch: Type.Optional(Type.Any({ description: "Small JSON patch for patch action. currentStep/revision fields are ignored." })),
  nextStep: Type.Optional(Type.String({ description: "Target step for advance action." })),
  incrementRevision: Type.Optional(Type.Boolean({
    description: "When advancing verify_review -> implement, increment revision count.",
  })),
  evidence: Type.Optional(
    Type.Object({
      type: Type.String({ description: "test | manual | review | pr | note" }),
      command: Type.Optional(Type.String()),
      passed: Type.Optional(Type.Boolean()),
      summary: Type.String(),
      logPath: Type.Optional(Type.String()),
    }),
  ),
  question: Type.Optional(
    Type.Object({
      id: Type.String(),
      question: Type.String(),
      answer: Type.Optional(Type.String()),
    }),
  ),
  finalVerdict: Type.Optional(Type.String({ description: "success | failed | pending" })),
  maxFiles: Type.Optional(Type.Number({ description: "Max touched files for diff_context / verify_review (default 20)." })),
  implementationNotes: Type.Optional(Type.String({ description: "Short summary of what was implemented for review context." })),
  reviewFocus: Type.Optional(Type.String({ description: "Extra focus area for verify_review." })),
  scoutFocus: Type.Optional(Type.String({ description: "Extra focus area for scout_auto." })),
  prTitle: Type.Optional(Type.String({ description: "Optional PR title override for close_create." })),
  prBody: Type.Optional(Type.String({ description: "Optional PR body override for close_create." })),
  baseBranch: Type.Optional(Type.String({
    description: "Optional PR base branch for close_create (defaults to origin default/main/master).",
  })),
  headBranch: Type.Optional(Type.String({ description: "Optional PR head branch for close_create (defaults to current branch)." })),
  pushBranch: Type.Optional(Type.Boolean({ description: "Push branch to origin before creating PR (default true)." })),
  autoAdvanceRetro: Type.Optional(Type.Boolean({
    description: "Advance close -> retro automatically after PR creation (default true).",
  })),
  dryRun: Type.Optional(Type.Boolean({ description: "Validate readiness and return PR payload without pushing/creating PR." })),
  testLogPath: Type.Optional(Type.String({
    description: "Path to test command output file for mark_tested (required for mark_tested).",
  })),
  testCommand: Type.Optional(Type.String({ description: "Test command recorded in tested.json (mark_tested)." })),
  testPassed: Type.Optional(Type.Boolean({ description: "Whether tests passed (mark_tested, default true)." })),
  manualTestSummary: Type.Optional(Type.String({ description: "Summary for mark_manual_tested." })),
  requireCleanTree: Type.Optional(Type.Boolean({
    description: "Require clean git working tree before close_create push (default true).",
  })),
  memoryUpdate: Type.Optional(
    Type.Object({
      failedApproaches: Type.Optional(Type.Array(Type.String())),
      blockers: Type.Optional(Type.Array(Type.String())),
      filesChanged: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  retroLearning: Type.Optional(Type.String({ description: "Learning bullet for retro_run → LEARNINGS.md." })),
  amendmentSummary: Type.Optional(Type.String({ description: "Harness amendment proposal for retro_run." })),
  autoAdvancePrReview: Type.Optional(Type.Boolean({
    description: "After pr_sync, auto-advance on pr_review step (default true).",
  })),
  skipPrReview: Type.Optional(Type.Boolean({
    description: "close_create: advance to retro instead of pr_review after PR creation.",
  })),
  humanGate: Type.Optional(
    Type.Object({
      gate: Type.String({ description: "pre_implement | pre_close" }),
      decision: Type.String({ description: "request | approve | changes_requested | not_needed" }),
      comment: Type.Optional(Type.String()),
    }),
  ),
  autoAdvanceOnHumanChanges: Type.Optional(Type.Boolean({
    description: "When pre_close decision=changes_requested at close, auto-advance to implement (default true).",
  })),
});
