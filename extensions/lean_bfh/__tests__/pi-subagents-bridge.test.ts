import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  extractTextFromSubagentResponse,
  metricsFromSubagentResponse,
  requestSubagentRun,
  SLASH_SUBAGENT_REQUEST_EVENT,
  SLASH_SUBAGENT_RESPONSE_EVENT,
  SLASH_SUBAGENT_STARTED_EVENT,
  type PiSubagentParams,
  type PiSubagentSlashResponse,
} from "../pi-subagents-bridge.ts";

function makeResponse(overrides: Partial<PiSubagentSlashResponse> = {}): PiSubagentSlashResponse {
  return {
    requestId: "req-1",
    isError: false,
    result: {
      content: [{ type: "text", text: "truncated card text" }],
      details: { mode: "single", results: [], progress: [] },
    },
    ...overrides,
  };
}

function createMockPi(options?: {
  bridge?: (request: { requestId: string; params: PiSubagentParams }) => void;
}): ExtensionAPI {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    events: {
      on(event: string, handler: (data: unknown) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
        return () => listeners.get(event)?.delete(handler);
      },
      emit(event: string, data: unknown) {
        if (event === SLASH_SUBAGENT_REQUEST_EVENT && options?.bridge) {
          options.bridge(data as { requestId: string; params: PiSubagentParams });
        }
        for (const handler of listeners.get(event) ?? []) handler(data);
      },
    },
  } as ExtensionAPI;
}

const mockCtx = { hasUI: false } as ExtensionContext;

describe("pi-subagents-bridge", () => {
  describe("extractTextFromSubagentResponse", () => {
    test("prefers errorText when set", () => {
      const text = extractTextFromSubagentResponse(
        makeResponse({ errorText: "bridge failure", isError: true }),
      );
      expect(text).toBe("bridge failure");
    });

    test("prefers finalOutput over truncated tool card text", () => {
      const agentBlock = `<<<AGENT_RESULT\n{"status":"completed"}\nAGENT_RESULT>>>`;
      const text = extractTextFromSubagentResponse(
        makeResponse({
          result: {
            content: [{ type: "text", text: "truncated card text" }],
            details: {
              mode: "single",
              results: [{ finalOutput: agentBlock, exitCode: 0 }],
            },
          },
        }),
      );
      expect(text).toBe(agentBlock);
    });

    test("falls back to last assistant message when finalOutput missing", () => {
      const agentBlock = "assistant full reply with AGENT_RESULT";
      const text = extractTextFromSubagentResponse(
        makeResponse({
          result: {
            content: [{ type: "text", text: "short" }],
            details: {
              mode: "single",
              results: [
                {
                  messages: [
                    { role: "user", content: "go" },
                    { role: "assistant", content: agentBlock },
                  ],
                },
              ],
            },
          },
        }),
      );
      expect(text).toBe(agentBlock);
    });

    test("uses inline content when no details", () => {
      const text = extractTextFromSubagentResponse(
        makeResponse({
          result: { content: [{ type: "text", text: "only inline" }] },
        }),
      );
      expect(text).toBe("only inline");
    });
  });

  describe("metricsFromSubagentResponse", () => {
    test("reads exitCode and toolCount from first result", () => {
      const metrics = metricsFromSubagentResponse(
        makeResponse({
          result: {
            content: [{ type: "text", text: "ok" }],
            details: {
              mode: "single",
              results: [{ exitCode: 0, progress: { toolCount: 7 } as never }],
            },
          },
        }),
      );
      expect(metrics.exitCode).toBe(0);
      expect(metrics.toolCalls).toBe(7);
    });

    test("forces exitCode 1 when isError", () => {
      const metrics = metricsFromSubagentResponse(
        makeResponse({
          isError: true,
          result: {
            content: [{ type: "text", text: "fail" }],
            details: { mode: "single", results: [{ exitCode: 0 }] },
          },
        }),
      );
      expect(metrics.exitCode).toBe(1);
    });
  });

  describe("requestSubagentRun", () => {
    test("resolves when slash bridge emits started then response", async () => {
      const requestId = "test-req";
      const params: PiSubagentParams = { agent: "scout", task: "explore auth", context: "fresh" };
      const expected = makeResponse({ requestId, result: { content: [{ type: "text", text: "done" }] } });

      const pi = createMockPi({
        bridge: ({ requestId: id }) => {
          pi.events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: id });
          pi.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, expected);
        },
      });

      const response = await requestSubagentRun(pi, mockCtx, requestId, params);
      expect(response.requestId).toBe(requestId);
      expect(extractTextFromSubagentResponse(response)).toBe("done");
    });

    test("rejects when no bridge responds", async () => {
      const pi = createMockPi();
      await expect(
        requestSubagentRun(pi, mockCtx, "orphan", { agent: "scout", task: "x" }),
      ).rejects.toThrow(/No subagent slash bridge responded/);
    });

    test("rejects on abort signal", async () => {
      const pi = createMockPi({
        bridge: ({ requestId }) => {
          pi.events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
        },
      });
      const controller = new AbortController();
      const pending = requestSubagentRun(
        pi,
        mockCtx,
        "abort-req",
        { agent: "reviewer", task: "review" },
        controller.signal,
      );
      controller.abort();
      await expect(pending).rejects.toThrow("Subagent aborted.");
    });
  });
});
