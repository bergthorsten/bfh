import { describe, expect, test } from "bun:test";
import { AGENT_RESULT_END, AGENT_RESULT_START, agentResultParsedOk, parseAgentResult } from "../agent-result.ts";

describe("parseAgentResult", () => {
  test("parses valid block using last start delimiter", () => {
    const body = {
      status: "completed",
      summary: "ok",
      findings: {},
      artifacts: {},
      error: null,
    };
    const raw = `noise\n${AGENT_RESULT_START}\n${JSON.stringify(body)}\n${AGENT_RESULT_END}`;
    const parsed = parseAgentResult(raw);
    expect(agentResultParsedOk(parsed)).toBe(true);
    expect(parsed.status).toBe("completed");
    expect(parsed.summary).toBe("ok");
  });

  test("fails cleanly without delimiters", () => {
    const parsed = parseAgentResult("plain text");
    expect(agentResultParsedOk(parsed)).toBe(false);
    expect(parsed.parseError).toContain("start delimiter");
  });

  test("rejects invalid status without throwing", () => {
    const raw = `${AGENT_RESULT_START}\n{"status":"weird","summary":"","artifacts":{}}\n${AGENT_RESULT_END}`;
    const parsed = parseAgentResult(raw);
    expect(agentResultParsedOk(parsed)).toBe(false);
    expect(parsed.parseError).toContain("invalid status");
  });
});
