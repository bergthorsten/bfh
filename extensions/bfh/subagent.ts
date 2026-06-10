import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ensureBfhSubagentDefinitions } from "./bfh-agents.ts";
import { readPrinciplesExcerpt } from "./harness-docs.ts";
import { recordSubagentRun } from "./metrics.ts";
import { shouldRetryAgentParse } from "./normalize.ts";
import {
  extractTextFromSubagentResult,
  metricsFromSubagentResult,
  runSubagentViaPiSubagents,
  type PiSubagentParams,
} from "./pi-subagents-bridge.ts";
import type { HarnessState, SubagentRunResult } from "./types.ts";

function buildScoutPrompt(scoutInput: string): string {
  return ["## Ticket + repository context", "", scoutInput].join("\n");
}

function buildReviewerPrompt(reviewerInput: string, cwd?: string): string {
  const parts: string[] = [];
  if (cwd) {
    const principles = readPrinciplesExcerpt(cwd);
    if (principles) {
      parts.push("## Repo principles (cite via principleRef)", "", principles);
    }
  }
  parts.push("## Ticket + implementation context", "", reviewerInput);
  return parts.join("\n");
}

function buildSubagentParams(
  agent: "scout" | "reviewer",
  task: string,
  options: { model?: string; description?: string },
): PiSubagentParams {
  return {
    agent,
    task,
    ...(options.description ? { description: options.description } : {}),
    ...(options.model ? { model: options.model } : {}),
  };
}

async function runHarnessSubagent(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  cwd: string;
  agent: "scout" | "reviewer";
  task: string;
  label: string;
  description?: string;
  model?: string;
  signal?: AbortSignal;
  statePath?: string;
  state?: HarnessState;
}): Promise<SubagentRunResult> {
  if (options.signal?.aborted) {
    throw new Error(`${options.label} subagent aborted.`);
  }

  ensureBfhSubagentDefinitions(options.cwd);

  const startedAt = Date.now();
  const params = buildSubagentParams(options.agent, options.task, {
    model: options.model,
    description: options.description,
  });

  const response = await runSubagentViaPiSubagents(options.pi, options.ctx, params, {
    signal: options.signal,
  });

  const text = extractTextFromSubagentResult(response);
  const { exitCode, toolCalls } = metricsFromSubagentResult(response);

  const result: SubagentRunResult = {
    text,
    stderr: "",
    exitCode,
    usedSubagent: true,
  };

  if (options.statePath) {
    recordSubagentRun(options.statePath, options.state, {
      role: options.agent,
      durationMs: Date.now() - startedAt,
      exitCode,
      model: options.model,
      toolCalls,
    });
  }

  return result;
}

export async function runFreshReviewViaSubagent(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  cwd: string;
  reviewerInput: string;
  systemPrompt?: string;
  model?: string;
  signal?: AbortSignal;
  statePath?: string;
  state?: HarnessState;
}): Promise<SubagentRunResult> {
  let task = buildReviewerPrompt(options.reviewerInput, options.cwd);
  if (options.systemPrompt?.trim()) {
    task = [options.systemPrompt.trim(), "", task].join("\n");
  }
  return runHarnessSubagent({
    pi: options.pi,
    ctx: options.ctx,
    cwd: options.cwd,
    agent: "reviewer",
    task,
    label: "Fresh review",
    description: "Fresh code review",
    model: options.model,
    signal: options.signal,
    statePath: options.statePath,
    state: options.state,
  });
}

export async function runScoutViaSubagent(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  cwd: string;
  scoutInput: string;
  model?: string;
  signal?: AbortSignal;
  statePath?: string;
  state?: HarnessState;
}): Promise<SubagentRunResult> {
  const task = buildScoutPrompt(options.scoutInput);
  return runHarnessSubagent({
    pi: options.pi,
    ctx: options.ctx,
    cwd: options.cwd,
    agent: "scout",
    task,
    label: "Scout",
    description: "Scout reconnaissance",
    model: options.model,
    signal: options.signal,
    statePath: options.statePath,
    state: options.state,
  });
}

async function runWithAgentResultRetry(
  run: () => Promise<SubagentRunResult>,
  onRetry?: () => void,
): Promise<SubagentRunResult> {
  const first = await run();
  if (!shouldRetryAgentParse(first.text)) return first;
  onRetry?.();
  return run();
}

export async function runScoutViaSubagentWithRetry(
  options: Parameters<typeof runScoutViaSubagent>[0],
): Promise<SubagentRunResult> {
  return runWithAgentResultRetry(
    () => runScoutViaSubagent(options),
    () => {
      if (options.statePath) {
        recordSubagentRun(options.statePath, options.state, {
          role: "scout",
          durationMs: 0,
          exitCode: 0,
          model: options.model,
          parseRetry: true,
        });
      }
    },
  );
}

export async function runFreshReviewViaSubagentWithRetry(
  options: Parameters<typeof runFreshReviewViaSubagent>[0],
): Promise<SubagentRunResult> {
  return runWithAgentResultRetry(
    () => runFreshReviewViaSubagent(options),
    () => {
      if (options.statePath) {
        recordSubagentRun(options.statePath, options.state, {
          role: "reviewer",
          durationMs: 0,
          exitCode: 0,
          model: options.model,
          parseRetry: true,
        });
      }
    },
  );
}
