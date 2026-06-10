import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { eventsFilePath, initHarnessMetrics, readMetrics, recordHarnessTransition } from "../metrics.ts";
import { applyAdvance, createState, writeState } from "../state.ts";

describe("metrics", () => {
  test("init creates events.jsonl and metrics.json under ticket dir", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-metrics-"));
    const state = createState({
      key: "PC-99",
      title: "Metrics test",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    const statePath = path.join(cwd, ".pi", "bfh", "PC-99.state.json");
    writeState(statePath, state);
    initHarnessMetrics(statePath, state, { source: "bfh", noJira: true });

    const metrics = readMetrics(statePath);
    expect(metrics).not.toBeNull();
    expect(metrics?.ticketKey).toBe("PC-99");
    expect(metrics?.counters.bfhStateActions).toEqual({});
    expect(fs.existsSync(eventsFilePath(statePath))).toBe(true);

    const events = fs.readFileSync(eventsFilePath(statePath), "utf8").trim().split("\n");
    expect(events.some((line) => JSON.parse(line).type === "run_started")).toBe(true);
  });

  test("transition records loops and step timing", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-metrics-"));
    const state = createState({
      key: "PC-100",
      title: "Loop test",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    const statePath = path.join(cwd, ".pi", "bfh", "PC-100.state.json");
    writeState(statePath, state);
    initHarnessMetrics(statePath, state);

    applyAdvance(state, "scout", statePath);
    applyAdvance(state, "implement", statePath);
    applyAdvance(state, "verify_review", statePath);
    applyAdvance(state, "implement", statePath);

    const metrics = readMetrics(statePath);
    expect(metrics?.counters.implementLoops).toBe(1);
    expect(metrics?.steps.implement?.enterCount).toBeGreaterThanOrEqual(1);
    expect(metrics?.steps.verify_review?.enterCount).toBeGreaterThanOrEqual(1);
  });

  test("blocked transition increments transitionBlocked", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-metrics-"));
    const state = createState({
      key: "PC-101",
      title: "Block test",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    const statePath = path.join(cwd, ".pi", "bfh", "PC-101.state.json");
    writeState(statePath, state);
    initHarnessMetrics(statePath, state);

    recordHarnessTransition(statePath, state, "intake", "implement", {
      allowed: false,
      reason: "invalid transition",
    });

    const metrics = readMetrics(statePath);
    expect(metrics?.counters.transitionBlocked).toBe(1);
    expect(metrics?.counters.transitionAttempts).toBe(1);
  });
});
