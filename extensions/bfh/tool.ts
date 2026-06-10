import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import { agentResultParsedOk, parseAgentResult } from "./agent-result.ts";
import { appendBriefProgress } from "./brief.ts";
import { executeCloseCreate } from "./close.ts";
import { stateToolText } from "./display.ts";
import { loadBfhConfig, resolveSubagentInvocation } from "./bfh-config.ts";
import { buildTouchedFileContext, discoverTouchedFiles } from "./git-diff.ts";
import { buildScoutInput, normalizeReviewFromText, normalizeScoutFromText } from "./normalize.ts";
import { getReviewSystemPrompt } from "./prompt-loader.ts";
import { formatReviewCountsLine, getReviewCounts, resolveVerifyReviewTransition } from "./review.ts";
import { HarnessStateParams } from "./schema.ts";
import { applyDesignGate } from "./design-review.ts";
import { isHandsOffLevel } from "./difficulty.ts";
import { applyAdvance, mergeStatePatch, readState, resolveStatePath, writeState, STEP_ORDER } from "./state.ts";
import type { HarnessEvidenceInput, HarnessOpenQuestion, HarnessStep } from "./types.ts";
import { runFreshReviewViaSubagentWithRetry, runScoutViaSubagentWithRetry } from "./subagent.ts";
import { evaluateCloseReadiness } from "./close.ts";
import { classifyScoutOutcome, resolvePrReviewTransitionFromOutcome } from "./outcome-table.ts";
import {
  applyPrSnapshotToState,
  formatPrReviewSummary,
  syncPrReviewFromGitHub,
  writePrReviewMarker,
} from "./pr-sync.ts";
import { runRetro } from "./retro.ts";
import { formatWorkingMemoryForPrompt, readWorkingMemory, updateWorkingMemory, type WorkingMemoryUpdate } from "./working-memory.ts";
import {
  readReviewedMarker,
  readTestedMarker,
  resolveTestLogPath,
  writeManualTestedMarker,
  writeReviewedMarker,
  writeTestedMarker,
} from "./evidence-markers.ts";
import {
  humanGateWaitMs,
  recordBfhAction,
  recordDesignGate,
  recordGateBlocked,
  recordHarnessTransition,
  recordHumanGate,
  recordModelUse,
  syncMetricsSnapshot,
} from "./metrics.ts";
import { setBfhProgressStatus } from "./status.ts";

export function registerBfhStateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bfh_state",
    label: "BFH State",
    description: "Read or update the BFH task state with deterministic transition checks.",
    promptSnippet: "Read/update BFH state for Jira-driven work.",
    promptGuidelines: [
      "Use bfh_state during /bfh runs to record phase progress, evidence, review verdicts, and PR/retro notes.",
      "Use bfh_state action `advance` instead of directly editing currentStep; it enforces the revision limit and valid transitions.",
      "Use bfh_state action `diff_context` during verify_review to get compact git diff/status snippets without dumping entire files.",
      "Use bfh_state action `scout_auto` during scout for automated read-only scout subagent reconnaissance.",
      "Use bfh_state action `verify_review` to run the combined review gate and auto-advance to implement/close/failed (critical blocks; warnings allow close).",
      "Patch review.allowCloseDespiteCritical only for explicit human override when critical findings remain.",
      "Use bfh_state action `mark_tested` with testLogPath after tests (writes SHA-pinned tested.json; agents must not edit marker files).",
      "Use bfh_state action `mark_manual_tested` when src-like files changed and manual verification was done.",
      "Use bfh_state action `human_gate` for human checkpoints: optional pre-implement approval and required pre-close approval/change request (not at difficulty level 1).",
      "At difficulty level 3, after scout advance to clarify and run `design_gate`: submit 2–3 options, record human choice, submit proposal, then accept/decline before implement.",
      "verify_review writes reviewed.json; close requires tested.json + reviewed.json (critical: 0) and human pre-close approval.",
      "Use bfh_state action `close_create` to enforce close gates and create a draft PR safely.",
      "Use bfh_state action `close_check` when you only need readiness + PR body without creating a PR.",
      "Use bfh_state action `update_memory` during repair loops to record failed approaches (injected on resume).",
      "Use bfh_state action `retro_run` on retro step to append LEARNINGS.md and stage harness amendments; include a compact retroLearning based on revision loops/review findings/PR feedback.",
      "Retro scope rule: target BFH harness improvements (prompts/docs/commands/phase logic), not target-repo code changes.",
      "Use bfh_state action `pr_sync` after draft PR exists to pull GitHub review status (approvals, change requests) into state and pr-review.json.",
      "Advance to done only after pr_sync shows APPROVED (or patch pr.allowDoneWithoutPrApproval).",
    ],
    parameters: HarnessStateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const statePath = resolveStatePath(ctx, params.statePath);
      const state = readState(statePath);
      const action = String(params.action || "read").trim().toLowerCase();

      try {
        if (action !== "read") {
          recordBfhAction(statePath, state, action);
        }

        if (action === "read") {
          return {
            content: [{ type: "text", text: `${stateToolText(statePath, state)}\n\n${JSON.stringify(state, null, 2)}` }],
            details: { ok: true, statePath, state },
          };
        }

      if (action === "scout_auto") {
        if (state.currentStep !== "scout") {
          throw new Error(`scout_auto action requires currentStep=scout (found ${state.currentStep}).`);
        }

        const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const invocation = resolveSubagentInvocation(ctx.cwd, "scout", sessionModel);
        const model = invocation.model;
        const modelLabel = model ? (invocation.thinking ? `${model}:${invocation.thinking}` : model) : undefined;
        recordModelUse(statePath, modelLabel, "scout_auto");
        const scoutInput = buildScoutInput(state, params.scoutFocus);
        const scoutResult = await runScoutViaSubagentWithRetry({
          pi,
          ctx,
          cwd: ctx.cwd,
          scoutInput,
          model,
          thinking: invocation.thinking,
          signal: _signal,
          statePath,
          state,
        });

        const normalized = normalizeScoutFromText(scoutResult.text);
        const scoutOutcome = classifyScoutOutcome(scoutResult.text);
        state.scout = normalized;
        state.evidence.push({
          type: "note",
          summary: "Automated scout reconnaissance captured via scout subagent.",
          createdAt: new Date().toISOString(),
        });
        writeState(statePath, state);
        appendBriefProgress(statePath, "scout", normalized.summary || scoutOutcome);

        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              `scout_auto: OK (outcome ${scoutOutcome})`,
              "",
              "Scout summary:",
              normalized.summary || "(none)",
              "",
              "Relevant files:",
              ...(normalized.relevantFiles.length
                ? normalized.relevantFiles.map((item) => `- ${item.path}: ${item.reason}`)
                : ["- (none)"]),
            ].join("\n"),
          }],
          details: {
            ok: true,
            statePath,
            scout: normalized,
            model,
          },
        };
      }

      if (action === "diff_context") {
        const configMax = loadBfhConfig(ctx.cwd).workflow.maxReviewTouchedFiles;
        const maxFiles =
          Number.isFinite(params.maxFiles) && (params.maxFiles ?? 0) > 0
            ? Math.floor(params.maxFiles!)
            : configMax;
        const touchedFiles = discoverTouchedFiles(ctx.cwd, maxFiles);
        const bundle = buildTouchedFileContext(ctx.cwd, touchedFiles);
        const summary = touchedFiles.length
          ? touchedFiles
              .map(
                (f) =>
                  `- ${f.path}${f.startLine ? `:${f.startLine}-${f.endLine}` : ""}${f.note ? ` (${f.note})` : ""}`,
              )
              .join("\n")
          : "(No touched files detected from git diff/status.)";

        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              "Touched files:",
              summary,
              "",
              "Compact touched-file context:",
              bundle.context || "(No readable touched-file snippets.)",
            ].join("\n"),
          }],
          details: { ok: true, statePath, touchedFiles, filesUsed: bundle.filesUsed },
        };
      }

      if (action === "verify_review") {
        if (state.currentStep !== "verify_review") {
          throw new Error(`verify_review action requires currentStep=verify_review (found ${state.currentStep}).`);
        }

        const configMax = loadBfhConfig(ctx.cwd).workflow.maxReviewTouchedFiles;
        const maxFiles =
          Number.isFinite(params.maxFiles) && (params.maxFiles ?? 0) > 0
            ? Math.floor(params.maxFiles!)
            : configMax;
        const touchedFiles = discoverTouchedFiles(ctx.cwd, maxFiles);
        const bundle = buildTouchedFileContext(ctx.cwd, touchedFiles);
        const reviewerInput = [
          `Ticket: ${state.ticketKey}`,
          `Summary: ${state.summary}`,
          state.description ? `Description: ${state.description}` : undefined,
          params.implementationNotes ? `Implementation Notes: ${params.implementationNotes}` : undefined,
          params.reviewFocus ? `Extra Focus: ${params.reviewFocus}` : undefined,
          "",
          "Touched code context:",
          bundle.context || "(No touched file snippets found. Review based on ticket context only.)",
        ]
          .filter((v): v is string => Boolean(v))
          .join("\n");

        const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const invocation = resolveSubagentInvocation(ctx.cwd, "reviewer", sessionModel);
        const model = invocation.model;
        const modelLabel = model ? (invocation.thinking ? `${model}:${invocation.thinking}` : model) : undefined;
        recordModelUse(statePath, modelLabel, "verify_review");
        const subagentResult = await runFreshReviewViaSubagentWithRetry({
          pi,
          ctx,
          cwd: ctx.cwd,
          reviewerInput,
          systemPrompt: getReviewSystemPrompt(ctx.cwd),
          model,
          thinking: invocation.thinking,
          signal: _signal,
          statePath,
          state,
        });

        const parsed = parseAgentResult(subagentResult.text);
        const normalized = normalizeReviewFromText(subagentResult.text);
        state.review = normalized;
        const counts = getReviewCounts(normalized);
        const transition = resolveVerifyReviewTransition(state, normalized, agentResultParsedOk(parsed));
        const reviewPassed = transition === "close";

        state.evidence.push({
          type: "review",
          passed: reviewPassed,
          summary:
            reviewPassed
              ? counts.warning > 0 || counts.info > 0
                ? `Verify/review passed with advisories (${formatReviewCountsLine(normalized)}).`
                : "Fresh verify/review passed."
              : counts.critical > 0
                ? `Verify/review blocked: ${formatReviewCountsLine(normalized)}.`
                : "Fresh verify/review requested revisions.",
          createdAt: new Date().toISOString(),
        });

        if (transition === "implement") {
          updateWorkingMemory(statePath, {
            failedApproaches: [normalized.summary || "Review requested revisions."],
          });
        }

        applyAdvance(state, transition, statePath);
        writeState(statePath, state);
        const reviewedMarker = writeReviewedMarker(statePath, state);
        appendBriefProgress(statePath, "verify_review", `${transition}: ${normalized.summary}`);

        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              `verify_review transition: ${transition}`,
              `Findings: ${formatReviewCountsLine(normalized)}`,
              `reviewed.json: critical=${reviewedMarker.critical} warning=${reviewedMarker.warning} info=${reviewedMarker.info}`,
              "",
              "Fresh reviewer output:",
              normalized.summary,
            ].join("\n"),
          }],
          details: {
            ok: transition !== "failed",
            statePath,
            transition,
            touchedFiles,
            filesUsed: bundle.filesUsed,
            review: normalized,
            model,
          },
          isError: transition === "failed",
        };
      }

      if (action === "mark_tested") {
        const logPath = String(params.testLogPath || params.evidence?.logPath || "").trim();
        if (!logPath) {
          throw new Error("mark_tested requires testLogPath (path to saved test command output).");
        }
        const absPath = resolveTestLogPath(ctx.cwd, logPath);
        if (!fs.existsSync(absPath)) {
          throw new Error(`mark_tested: test log not found: ${absPath}`);
        }
        const outputContent = fs.readFileSync(absPath, "utf8");
        const marker = writeTestedMarker(statePath, state, {
          outputContent,
          command: params.testCommand || params.evidence?.command,
          passed: params.testPassed ?? params.evidence?.passed,
          logPath,
        });
        state.evidence.push({
          type: "test",
          passed: marker.passed,
          command: marker.command,
          summary: `Tests recorded (hash ${marker.outputHash.slice(0, 12)}…).`,
          logPath,
          createdAt: new Date().toISOString(),
        });
        writeState(statePath, state);
        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              "mark_tested: OK",
              `tested.json outputHash=${marker.outputHash.slice(0, 16)}…`,
            ].join("\n"),
          }],
          details: { ok: true, statePath, marker },
        };
      }

      if (action === "mark_reviewed") {
        const counts = getReviewCounts(state.review);
        if (counts.critical > 0 && !state.review.allowCloseDespiteCritical) {
          throw new Error(
            `mark_reviewed refused: ${counts.critical} critical finding(s). Fix review or use verify_review after fixes.`,
          );
        }
        if (state.review.verdict !== "approved") {
          throw new Error(`mark_reviewed refused: review verdict is ${state.review.verdict}, expected approved.`);
        }
        const marker = writeReviewedMarker(statePath, state, "bfh_state:mark_reviewed");
        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              "mark_reviewed: OK",
              `reviewed.json critical=${marker.critical} warning=${marker.warning} info=${marker.info}`,
            ].join("\n"),
          }],
          details: { ok: true, statePath, marker },
        };
      }

      if (action === "mark_manual_tested") {
        const summary = String(params.manualTestSummary || params.evidence?.summary || "").trim();
        if (!summary) throw new Error("mark_manual_tested requires manualTestSummary.");
        const marker = writeManualTestedMarker(statePath, state, summary);
        state.evidence.push({
          type: "manual",
          passed: true,
          summary: marker.summary,
          createdAt: new Date().toISOString(),
        });
        writeState(statePath, state);
        return {
          content: [{
            type: "text",
            text: [stateToolText(statePath, state), "", "mark_manual_tested: OK", marker.summary].join("\n"),
          }],
          details: { ok: true, statePath, marker },
        };
      }

      if (action === "human_gate") {
        const gate = String(params.humanGate?.gate || "").trim();
        const decision = String(params.humanGate?.decision || "").trim();
        const comment = String(params.humanGate?.comment || "").trim();
        if (!gate || !decision) {
          throw new Error("human_gate requires humanGate.gate and humanGate.decision.");
        }

        const now = new Date().toISOString();

        if (isHandsOffLevel(state)) {
          throw new Error("human_gate is disabled at difficulty level 1 (hands-off). Use --level 2 or 3 for human checkpoints.");
        }

        if (gate === "pre_implement") {
          if (decision === "request") {
            state.human.preImplement = {
              required: true,
              status: "pending",
              comment: comment || "Human decision requested before implementation.",
              requestedAt: now,
            };
          } else if (decision === "approve") {
            state.human.preImplement = {
              ...state.human.preImplement,
              required: true,
              status: "approved",
              comment: comment || state.human.preImplement.comment,
              decidedAt: now,
            };
          } else if (decision === "not_needed") {
            state.human.preImplement = {
              required: false,
              status: "not_needed",
              comment: comment || undefined,
              decidedAt: now,
            };
          } else {
            throw new Error("human_gate pre_implement decision must be request|approve|not_needed.");
          }
        } else if (gate === "pre_close") {
          if (decision === "request") {
            state.human.preClose = {
              status: "pending",
              comment: comment || "Human approval requested before close_create.",
              requestedAt: now,
            };
          } else if (decision === "approve") {
            state.human.preClose = {
              ...state.human.preClose,
              status: "approved",
              comment: comment || state.human.preClose.comment,
              decidedAt: now,
            };
          } else if (decision === "changes_requested") {
            state.human.preClose = {
              ...state.human.preClose,
              status: "changes_requested",
              comment: comment || "Human requested changes before close.",
              decidedAt: now,
            };
            if (state.currentStep === "close" && params.autoAdvanceOnHumanChanges !== false) {
              applyAdvance(state, "implement", statePath);
            }
          } else {
            throw new Error("human_gate pre_close decision must be request|approve|changes_requested.");
          }
        } else {
          throw new Error("human_gate gate must be pre_implement|pre_close.");
        }

        state.evidence.push({
          type: "note",
          summary: `Human gate ${gate}: ${decision}${comment ? ` (${comment})` : ""}`,
          createdAt: now,
        });
        writeState(statePath, state);

        const waitMs =
          gate === "pre_implement"
            ? humanGateWaitMs(state.human.preImplement.requestedAt, state.human.preImplement.decidedAt)
            : humanGateWaitMs(state.human.preClose.requestedAt, state.human.preClose.decidedAt);
        recordHumanGate(statePath, state, gate, decision, waitMs);

        return {
          content: [{ type: "text", text: [stateToolText(statePath, state), "", "human_gate: OK"].join("\n") }],
          details: { ok: true, statePath, state },
        };
      }

      if (action === "design_gate") {
        const gate = params.designGate;
        if (!gate?.step) throw new Error("design_gate requires designGate.step.");
        const message = applyDesignGate(state, {
          step: gate.step as "submit_options" | "record_choice" | "submit_proposal" | "accept" | "decline",
          options: gate.options,
          selectedOptionId: gate.selectedOptionId,
          humanSteering: gate.humanSteering,
          proposal: gate.proposal,
          comment: gate.comment,
          reopenOptions: gate.reopenOptions,
        });
        state.evidence.push({
          type: "note",
          summary: `Design gate ${gate.step}: ${message}`,
          createdAt: new Date().toISOString(),
        });
        writeState(statePath, state);
        recordDesignGate(statePath, state, gate.step);
        return {
          content: [{ type: "text", text: [stateToolText(statePath, state), "", `design_gate: ${message}`].join("\n") }],
          details: { ok: true, statePath, state, designReview: state.designReview },
        };
      }

      if (action === "update_memory") {
        const update = params.memoryUpdate as WorkingMemoryUpdate | undefined;
        if (!update) throw new Error("update_memory requires memoryUpdate payload.");
        const memory = updateWorkingMemory(statePath, update);
        return {
          content: [{
            type: "text",
            text: [stateToolText(statePath, state), "", formatWorkingMemoryForPrompt(memory) || "Memory updated."].join(
              "\n",
            ),
          }],
          details: { ok: true, statePath, memory },
        };
      }

      if (action === "pr_sync") {
        const prUrl = String(state.pr.url || "").trim();
        if (!prUrl) throw new Error("pr_sync requires state.pr.url (run close_create first).");

        let snapshot;
        try {
          snapshot = syncPrReviewFromGitHub(ctx.cwd, prUrl);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`pr_sync failed: ${message}`);
        }

        applyPrSnapshotToState(state, snapshot);
        const { transition, outcome } = resolvePrReviewTransitionFromOutcome(state, snapshot);

        const autoAdvance = params.autoAdvancePrReview !== false;
        let advanced = false;
        if (autoAdvance && state.currentStep === "pr_review" && transition !== state.currentStep) {
          applyAdvance(state, transition, statePath);
          advanced = true;
        }

        state.evidence.push({
          type: "note",
          summary: `GitHub PR sync: ${snapshot.reviewDecision} (${snapshot.reviewCommentCount} review comments).`,
          createdAt: new Date().toISOString(),
        });
        writeState(statePath, state);
        const marker = writePrReviewMarker(statePath, state, snapshot);
        appendBriefProgress(statePath, "pr_review", `pr_sync → ${outcome}${advanced ? `, now ${state.currentStep}` : ""}`);

        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              `pr_sync outcome: ${outcome}`,
              advanced ? `Advanced to: ${state.currentStep}` : `Stay on: ${state.currentStep}`,
              "",
              formatPrReviewSummary(snapshot),
            ].join("\n"),
          }],
          details: { ok: true, statePath, snapshot, marker, outcome, transition },
        };
      }

      if (action === "retro_run") {
        const result = runRetro(ctx.cwd, statePath, state, {
          learning: params.retroLearning ? String(params.retroLearning) : undefined,
          amendmentSummary: params.amendmentSummary ? String(params.amendmentSummary) : undefined,
        });
        if (params.retroLearning) {
          state.retroNotes.push(String(params.retroLearning));
          writeState(statePath, state);
        }
        appendBriefProgress(statePath, "retro", "retro_run completed.");
        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              "retro_run: OK",
              result.appendedLearning ? `LEARNINGS: ${result.learningsPath}` : "",
              result.amendmentPath ? `Amendment: ${result.amendmentPath}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          }],
          details: { ok: true, statePath, result },
        };
      }

      if (action === "close_create") {
        const result = executeCloseCreate(ctx.cwd, statePath, state, {
          prTitle: params.prTitle,
          prBody: params.prBody,
          baseBranch: params.baseBranch,
          headBranch: params.headBranch,
          pushBranch: params.pushBranch,
          autoAdvanceRetro: params.autoAdvanceRetro,
          dryRun: params.dryRun,
          requireCleanTree: params.requireCleanTree,
          skipPrReview: params.skipPrReview,
        });

        if (!result.ok) {
          if (!result.dryRun) writeState(statePath, state);
          recordGateBlocked(statePath, state, "close_create", (result.reasons || []).join("; "));
          const createdButBlocked = Boolean(result.prUrl);
          return {
            content: [{
              type: "text",
              text: createdButBlocked
                ? [
                    stateToolText(statePath, state),
                    "",
                    "Close create: PR CREATED BUT BLOCKED",
                    `PR: ${result.prUrl}`,
                    result.prChecks ? `GitHub checks: ${result.prChecks.status} (${result.prChecks.summary})` : "",
                    "",
                    ...(result.reasons || []).map((r) => `- ${r}`),
                  ]
                    .filter(Boolean)
                    .join("\n")
                : [
                    "Close create: BLOCKED",
                    "",
                    ...(result.reasons || []).map((r) => `- ${r}`),
                    "",
                    "Draft PR body if blockers are resolved:",
                    result.prBody,
                  ].join("\n"),
            }],
            details: {
              ok: false,
              statePath,
              reasons: result.reasons || [],
              prTitle: result.prTitle,
              prBody: result.prBody,
              prUrl: result.prUrl,
              prChecks: result.prChecks,
            },
            isError: true,
          };
        }

        if (!result.dryRun) writeState(statePath, state);

        return {
          content: [{
            type: "text",
            text: [
              stateToolText(statePath, state),
              "",
              result.dryRun ? "Close create: DRY RUN (no PR created)" : "Close create: OK",
              `Base: ${result.baseBranch}`,
              `Head: ${result.headBranch}`,
              `PR: ${result.prUrl || "(not created)"}`,
              result.prChecks ? `GitHub checks: ${result.prChecks.status} (${result.prChecks.summary})` : "",
              "",
              "Draft PR body:",
              result.prBody,
            ].join("\n"),
          }],
          details: {
            ok: true,
            statePath,
            dryRun: Boolean(result.dryRun),
            created: result.created,
            prUrl: result.prUrl,
            baseBranch: result.baseBranch,
            headBranch: result.headBranch,
            prTitle: result.prTitle,
            prBody: result.prBody,
            prChecks: result.prChecks,
          },
        };
      }

      if (action === "close_check") {
        const readiness = evaluateCloseReadiness(ctx.cwd, statePath, state);
        const tested = readTestedMarker(statePath);
        const reviewed = readReviewedMarker(statePath);
        return {
          content: [{
            type: "text",
            text: readiness.ok
              ? [
                  "Close check: OK",
                  tested ? `tested.json hash=${tested.outputHash.slice(0, 12)}…` : "",
                  reviewed
                    ? `reviewed.json ${reviewed.critical}c/${reviewed.warning}w/${reviewed.info}i`
                    : "",
                  "",
                  "Draft PR body:",
                  readiness.prBody,
                ]
                  .filter(Boolean)
                  .join("\n")
              : [
                  "Close check: BLOCKED",
                  "",
                  ...readiness.reasons.map((r) => `- ${r}`),
                  "",
                  "Draft PR body if blockers are resolved:",
                  readiness.prBody,
                ].join("\n"),
          }],
          details: {
            ok: readiness.ok,
            statePath,
            reasons: readiness.reasons,
            prBody: readiness.prBody,
            tested,
            reviewed,
          },
          isError: !readiness.ok,
        };
      }

      if (action === "patch") {
        mergeStatePatch(state, params.patch);
        writeState(statePath, state);
        return {
          content: [{ type: "text", text: stateToolText(statePath, state) }],
          details: { ok: true, statePath, state },
        };
      }

      if (action === "question") {
        if (!params.question) throw new Error("question action requires question payload.");
        const existing = state.openQuestions.find((q) => q.id === params.question!.id);
        if (existing) {
          existing.question = params.question.question;
          existing.answer = params.question.answer;
        } else {
          state.openQuestions.push(params.question as HarnessOpenQuestion);
        }
        writeState(statePath, state);
        return {
          content: [{ type: "text", text: stateToolText(statePath, state) }],
          details: { ok: true, statePath, state },
        };
      }

      if (action === "evidence") {
        if (!params.evidence) throw new Error("evidence action requires evidence payload.");
        const evidenceInput = params.evidence as HarnessEvidenceInput;
        state.evidence.push({
          ...evidenceInput,
          createdAt: new Date().toISOString(),
        });
        writeState(statePath, state);
        return {
          content: [{ type: "text", text: stateToolText(statePath, state) }],
          details: { ok: true, statePath, state },
        };
      }

      if (action === "advance") {
        const nextStep = String(params.nextStep || "") as HarnessStep;
        if (!STEP_ORDER.includes(nextStep) && nextStep !== "failed") {
          throw new Error(`Invalid nextStep: ${params.nextStep}`);
        }
        try {
          applyAdvance(state, nextStep, statePath);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          recordHarnessTransition(statePath, state, state.currentStep, nextStep, {
            allowed: false,
            reason,
            trigger: "advance",
          });
          recordGateBlocked(statePath, state, "advance", reason);
          throw error;
        }
        writeState(statePath, state);
        return {
          content: [{ type: "text", text: stateToolText(statePath, state) }],
          details: { ok: true, statePath, state },
        };
      }

      if (action === "verdict") {
        const verdict = String(params.finalVerdict || "pending");
        if (!["success", "failed", "pending"].includes(verdict)) {
          throw new Error(`Invalid finalVerdict: ${verdict}`);
        }
        state.finalVerdict = verdict as typeof state.finalVerdict;
        writeState(statePath, state);
        return {
          content: [{ type: "text", text: stateToolText(statePath, state) }],
          details: { ok: true, statePath, state },
        };
      }

      throw new Error(`Unknown bfh_state action: ${action}`);
    } finally {
      syncMetricsSnapshot(statePath, state);
      setBfhProgressStatus(ctx, state);
    }
    },
  });
}
