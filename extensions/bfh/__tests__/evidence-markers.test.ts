import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  hashTestOutput,
  readReviewedMarker,
  readTestedMarker,
  reviewReportPath,
  reviewedMarkerPath,
  testedMarkerPath,
  ticketKeyFromStatePath,
  ticketMarkerDir,
  validateEvidenceMarkersForClose,
  writeReviewedMarker,
  writeTestedMarker,
} from "../evidence-markers.ts";
import { buildReviewResult } from "../review.ts";
import { createState, writeState } from "../state.ts";

describe("evidence markers", () => {
  test("hashTestOutput is stable", () => {
    expect(hashTestOutput("PASS 3 tests\n")).toBe(hashTestOutput("PASS 3 tests\n"));
    expect(hashTestOutput("a")).not.toBe(hashTestOutput("b"));
  });

  test("ticketKeyFromStatePath and marker paths", () => {
    const statePath = "/repo/.pi/bfh/PC-9.state.json";
    expect(ticketKeyFromStatePath(statePath)).toBe("PC-9");
    expect(ticketMarkerDir(statePath)).toBe("/repo/.pi/bfh/PC-9");
    expect(testedMarkerPath(statePath)).toBe("/repo/.pi/bfh/PC-9/tested.json");
    expect(reviewedMarkerPath(statePath)).toBe("/repo/.pi/bfh/PC-9/reviewed.json");
    expect(reviewReportPath(statePath)).toBe("/repo/.pi/bfh/PC-9/REVIEW.md");
  });

  test("write/read tested and reviewed markers", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-markers-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-20.state.json");
    const state = createState({
      key: "PC-20",
      title: "markers",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    writeState(statePath, state);

    const tested = writeTestedMarker(statePath, state, {
      outputContent: "ok\n",
      command: "bun test",
      passed: true,
      writtenBy: "unit-test",
    });
    expect(readTestedMarker(statePath)?.outputHash).toBe(tested.outputHash);

    state.review = buildReviewResult({ verdict: "approved", findings: [], summary: "ok" });
    writeState(statePath, state);
    writeReviewedMarker(statePath, state, "unit-test");
    const reviewed = readReviewedMarker(statePath);
    expect(reviewed?.verdict).toBe("approved");
    expect(reviewed?.critical).toBe(0);

    const reviewMd = fs.readFileSync(reviewReportPath(statePath), "utf8");
    expect(reviewMd).toContain("# Review Report — PC-20");
    expect(reviewMd).toContain("## Findings");
  });

  test("validateEvidenceMarkersForClose reports missing markers", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-validate-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-21.state.json");
    const state = createState({
      key: "PC-21",
      title: "validate",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    state.review = buildReviewResult({ verdict: "approved", findings: [], summary: "ok" });
    writeState(statePath, state);

    const reasons = validateEvidenceMarkersForClose(cwd, statePath, state);
    expect(reasons.some((r) => r.includes("tested.json"))).toBe(true);
    expect(reasons.some((r) => r.includes("reviewed.json"))).toBe(true);
  });

  test("validateEvidenceMarkersForClose passes with seeded markers", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-validate-ok-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-22.state.json");
    const state = createState({
      key: "PC-22",
      title: "validate ok",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    state.currentStep = "close";
    state.review = buildReviewResult({ verdict: "approved", findings: [], summary: "ok" });
    writeState(statePath, state);
    writeTestedMarker(statePath, state, { outputContent: "PASS\n", passed: true });
    writeReviewedMarker(statePath, state, "unit-test");

    const reasons = validateEvidenceMarkersForClose(cwd, statePath, state);
    expect(reasons).toEqual([]);
  });
});
