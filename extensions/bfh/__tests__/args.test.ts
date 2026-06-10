import { describe, expect, test } from "bun:test";
import { normalizeIssueKey, parseHarnessStartArgs } from "../args.ts";

describe("args", () => {
  test("normalizeIssueKey trims and uppercases", () => {
    expect(normalizeIssueKey("  pc-42  ")).toBe("PC-42");
  });

  test("parseHarnessStartArgs extracts key and base flags", () => {
    expect(parseHarnessStartArgs("pc-120 --no-jira --go")).toEqual({
      issueKey: "PC-120",
      noJira: true,
      autoGo: true,
      fresh: false,
      difficulty: 2,
    });
    expect(parseHarnessStartArgs("-n -g BF-1")).toEqual({
      issueKey: "BF-1",
      noJira: true,
      autoGo: true,
      fresh: false,
      difficulty: 2,
    });
    expect(parseHarnessStartArgs("")).toEqual({
      issueKey: "",
      noJira: false,
      autoGo: false,
      fresh: false,
      difficulty: 2,
    });
  });

  test("parses --fresh flag", () => {
    expect(parseHarnessStartArgs("pc-120 --fresh").fresh).toBe(true);
    expect(parseHarnessStartArgs("pc-120 --fresh --go").fresh).toBe(true);
  });

  test("parses --level flag", () => {
    expect(parseHarnessStartArgs("pc-1 --level 1").difficulty).toBe(1);
    expect(parseHarnessStartArgs("pc-1 --level 3").difficulty).toBe(3);
    expect(parseHarnessStartArgs("pc-1 -l 1").difficulty).toBe(1);
    expect(parseHarnessStartArgs("pc-1 --level=2").difficulty).toBe(2);
    expect(parseHarnessStartArgs("pc-1 --level 9").difficulty).toBe(2);
  });
});
