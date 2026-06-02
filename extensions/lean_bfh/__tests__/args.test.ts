import { describe, expect, test } from "bun:test";
import { normalizeIssueKey, parseHarnessStartArgs } from "../args.ts";

describe("args", () => {
  test("normalizeIssueKey trims and uppercases", () => {
    expect(normalizeIssueKey("  pc-42  ")).toBe("PC-42");
  });

  test("parseHarnessStartArgs extracts key and flags", () => {
    expect(parseHarnessStartArgs("pc-120 --no-jira --go")).toEqual({
      issueKey: "PC-120",
      noJira: true,
      autoGo: true,
    });
    expect(parseHarnessStartArgs("-n -g BF-1")).toEqual({
      issueKey: "BF-1",
      noJira: true,
      autoGo: true,
    });
    expect(parseHarnessStartArgs("")).toEqual({
      issueKey: "",
      noJira: false,
      autoGo: false,
    });
  });
});
