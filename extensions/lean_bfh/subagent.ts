import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadAgentPrompt } from "./prompt-loader.ts";
import { recordSubagentRun } from "./metrics.ts";
import { shouldRetryAgentParse } from "./normalize.ts";
import {
  extractTextFromSubagentResponse,
  metricsFromSubagentResponse,
  runSubagentViaPiSubagents,
  type PiSubagentParams,
} from "./pi-subagents-bridge.ts";
import type { HarnessState, SubagentRunResult } from "./types.ts";

function buildSubagentReviewerTask(systemPrompt: string, reviewerInput: string): string {
  return [systemPrompt, "", "## Ticket + implementation context", reviewerInput].join("\n");
}

function buildScoutSubagentTask(scoutPrompt: string, scoutInput: string): string {
  return [scoutPrompt, "", "## Ticket + repository context", scoutInput].join("\n");
}

function buildSubagentParams(
  agent: "scout" | "reviewer",
  task: string,
  options: { cwd: string; model?: string },
): PiSubagentParams {
  return {
    agent,
    task,
    context: "fresh",
    progress: true,
    ...(options.model ? { model: options.model } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
}

async function runHarnessSubagent(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  cwd: string;
  agent: "scout" | "reviewer";
  task: string;
  label: string;
  model?: string;
  signal?: AbortSignal;
  statePath?: string;
  state?: HarnessState;
}): Promise<SubagentRunResult> {
  if (options.signal?.aborted) {
    throw new Error(`${options.label} subagent aborted.`);
  }

  const startedAt = Date.now();
  const params = buildSubagentParams(options.agent, options.task, {
    cwd: options.cwd,
    model: options.model,
  });

  const response = await runSubagentViaPiSubagents(options.pi, options.ctx, params, {
    signal: options.signal,
  });

  const text = extractTextFromSubagentResponse(response);
  const { exitCode, toolCalls } = metricsFromSubagentResponse(response);

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
  const systemPrompt = options.systemPrompt ?? loadAgentPrompt("reviewer");
  const task = buildSubagentReviewerTask(systemPrompt, options.reviewerInput);
  return runHarnessSubagent({
    pi: options.pi,
    ctx: options.ctx,
    cwd: options.cwd,
    agent: "reviewer",
    task,
    label: "Fresh review",
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
  const scoutPrompt = loadAgentPrompt("scout");
  const task = buildScoutSubagentTask(scoutPrompt, options.scoutInput);
  return runHarnessSubagent({
    pi: options.pi,
    ctx: options.ctx,
    cwd: options.cwd,
    agent: "scout",
    task,
    label: "Scout",
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
