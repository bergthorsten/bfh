import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  EVENT_COMPLETED,
  EVENT_FAILED,
  extractTextFromSubagentResponse,
  extractTextFromSubagentResult,
  metricsFromSubagentResponse,
  metricsFromSubagentResult,
  RPC_PING,
  RPC_SPAWN,
  RPC_STOP,
  spawnSubagentViaRpc,
  waitForAgentCompletion,
  type PiSubagentRunResult,
} from "../pi-subagents-bridge.ts";

type RpcReply<T = void> = { success: true; data?: T } | { success: false; error: string };

function createMockPi(options?: {
  onRpc?: (channel: string, payload: Record<string, unknown>) => void;
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
        if (event === RPC_PING || event === RPC_SPAWN || event === RPC_STOP) {
          options?.onRpc?.(event, data as Record<string, unknown>);
        }
        for (const handler of listeners.get(event) ?? []) handler(data);
      },
    },
  } as ExtensionAPI;
}

const mockCtx = { hasUI: false } as ExtensionContext;

describe("pi-subagents-bridge", () => {
  describe("extractTextFromSubagentResult", () => {
    test("returns result text", () => {
      const result: PiSubagentRunResult = {
        agentId: "abc",
        text: "<<<AGENT_RESULT\n{}\nAGENT_RESULT>>>",
        toolUses: 3,
        durationMs: 1000,
        isError: false,
        status: "completed",
      };
      expect(extractTextFromSubagentResult(result)).toBe("<<<AGENT_RESULT\n{}\nAGENT_RESULT>>>");
    });

    test("prefers error when set", () => {
      const result: PiSubagentRunResult = {
        agentId: "abc",
        text: "",
        toolUses: 0,
        durationMs: 100,
        isError: true,
        error: "agent crashed",
        status: "error",
      };
      expect(extractTextFromSubagentResult(result)).toBe("agent crashed");
    });
  });

  describe("extractTextFromSubagentResponse (legacy)", () => {
    test("prefers errorText when set", () => {
      expect(
        extractTextFromSubagentResponse({
          errorText: "bridge failure",
          isError: true,
          result: { content: [{ type: "text", text: "x" }] },
        }),
      ).toBe("bridge failure");
    });

    test("prefers finalOutput over truncated tool card text", () => {
      const agentBlock = `<<<AGENT_RESULT\n{"status":"completed"}\nAGENT_RESULT>>>`;
      expect(
        extractTextFromSubagentResponse({
          result: {
            content: [{ type: "text", text: "truncated card text" }],
            details: { results: [{ finalOutput: agentBlock, exitCode: 0 }] },
          },
        }),
      ).toBe(agentBlock);
    });
  });

  describe("metricsFromSubagentResult", () => {
    test("maps toolUses and error flag", () => {
      expect(
        metricsFromSubagentResult({
          agentId: "x",
          text: "ok",
          toolUses: 7,
          durationMs: 500,
          isError: false,
          status: "completed",
        }),
      ).toEqual({ exitCode: 0, toolCalls: 7 });
    });

    test("forces exitCode 1 when isError", () => {
      expect(
        metricsFromSubagentResult({
          agentId: "x",
          text: "fail",
          toolUses: 2,
          durationMs: 500,
          isError: true,
          status: "error",
        }),
      ).toEqual({ exitCode: 1, toolCalls: 2 });
    });
  });

  describe("metricsFromSubagentResponse (legacy)", () => {
    test("forces exitCode 1 when isError", () => {
      expect(
        metricsFromSubagentResponse({
          isError: true,
          result: { details: { results: [{ exitCode: 0 }] } },
        }),
      ).toEqual({ exitCode: 1, toolCalls: undefined });
    });
  });

  describe("spawnSubagentViaRpc", () => {
    test("returns agent id from spawn RPC reply", async () => {
      const pi = createMockPi({
        onRpc(channel, payload) {
          if (channel !== RPC_SPAWN) return;
          const requestId = payload.requestId as string;
          const reply: RpcReply<{ id: string }> = { success: true, data: { id: "agent-123" } };
          pi.events.emit(`${RPC_SPAWN}:reply:${requestId}`, reply);
        },
      });

      const id = await spawnSubagentViaRpc(pi, "scout", "explore auth", {
        description: "Scout reconnaissance",
      });
      expect(id).toBe("agent-123");
    });

    test("rejects when spawn RPC fails", async () => {
      const pi = createMockPi({
        onRpc(channel, payload) {
          if (channel !== RPC_SPAWN) return;
          const requestId = payload.requestId as string;
          pi.events.emit(`${RPC_SPAWN}:reply:${requestId}`, {
            success: false,
            error: "No active session",
          });
        },
      });

      await expect(
        spawnSubagentViaRpc(pi, "scout", "task", { description: "Scout" }),
      ).rejects.toThrow("No active session");
    });
  });

  describe("waitForAgentCompletion", () => {
    test("resolves on subagents:completed for matching agent", async () => {
      const pi = createMockPi();
      const pending = waitForAgentCompletion(pi, "agent-42");
      pi.events.emit(EVENT_COMPLETED, {
        id: "agent-42",
        type: "scout",
        result: "done",
        status: "completed",
        toolUses: 4,
        durationMs: 2000,
      });
      const event = await pending;
      expect(event.result).toBe("done");
      expect(event.toolUses).toBe(4);
    });

    test("resolves on subagents:failed for matching agent", async () => {
      const pi = createMockPi();
      const pending = waitForAgentCompletion(pi, "agent-99");
      pi.events.emit(EVENT_FAILED, {
        id: "agent-99",
        type: "reviewer",
        error: "timeout",
        status: "error",
        toolUses: 1,
        durationMs: 500,
      });
      const event = await pending;
      expect(event.error).toBe("timeout");
    });

    test("ignores events for other agents", async () => {
      const pi = createMockPi();
      const pending = waitForAgentCompletion(pi, "target-id");
      pi.events.emit(EVENT_COMPLETED, {
        id: "other-id",
        type: "scout",
        result: "wrong",
        status: "completed",
        toolUses: 1,
        durationMs: 100,
      });
      pi.events.emit(EVENT_COMPLETED, {
        id: "target-id",
        type: "scout",
        result: "right",
        status: "completed",
        toolUses: 2,
        durationMs: 200,
      });
      const event = await pending;
      expect(event.result).toBe("right");
    });

    test("rejects on abort signal and emits stop RPC", async () => {
      let stopCalled = false;
      const pi = createMockPi({
        onRpc(channel, payload) {
          if (channel === RPC_STOP) {
            stopCalled = true;
            expect(payload.agentId).toBe("agent-abort");
            const requestId = payload.requestId as string;
            pi.events.emit(`${RPC_STOP}:reply:${requestId}`, { success: true });
          }
        },
      });
      const controller = new AbortController();
      const pending = waitForAgentCompletion(pi, "agent-abort", controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow("Subagent aborted.");
      expect(stopCalled).toBe(true);
    });
  });
});
