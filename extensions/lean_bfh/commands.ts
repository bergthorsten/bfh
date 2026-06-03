import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import { normalizeIssueKey, parseHarnessStartArgs } from "./args.ts";
import { executeCloseCreate } from "./close.ts";
import { writeReviewedMarker } from "./evidence-markers.ts";
import { renderStatus, stateToolText } from "./display.ts";
import { buildTouchedFileContext, discoverTouchedFiles } from "./git-diff.ts";
import { fetchIssue } from "./jira.ts";
import { appendBriefProgress, createBrief } from "./brief.ts";
import { deliverHarnessPrompt } from "./kickoff.ts";
import { ensureHarnessReadme, ensurePrinciplesFile } from "./harness-docs.ts";
import { buildScoutInput, normalizeReviewFromText, normalizeScoutFromText } from "./normalize.ts";
import { agentResultParsedOk, parseAgentResult } from "./agent-result.ts";
import { getReviewSystemPrompt } from "./prompt-loader.ts";
import { formatReviewCountsLine, getReviewCounts, resolveVerifyReviewTransition } from "./review.ts";
import { createKickoffPrompt, createResumePrompt } from "./prompts.ts";
import { runRetro } from "./retro.ts";
import { classifyScoutOutcome, resolvePrReviewTransitionFromOutcome } from "./outcome-table.ts";
import {
  applyPrSnapshotToState,
  formatPrReviewSummary,
  syncPrReviewFromGitHub,
  writePrReviewMarker,
} from "./pr-sync.ts";
import { updateWorkingMemory } from "./working-memory.ts";
import { runHarnessSelfTest } from "./selftest.ts";
import { clearBfhProgressStatus, isBfhWorkflowActive, setBfhProgressStatus } from "./status.ts";
import {
  activeStatePathFromSession,
  applyAdvance,
  createState,
  listStateFiles,
  readState,
  resolveStatePathFromArg,
  statePathFor,
  writeState,
} from "./state.ts";
import { runFreshReviewViaSubagentWithRetry, runScoutViaSubagentWithRetry } from "./subagent.ts";
import { difficultyLabel } from "./difficulty.ts";
import {
  initHarnessMetrics,
  recordHarnessCommand,
  recordHarnessTransition,
  recordModelUse,
  recordRunResumed,
  syncMetricsSnapshot,
} from "./metrics.ts";
import { HARNESS_ENTRY_TYPE, ISSUE_KEY_PATTERN } from "./types.ts";
import type { HarnessStep } from "./types.ts";

export function registerLeanBfhCommands(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const statePath = activeStatePathFromSession(ctx);
    if (!statePath || !fs.existsSync(statePath)) {
      clearBfhProgressStatus(ctx);
      return;
    }

    try {
      const state = readState(statePath);
      if (isBfhWorkflowActive(state)) {
        setBfhProgressStatus(ctx, state);
      } else {
        clearBfhProgressStatus(ctx);
      }
    } catch {
      clearBfhProgressStatus(ctx);
    }
  });

  const startHarness = async (args: string, ctx: import("@mariozechner/pi-coding-agent").ExtensionContext) => {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Agent is busy. Wait until current work is done.", "warning");
      return;
    }

    let { issueKey, noJira, autoGo, difficulty } = parseHarnessStartArgs(args || "");
    if (!issueKey && ctx.hasUI) {
      const input = await ctx.ui.input("Jira ticket key", "e.g. PC-120");
      if (!input) return;
      issueKey = normalizeIssueKey(input);
    }

    if (!ISSUE_KEY_PATTERN.test(issueKey)) {
      ctx.ui.notify("Invalid ticket key. Expected format like PC-120.", "error");
      return;
    }

    if (noJira) {
      ctx.ui.notify(`Starting harness for ${issueKey} without Jira lookup (--no-jira).`, "info");
    } else {
      ctx.ui.notify(`Fetching Jira ticket ${issueKey}...`, "info");
    }

    let issue;
    if (noJira) {
      issue = {
        key: issueKey,
        title: issueKey,
        type: "unknown",
        status: "unknown",
        description: "",
        linkedTickets: [],
        labels: [],
      };
    } else {
      try {
        issue = await fetchIssue(issueKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!ctx.hasUI) {
          ctx.ui.notify(`${message}\nHint: use /bfh ${issueKey} --no-jira for local/offline testing.`, "error");
          return;
        }

        const proceed = await ctx.ui.confirm(
          "Jira lookup failed",
          `${message}\n\nContinue with only the ticket key?`,
        );
        if (!proceed) return;

        issue = {
          key: issueKey,
          title: issueKey,
          type: "unknown",
          status: "unknown",
          description: "",
          linkedTickets: [],
          labels: [],
        };
      }
    }

    const state = createState(issue, { difficulty });
    state.evidence.push({
      type: "note",
      summary: `Run started at difficulty level ${difficulty}.`,
      createdAt: new Date().toISOString(),
    });
    const statePath = statePathFor(ctx.cwd, issueKey);
    writeState(statePath, state);
    initHarnessMetrics(statePath, state, {
      noJira,
      autoGo,
      source: "bfh",
    });
    ensurePrinciplesFile(ctx.cwd);
    ensureHarnessReadme(ctx.cwd);
    createBrief(statePath, state, ctx.cwd);
    setBfhProgressStatus(ctx, state);

    pi.appendEntry(HARNESS_ENTRY_TYPE, {
      issueKey,
      statePath,
      startedAt: state.createdAt,
    });
    pi.setSessionName(`${issueKey}: ${state.summary || "Lean BFH"}`);

    ctx.ui.notify(
      `Lean BFH state created: ${statePath} (level ${difficulty}: ${difficultyLabel(difficulty)})`,
      "info",
    );
    deliverHarnessPrompt(pi, ctx, createKickoffPrompt(statePath, state, ctx.cwd), { autoGo });
  };

  pi.registerCommand("bfh", {
    description: "Start lean BFH. Usage: /bfh PROJ-123 [--level 1|2|3] [--no-jira] [--go] (default level 2)",
    handler: startHarness,
  });

  pi.registerCommand("bfh-status", {
    description: "Show lean BFH state. Usage: /bfh-status [TICKET-123|state-path]",
    handler: async (args, ctx) => {
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found in this repo/session.", "warning");
        return;
      }

      const state = readState(statePath);
      recordHarnessCommand(statePath, state, "bfh-status");
      setBfhProgressStatus(ctx, state);
      syncMetricsSnapshot(statePath, state);
      ctx.ui.notify(renderStatus(statePath, state), state.finalVerdict === "failed" ? "error" : "info");
    },
  });

  pi.registerCommand("bfh-list", {
    description: "List lean BFH state files in this repo.",
    handler: async (_args, ctx) => {
      const files = listStateFiles(ctx.cwd);
      if (files.length === 0) {
        ctx.ui.notify("No lean BFH state files found.", "info");
        return;
      }

      const lines = files.slice(0, 20).map((file) => {
        try {
          const state = readState(file);
          return `- ${state.ticketKey}: ${state.currentStep}, rev ${state.revisionCount}/${state.revisionLimit}, ${state.finalVerdict} — ${state.summary}`;
        } catch {
          return `- ${file}: unreadable`;
        }
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("bfh-selftest", {
    description: "Run local deterministic smoke checks for lean BFH state machine.",
    handler: async (_args, ctx) => {
      try {
        const report = runHarnessSelfTest(ctx.cwd);
        ctx.ui.notify(report, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Lean BFH self-test failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("bfh-resume", {
    description: "Resume lean BFH state. Usage: /bfh-resume [TICKET-123|state-path] [--go]",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until current work is done.", "warning");
        return;
      }

      const { autoGo } = parseHarnessStartArgs(args || "");
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found to resume.", "warning");
        return;
      }

      const state = readState(statePath);
      recordHarnessCommand(statePath, state, "bfh-resume");
      recordRunResumed(statePath, state);
      setBfhProgressStatus(ctx, state);
      pi.appendEntry(HARNESS_ENTRY_TYPE, {
        issueKey: state.ticketKey,
        statePath,
        resumedAt: new Date().toISOString(),
      });
      pi.setSessionName(`${state.ticketKey}: ${state.summary || "Lean BFH"}`);
      ctx.ui.notify(`Resuming lean BFH: ${statePath}`, "info");
      deliverHarnessPrompt(pi, ctx, createResumePrompt(statePath, state, ctx.cwd), { autoGo });
    },
  });

  pi.registerCommand("bfh-scout", {
    description: "Run automated scout subagent and patch state.scout. Usage: /bfh-scout [TICKET-123|state-path]",
    handler: async (args, ctx) => {
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found to scout.", "warning");
        return;
      }

      const state = readState(statePath);
      recordHarnessCommand(statePath, state, "bfh-scout");
      if (state.currentStep !== "scout") {
        ctx.ui.notify(`Current step is ${state.currentStep}. Move to scout first.`, "warning");
        return;
      }

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      recordModelUse(statePath, model, "bfh-scout");
      let scoutResult;
      try {
        scoutResult = await runScoutViaSubagentWithRetry({
          cwd: ctx.cwd,
          scoutInput: buildScoutInput(state),
          model,
          statePath,
          state,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Scout helper failed: ${message}`, "error");
        return;
      }

      const normalized = normalizeScoutFromText(scoutResult.text);
      const scoutOutcome = classifyScoutOutcome(scoutResult.text);
      state.scout = normalized;
      state.evidence.push({
        type: "note",
        summary: "Automated scout reconnaissance captured via scout subagent.",
        createdAt: new Date().toISOString(),
      });
      writeState(statePath, state);
      setBfhProgressStatus(ctx, state);
      appendBriefProgress(statePath, "scout", normalized.summary || scoutOutcome);

      ctx.ui.notify(
        [stateToolText(statePath, state), "", "Scout summary:", normalized.summary || "(none)"].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("bfh-verify", {
    description: "Run verify/review helper for active harness state. Usage: /bfh-verify [TICKET-123|state-path]",
    handler: async (args, ctx) => {
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found to verify.", "warning");
        return;
      }

      const state = readState(statePath);
      recordHarnessCommand(statePath, state, "bfh-verify");
      if (state.currentStep !== "verify_review") {
        ctx.ui.notify(`Current step is ${state.currentStep}. Move to verify_review first.`, "warning");
        return;
      }

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      recordModelUse(statePath, model, "bfh-verify");
      const touchedFiles = discoverTouchedFiles(ctx.cwd, 20);
      const contextBundle = buildTouchedFileContext(ctx.cwd, touchedFiles);
      const reviewerInput = [
        `Ticket: ${state.ticketKey}`,
        `Summary: ${state.summary}`,
        state.description ? `Description: ${state.description}` : undefined,
        "",
        "Touched code context:",
        contextBundle.context || "(No touched file snippets found. Review based on ticket context only.)",
      ]
        .filter((v): v is string => Boolean(v))
        .join("\n");

      let subagentResult;
      try {
        subagentResult = await runFreshReviewViaSubagentWithRetry({
          cwd: ctx.cwd,
          reviewerInput,
          systemPrompt: getReviewSystemPrompt(ctx.cwd),
          model,
          statePath,
          state,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`verify/review helper failed: ${message}`, "error");
        return;
      }

      const parsed = parseAgentResult(subagentResult.text);
      const normalized = normalizeReviewFromText(subagentResult.text);
      state.review = normalized;
      const counts = getReviewCounts(normalized);
      const transition = resolveVerifyReviewTransition(state, normalized, agentResultParsedOk(parsed));

      state.evidence.push({
        type: "review",
        passed: transition === "close",
        summary:
          transition === "close"
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

      try {
        applyAdvance(state, transition as HarnessStep, statePath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        recordHarnessTransition(statePath, state, state.currentStep, transition as HarnessStep, {
          allowed: false,
          reason,
          trigger: "bfh-verify",
        });
        throw error;
      }
      writeState(statePath, state);
      syncMetricsSnapshot(statePath, state);
      setBfhProgressStatus(ctx, state);
      writeReviewedMarker(statePath, state);
      appendBriefProgress(statePath, "verify_review", `${transition}: ${normalized.summary}`);

      ctx.ui.notify(
        [stateToolText(statePath, state), "", "Reviewer summary:", normalized.summary].join("\n"),
        state.currentStep === "failed" ? "error" : "info",
      );
    },
  });

  pi.registerCommand("bfh-close", {
    description: "Run close helper and create a draft PR. Usage: /bfh-close [TICKET-123|state-path]",
    handler: async (args, ctx) => {
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found to close.", "warning");
        return;
      }

      const state = readState(statePath);
      recordHarnessCommand(statePath, state, "bfh-close");

      let result;
      try {
        result = executeCloseCreate(ctx.cwd, statePath, state, {
          pushBranch: true,
          autoAdvanceRetro: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Close helper failed: ${message}`, "error");
        return;
      }

      if (!result.ok) {
        setBfhProgressStatus(ctx, state);
        ctx.ui.notify(
          [
            "Close helper blocked:",
            ...(result.reasons || []).map((r) => `- ${r}`),
            "",
            "Draft PR body if blockers are resolved:",
            result.prBody,
          ].join("\n"),
          "warning",
        );
        return;
      }

      writeState(statePath, state);
      syncMetricsSnapshot(statePath, state);
      setBfhProgressStatus(ctx, state);
      ctx.ui.notify(
        [
          stateToolText(statePath, state),
          "",
          `Draft PR: ${result.prUrl}`,
          `Base: ${result.baseBranch}`,
          `Head: ${result.headBranch}`,
          result.created ? "Created new draft PR." : "Reused existing draft PR.",
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("bfh-pr-sync", {
    description: "Sync GitHub PR review status into state. Usage: /bfh-pr-sync [TICKET-123|state-path]",
    handler: async (args, ctx) => {
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found.", "warning");
        return;
      }

      const state = readState(statePath);
      recordHarnessCommand(statePath, state, "bfh-pr-sync");
      const prUrl = String(state.pr.url || "").trim();
      if (!prUrl) {
        ctx.ui.notify("No PR URL on state. Run /bfh-close first.", "warning");
        return;
      }

      try {
        const snapshot = syncPrReviewFromGitHub(ctx.cwd, prUrl);
        applyPrSnapshotToState(state, snapshot);
        const { transition, outcome } = resolvePrReviewTransitionFromOutcome(state, snapshot);

        let advanced = false;
        if (state.currentStep === "pr_review" && transition !== state.currentStep) {
          applyAdvance(state, transition, statePath);
          advanced = true;
        }

        state.evidence.push({
          type: "note",
          summary: `GitHub PR sync: ${snapshot.reviewDecision}`,
          createdAt: new Date().toISOString(),
        });
        writeState(statePath, state);
        syncMetricsSnapshot(statePath, state);
        setBfhProgressStatus(ctx, state);
        writePrReviewMarker(statePath, state, snapshot);
        appendBriefProgress(statePath, "pr_review", `pr_sync: ${outcome}${advanced ? `, now ${state.currentStep}` : ""}`);

        ctx.ui.notify(
          [stateToolText(statePath, state), "", formatPrReviewSummary(snapshot)].join("\n"),
          snapshot.reviewDecision === "APPROVED" ? "info" : "warning",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pr_sync failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("bfh-retro", {
    description: "Run retrospective helper: append LEARNINGS.md, stage amendments. Usage: /bfh-retro [TICKET]",
    handler: async (args, ctx) => {
      const explicit = resolveStatePathFromArg(ctx.cwd, args || "");
      const statePath = explicit || activeStatePathFromSession(ctx) || listStateFiles(ctx.cwd)[0];
      if (!statePath || !fs.existsSync(statePath)) {
        ctx.ui.notify("No lean BFH state found for retro.", "warning");
        return;
      }

      const state = readState(statePath);
      recordHarnessCommand(statePath, state, "bfh-retro");
      const result = runRetro(ctx.cwd, statePath, state);
      syncMetricsSnapshot(statePath, state);
      setBfhProgressStatus(ctx, state);
      appendBriefProgress(statePath, "retro", "Retro helper ran.");
      ctx.ui.notify(
        [
          stateToolText(statePath, state),
          "",
          result.appendedLearning ? `Appended to ${result.learningsPath}` : "Learning already recorded.",
          result.amendmentPath ? `Amendment: ${result.amendmentPath}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        "info",
      );
    },
  });
}
