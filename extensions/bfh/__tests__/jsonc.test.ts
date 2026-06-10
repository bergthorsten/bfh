import { describe, expect, test } from "bun:test";
import { parseJsonc, stripJsoncComments } from "../jsonc.ts";

describe("jsonc", () => {
  test("strips line and block comments outside strings", () => {
    const input = `{
      // line comment
      "a": 1,
      /* block */
      "b": "keep // inside"
    }`;
    expect(stripJsoncComments(input)).not.toContain("// line");
    expect(stripJsoncComments(input)).toContain("keep // inside");
  });

  test("parses comments and trailing commas", () => {
    const value = parseJsonc(`{
      // difficulty default
      "workflow": { "defaultDifficulty": 2, },
    }`) as { workflow: { defaultDifficulty: number } };
    expect(value.workflow.defaultDifficulty).toBe(2);
  });
});
