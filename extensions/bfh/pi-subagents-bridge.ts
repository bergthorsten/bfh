/**
 * Run @tintinweb/pi-subagents via cross-extension RPC (subagents:rpc:*).
 * Requires @tintinweb/pi-subagents loaded in the session.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const RPC_PING = "subagents:rpc:ping";
export const RPC_SPAWN = "subagents:rpc:spawn";
export const RPC_STOP = "subagents:rpc:stop";
export const EVENT_COMPLETED = "subagents:completed";
export const EVENT_FAILED = "subagents:failed";
export const EVENT_STARTED = "subagents:started";

const RPC_TIMEOUT_MS = 15_000;
const PING_TIMEOUT_MS = 5_000;

export type PiSubagentParams = {
  /** Agent type name (e.g. scout, reviewer). */
  agent: string;
  /** Task prompt — ticket/repo context for the subagent. */
  task: string;
  /** Short UI label (3–5 words). */
  description?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
};

export type PiSubagentLifecycleEvent = {
  id: string;
  type: string;
  description?: string;
  result?: string;
  error?: string;
  status: string;
  toolUses: number;
  durationMs: number;
};

export type PiSubagentRunResult = {
  agentId: string;
  text: string;
  toolUses: number;
  durationMs: number;
  isError: boolean;
  error?: string;
  status: string;
};

type RpcReply<T = void> = { success: true; data?: T } | { success: false; error: string };

function installHint(): string {
  return "Install @tintinweb/pi-subagents (`pi install npm:@tintinweb/pi-subagents`) and reload.";
}

function rpcCall<T>(
  pi: ExtensionAPI,
  channel: string,
  payload: Record<string, unknown>,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<T> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;

    const timeout = setTimeout(() => {
      unsub?.();
      reject(new Error(`Subagent RPC "${channel}" timed out after ${timeoutMs / 1000}s.`));
    }, timeoutMs);

    unsub = pi.events.on(`${channel}:reply:${requestId}`, (reply) => {
      clearTimeout(timeout);
      unsub?.();
      const envelope = reply as RpcReply<T>;
      if (!envelope?.success) {
        reject(new Error(envelope?.error ?? `RPC ${channel} failed`));
        return;
      }
      resolve(envelope.data as T);
    });

    pi.events.emit(channel, { requestId, ...payload });
  });
}

/** Ping the subagents extension RPC; throws if unavailable. */
export async function ensureSubagentsAvailable(pi: ExtensionAPI): Promise<void> {
  try {
    await rpcCall<{ version: number }>(pi, RPC_PING, {}, PING_TIMEOUT_MS);
  } catch {
    throw new Error(`Subagents extension not available. ${installHint()}`);
  }
}

/** Extract full subagent output text for AGENT_RESULT parsing. */
export function extractTextFromSubagentResult(result: PiSubagentRunResult): string {
  if (result.error?.trim()) return result.error;
  return result.text.trim();
}

/** Back-compat alias for tests migrating from slash response shape. */
export function extractTextFromSubagentResponse(result: {
  errorText?: string;
  result?: { content?: Array<{ type: string; text: string }>; details?: { results?: Array<{ finalOutput?: string; messages?: Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }> }> } };
  isError?: boolean;
}): string {
  if (result.errorText?.trim()) return result.errorText;
  const inline =
    result.result?.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const first = result.result?.details?.results?.[0];
  if (!first) return inline;
  const fromMessages = (() => {
    if (!first.messages?.length) return "";
    for (let i = first.messages.length - 1; i >= 0; i--) {
      const message = first.messages[i];
      if (message?.role !== "assistant") continue;
      const content = message.content;
      if (typeof content === "string" && content.trim()) return content;
      if (Array.isArray(content)) {
        const text = content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text!)
          .join("\n");
        if (text.trim()) return text;
      }
    }
    return "";
  })();
  for (const candidate of [first.finalOutput, fromMessages, inline]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return inline;
}

export function metricsFromSubagentResult(result: PiSubagentRunResult): {
  exitCode: number;
  toolCalls?: number;
} {
  return {
    exitCode: result.isError ? 1 : 0,
    toolCalls: result.toolUses,
  };
}

/** Back-compat alias for legacy slash-response tests. */
export function metricsFromSubagentResponse(response: {
  isError?: boolean;
  result?: { details?: { results?: Array<{ exitCode?: number; progress?: { toolCount?: number } }> } };
}): { exitCode: number; toolCalls?: number } {
  const first = response.result?.details?.results?.[0];
  return {
    exitCode: response.isError ? 1 : (first?.exitCode ?? 0),
    toolCalls: first?.progress?.toolCount,
  };
}

function lifecycleToRunResult(agentId: string, event: PiSubagentLifecycleEvent): PiSubagentRunResult {
  const isError =
    event.status === "error" || event.status === "stopped" || event.status === "aborted";
  const text = event.result ?? event.error ?? "";
  return {
    agentId,
    text,
    toolUses: event.toolUses,
    durationMs: event.durationMs,
    isError,
    error: event.error,
    status: event.status,
  };
}

/** Wait for a background agent to finish (subagents:completed or subagents:failed). */
export function waitForAgentCompletion(
  pi: ExtensionAPI,
  agentId: string,
  signal?: AbortSignal,
): Promise<PiSubagentLifecycleEvent> {
  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      unsubCompleted();
      unsubFailed();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const match = (data: unknown): PiSubagentLifecycleEvent | undefined => {
      if (!data || typeof data !== "object") return undefined;
      const event = data as PiSubagentLifecycleEvent;
      return event.id === agentId ? event : undefined;
    };

    const onTerminal = (data: unknown) => {
      const event = match(data);
      if (event) finish(() => resolve(event));
    };

    const onAbort = () => {
      void rpcCall<void>(pi, RPC_STOP, { agentId }).catch(() => {});
      finish(() => reject(new Error("Subagent aborted.")));
    };

    const unsubCompleted = pi.events.on(EVENT_COMPLETED, onTerminal);
    const unsubFailed = pi.events.on(EVENT_FAILED, onTerminal);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Spawn a subagent via RPC and return its ID. */
export async function spawnSubagentViaRpc(
  pi: ExtensionAPI,
  type: string,
  prompt: string,
  options: {
    description: string;
    model?: string;
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    isBackground?: boolean;
  },
): Promise<string> {
  const spawnOptions: Record<string, unknown> = {
    description: options.description,
    isBackground: options.isBackground ?? true,
  };
  if (options.model) spawnOptions.model = options.model;
  if (options.thinking) spawnOptions.thinking = options.thinking;

  const data = await rpcCall<{ id: string }>(pi, RPC_SPAWN, {
    type,
    prompt,
    options: spawnOptions,
  });
  if (!data?.id) throw new Error("Subagent spawn returned no agent ID.");
  return data.id;
}

/**
 * Run a BFH subagent (scout/reviewer) with @tintinweb/pi-subagents live widget UI.
 * Spawns in background (required for lifecycle events), waits for completion.
 */
export async function runSubagentViaPiSubagents(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: PiSubagentParams,
  options?: { signal?: AbortSignal },
): Promise<PiSubagentRunResult> {
  await ensureSubagentsAvailable(pi);

  const description =
    params.description ??
    (params.agent === "scout" ? "Scout reconnaissance" : "Fresh code review");

  const unsubStarted = pi.events.on(EVENT_STARTED, (data) => {
    if (!ctx.hasUI || !data || typeof data !== "object") return;
    const event = data as PiSubagentLifecycleEvent;
    if (event.type !== params.agent) return;
    ctx.ui.setStatus("bfh-subagent", `${params.agent} · running | see Agents widget`);
  });

  try {
    const agentId = await spawnSubagentViaRpc(pi, params.agent, params.task, {
      description,
      model: params.model,
      thinking: params.thinking,
      isBackground: true,
    });

    const lifecycle = await waitForAgentCompletion(pi, agentId, options?.signal);
    const result = lifecycleToRunResult(agentId, lifecycle);

    if (result.isError) {
      throw new Error(result.error || result.text || "Subagent failed");
    }

    return result;
  } finally {
    unsubStarted();
    if (ctx.hasUI) ctx.ui.setStatus("bfh-subagent", undefined);
  }
}
