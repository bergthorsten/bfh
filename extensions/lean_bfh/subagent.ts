import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { loadAgentPrompt } from "./prompt-loader.ts";
import { shouldRetryAgentParse } from "./normalize.ts";
import type { PiJsonContentPart, PiJsonEvent, PiJsonMessage, SubagentRunResult } from "./types.ts";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

function extractAssistantText(message: PiJsonMessage | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is PiJsonContentPart & { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function hasSubagentToolCall(message: PiJsonMessage | undefined): boolean {
  const content = message?.content;
  return (
    Array.isArray(content) && content.some((part) => part?.type === "toolCall" && part?.name === "subagent")
  );
}

function buildSubagentReviewerTask(systemPrompt: string, reviewerInput: string): string {
  return [systemPrompt, "", "## Ticket + implementation context", reviewerInput].join("\n");
}

function buildScoutSubagentTask(scoutPrompt: string, scoutInput: string): string {
  return [scoutPrompt, "", "## Ticket + repository context", scoutInput].join("\n");
}

function buildSubagentInvocationPrompt(agent: "reviewer" | "scout", task: string): string {
  return [
    `Use the \`subagent\` tool to run a fresh-context \`${agent}\` agent exactly once.`,
    "Do not perform the requested work directly in this parent agent.",
    `After the subagent returns, output only the ${agent} output text (including the AGENT_RESULT block).`,
    "",
    "Call shape:",
    `subagent({ agent: \"${agent}\", task: <task>, context: \"fresh\", output: false, progress: false })`,
    "",
    "Task:",
    "```",
    task,
    "```",
  ].join("\n");
}

export function buildSubagentOrchestrationPrompt(systemPrompt: string, reviewerInput: string): string {
  const reviewerTask = buildSubagentReviewerTask(systemPrompt, reviewerInput);
  return buildSubagentInvocationPrompt("reviewer", reviewerTask);
}

export function buildScoutSubagentOrchestrationPrompt(scoutInput: string): string {
  const scoutPrompt = loadAgentPrompt("scout");
  return buildSubagentInvocationPrompt("scout", buildScoutSubagentTask(scoutPrompt, scoutInput));
}

async function runSubagentOrchestration(options: {
  cwd: string;
  orchestrationPrompt: string;
  tmpPrefix: string;
  label: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<SubagentRunResult> {
  if (options.signal?.aborted) {
    throw new Error(`${options.label} subagent aborted.`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), options.tmpPrefix));
  const inputPath = path.join(tmpDir, "input.md");
  fs.writeFileSync(inputPath, options.orchestrationPrompt, { encoding: "utf8" });

  const args = ["--mode", "json", "-p", "--no-session", "--tools", "subagent"];
  if (options.model) args.push("--model", options.model);
  args.push(`@${inputPath}`);

  const invocation = getPiInvocation(args);
  let stdoutBuffer = "";
  let stderr = "";
  let latestAssistantText = "";
  let latestSubagentToolText = "";
  let stopReason: string | undefined;
  let usedSubagent = false;
  let aborted = false;

  const proc = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const processLine = (line: string) => {
    if (!line.trim()) return;

    let event: PiJsonEvent;
    try {
      event = JSON.parse(line) as PiJsonEvent;
    } catch {
      return;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      if (hasSubagentToolCall(event.message)) usedSubagent = true;
      const text = extractAssistantText(event.message);
      if (text) latestAssistantText = text;
      if (typeof event.message.stopReason === "string") stopReason = event.message.stopReason;
    }

    if (event.type === "tool_result_end" && event.message?.toolName === "subagent") {
      usedSubagent = true;
      const text = extractAssistantText(event.message);
      if (text) latestSubagentToolText = text;
    }

    if (event.type === "turn_end" && Array.isArray(event.toolResults)) {
      for (const toolResult of event.toolResults) {
        if (toolResult.toolName === "subagent") {
          usedSubagent = true;
          const text = extractAssistantText(toolResult);
          if (text) latestSubagentToolText = text;
        }
      }
    }
  };

  const onAbort = () => {
    aborted = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  };

  if (options.signal) {
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.stdout.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      proc.on("error", (error) => reject(error));
      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        resolve(code ?? 0);
      });
    });

    if (aborted) throw new Error(`${options.label} subagent aborted.`);
    if (exitCode !== 0) {
      throw new Error(`${options.label} subagent failed (exit ${exitCode}): ${stderr.trim() || "no stderr output"}`);
    }
    if (!usedSubagent) {
      throw new Error(`${options.label} failed: subagent tool was not used by the runner.`);
    }

    return {
      text: latestAssistantText || latestSubagentToolText,
      stopReason,
      stderr,
      exitCode,
      usedSubagent,
    };
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runFreshReviewViaSubagent(options: {
  cwd: string;
  reviewerInput: string;
  systemPrompt?: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<SubagentRunResult> {
  const systemPrompt = options.systemPrompt ?? loadAgentPrompt("reviewer");
  return runSubagentOrchestration({
    cwd: options.cwd,
    orchestrationPrompt: buildSubagentOrchestrationPrompt(systemPrompt, options.reviewerInput),
    tmpPrefix: "pi-harness-review-",
    label: "Fresh review",
    model: options.model,
    signal: options.signal,
  });
}

export async function runScoutViaSubagent(options: {
  cwd: string;
  scoutInput: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<SubagentRunResult> {
  return runSubagentOrchestration({
    cwd: options.cwd,
    orchestrationPrompt: buildScoutSubagentOrchestrationPrompt(options.scoutInput),
    tmpPrefix: "pi-harness-scout-",
    label: "Scout",
    model: options.model,
    signal: options.signal,
  });
}

async function runWithAgentResultRetry(run: () => Promise<SubagentRunResult>): Promise<SubagentRunResult> {
  const first = await run();
  if (!shouldRetryAgentParse(first.text)) return first;
  return run();
}

export async function runScoutViaSubagentWithRetry(
  options: Parameters<typeof runScoutViaSubagent>[0],
): Promise<SubagentRunResult> {
  return runWithAgentResultRetry(() => runScoutViaSubagent(options));
}

export async function runFreshReviewViaSubagentWithRetry(
  options: Parameters<typeof runFreshReviewViaSubagent>[0],
): Promise<SubagentRunResult> {
  return runWithAgentResultRetry(() => runFreshReviewViaSubagent(options));
}
