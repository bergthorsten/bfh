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
      autonomous: false,
    });
    expect(parseHarnessStartArgs("-n -g BF-1")).toEqual({
      issueKey: "BF-1",
      noJira: true,
      autoGo: true,
      autonomous: false,
    });
    expect(parseHarnessStartArgs("")).toEqual({
      issueKey: "",
      noJira: false,
      autoGo: false,
      autonomous: false,
    });
  });

  test("parses autonomous aliases", () => {
    expect(parseHarnessStartArgs("pc-1 --autonomous").autonomous).toBe(true);
    expect(parseHarnessStartArgs("pc-1 --autonom").autonomous).toBe(true);
    expect(parseHarnessStartArgs("pc-1 --nohuman").autonomous).toBe(true);
    expect(parseHarnessStartArgs("pc-1 --no-human").autonomous).toBe(true);
  });
});
