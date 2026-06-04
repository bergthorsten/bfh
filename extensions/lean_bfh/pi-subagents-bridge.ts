/**
 * Run pi-subagents via the extension slash bridge (live TUI progress, Ctrl+O detail).
 * Event names match pi-subagents/src/shared/types.ts — requires pi-subagents loaded in the session.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/** Mirrors pi-subagents SLASH_* event constants. */
export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";

/** Mirrors pi-subagents SLASH_RESULT_TYPE. */
export const SLASH_RESULT_TYPE = "subagent-slash-result";

export type PiSubagentParams = {
  agent: string;
  task: string;
  context?: "fresh" | "fork";
  model?: string;
  progress?: boolean;
  cwd?: string;
};

type TextContent = { type: "text"; text: string };

type SubagentProgressEntry = {
  index?: number;
  agent?: string;
  status?: string;
  task?: string;
  currentTool?: string;
  toolCount?: number;
  finalOutput?: string;
  exitCode?: number;
  error?: string;
  messages?: Array<{ role?: string; content?: string | TextContent[] }>;
};

type SubagentDetails = {
  mode?: string;
  results?: SubagentProgressEntry[];
  progress?: SubagentProgressEntry[];
};

export type PiSubagentToolResult = {
  content: TextContent[];
  details?: SubagentDetails;
  isError?: boolean;
};

export type PiSubagentSlashResponse = {
  requestId: string;
  result: PiSubagentToolResult;
  isError: boolean;
  errorText?: string;
};

type PiSubagentSlashUpdate = {
  requestId: string;
  progress?: SubagentProgressEntry[];
  currentTool?: string;
  toolCount?: number;
};

type SlashLiveStateModule = {
  buildSlashInitialResult: (requestId: string, params: PiSubagentParams) => {
    requestId: string;
    result: PiSubagentToolResult;
  };
  finalizeSlashResult: (response: PiSubagentSlashResponse) => {
    requestId: string;
    result: PiSubagentToolResult;
  };
  failSlashResult: (
    requestId: string,
    params: PiSubagentParams,
    message: string,
  ) => { requestId: string; result: PiSubagentToolResult };
  applySlashUpdate: (requestId: string, update: PiSubagentSlashUpdate) => void;
};

let slashLiveStatePromise: Promise<SlashLiveStateModule | null> | undefined;

function loadSlashLiveState(): Promise<SlashLiveStateModule | null> {
  if (!slashLiveStatePromise) {
    slashLiveStatePromise = import("pi-subagents/src/slash/slash-live-state.ts")
      .then((mod) => mod as SlashLiveStateModule)
      .catch(() => null);
  }
  return slashLiveStatePromise;
}

function extractMessageText(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextContent => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function extractAssistantFromMessages(
  messages: SubagentProgressEntry["messages"],
): string {
  if (!messages?.length) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = extractMessageText(message.content);
    if (text) return text;
  }
  return "";
}

/** Full subagent output for AGENT_RESULT parsing (prefer finalOutput over truncated tool card text). */
export function extractTextFromSubagentResponse(response: PiSubagentSlashResponse): string {
  if (response.errorText?.trim()) return response.errorText;

  const inline = extractMessageText(response.result.content);
  const result = response.result.details?.results?.[0];
  if (!result) return inline;

  const candidates = [
    result.finalOutput,
    extractAssistantFromMessages(result.messages),
    inline,
  ];
  for (const text of candidates) {
    if (typeof text === "string" && text.trim()) return text;
  }
  return inline;
}

export function metricsFromSubagentResponse(response: PiSubagentSlashResponse): {
  exitCode: number;
  toolCalls?: number;
} {
  const first = response.result.details?.results?.[0];
  const progress = first?.progress ?? response.result.details?.progress?.[0];
  return {
    exitCode: response.isError ? 1 : (first?.exitCode ?? 0),
    toolCalls: progress?.toolCount,
  };
}

const START_TIMEOUT_MS = 15_000;

export function requestSubagentRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  requestId: string,
  params: PiSubagentParams,
  signal?: AbortSignal,
): Promise<PiSubagentSlashResponse> {
  return new Promise((resolve, reject) => {
    let done = false;
    let started = false;

    const finish = (next: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(startTimeout);
      unsubStarted();
      unsubResponse();
      signal?.removeEventListener("abort", onAbort);
      next();
    };

    const startTimeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            "Subagent bridge did not start within 15s. Install pi-subagents (`pi install npm:pi-subagents`) and reload.",
          ),
        ),
      );
    }, START_TIMEOUT_MS);

    const onStarted = (data: unknown) => {
      if (done || !data || typeof data !== "object") return;
      if ((data as { requestId?: unknown }).requestId !== requestId) return;
      started = true;
      clearTimeout(startTimeout);
    };

    const onResponse = (data: unknown) => {
      if (done || !data || typeof data !== "object") return;
      const response = data as Partial<PiSubagentSlashResponse>;
      if (response.requestId !== requestId) return;
      finish(() => resolve(response as PiSubagentSlashResponse));
    };

    const onAbort = () => {
      pi.events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId });
      finish(() => reject(new Error("Subagent aborted.")));
    };

    const unsubStarted = pi.events.on(SLASH_SUBAGENT_STARTED_EVENT, onStarted);
    const unsubResponse = pi.events.on(SLASH_SUBAGENT_RESPONSE_EVENT, onResponse);
    signal?.addEventListener("abort", onAbort, { once: true });

    pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params });

    if (!started && done) return;
    if (!started) {
      finish(() =>
        reject(
          new Error(
            "No subagent slash bridge responded. Install pi-subagents (`pi install npm:pi-subagents`) and reload.",
          ),
        ),
      );
    }
  });
}

/**
 * Run a single fresh-context subagent with pi-subagents UI (streaming card, Ctrl+O detail).
 */
export async function runSubagentViaPiSubagents(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: PiSubagentParams,
  options?: { signal?: AbortSignal; showInChat?: boolean },
): Promise<PiSubagentSlashResponse> {
  const requestId = randomUUID();
  const showInChat = options?.showInChat !== false && ctx.hasUI;
  const slash = showInChat ? await loadSlashLiveState() : null;

  if (showInChat && slash) {
    const initial = slash.buildSlashInitialResult(requestId, params);
    const initialText = extractMessageText(initial.result.content) || `Running ${params.agent}…`;
    pi.sendMessage({
      customType: SLASH_RESULT_TYPE,
      content: initialText,
      display: true,
      details: initial,
    });
  }

  const unsubUpdate = pi.events.on(SLASH_SUBAGENT_UPDATE_EVENT, (data) => {
    if (!data || typeof data !== "object") return;
    const update = data as PiSubagentSlashUpdate;
    if (update.requestId !== requestId) return;
    slash?.applySlashUpdate(requestId, update);
    if (!ctx.hasUI) return;
    const tool = update.currentTool ? ` ${update.currentTool}` : "";
    const count = update.toolCount ?? 0;
    ctx.ui.setStatus("bfh-subagent", `${params.agent} · ${count} tools${tool} | Ctrl+O live detail`);
  });

  try {
    const response = await requestSubagentRun(pi, ctx, requestId, params, options?.signal);

    if (showInChat && slash) {
      const finalDetails = slash.finalizeSlashResult(response);
      const finalText =
        extractTextFromSubagentResponse(response) || extractMessageText(finalDetails.result.content);
      pi.sendMessage({
        customType: SLASH_RESULT_TYPE,
        content: finalText || "(no output)",
        display: true,
        details: finalDetails,
      });
    }

    if (response.isError) {
      throw new Error(response.errorText || extractMessageText(response.result.content) || "Subagent failed");
    }

    return response;
  } catch (error) {
    if (showInChat && slash) {
      const message = error instanceof Error ? error.message : String(error);
      const failedDetails = slash.failSlashResult(requestId, params, message);
      pi.sendMessage({
        customType: SLASH_RESULT_TYPE,
        content: message,
        display: true,
        details: failedDetails,
      });
    }
    throw error;
  } finally {
    unsubUpdate();
    if (ctx.hasUI) ctx.ui.setStatus("bfh-subagent", undefined);
  }
}
