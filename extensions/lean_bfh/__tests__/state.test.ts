import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyAdvance,
  assertStateShape,
  createState,
  mergeStatePatch,
  readState,
  resolveStatePathFromArg,
  writeState,
} from "../state.ts";

describe("state", () => {
  test("createState extracts acceptance criteria from description", () => {
    const state = createState({
      key: "PC-10",
      title: "Feature",
      type: "task",
      status: "todo",
      description: "Acceptance criteria:\n- [ ] User can log in\n- [ ] Tests pass",
      linkedTickets: [],
      labels: [],
    });
    assertStateShape(state);
    expect(state.acceptanceCriteria.some((c) => /log in/i.test(c))).toBe(true);
    expect(state.currentStep).toBe("intake");
  });

  test("revision cap blocks third verify_review -> implement", () => {
    const state = createState({
      key: "PC-11",
      title: "t",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    applyAdvance(state, "scout");
    applyAdvance(state, "implement");
    applyAdvance(state, "verify_review");
    applyAdvance(state, "implement");
    applyAdvance(state, "verify_review");
    applyAdvance(state, "implement");
    applyAdvance(state, "verify_review");
    expect(() => applyAdvance(state, "implement")).toThrow(/revision limit/i);
  });

  test("scout -> implement blocks when pre-implement approval is required", () => {
    const state = createState({
      key: "PC-119",
      title: "t",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    applyAdvance(state, "scout");
    state.human.preImplement.required = true;
    state.human.preImplement.status = "pending";

    expect(() => applyAdvance(state, "implement")).toThrow(/pre-implement decision required/i);

    state.human.preImplement.status = "approved";
    applyAdvance(state, "implement");
    expect(state.currentStep).toBe("implement");
  });

  test("close -> implement requires human changes request", () => {
    const state = createState({
      key: "PC-12",
      title: "t",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    applyAdvance(state, "scout");
    applyAdvance(state, "implement");
    applyAdvance(state, "verify_review");
    applyAdvance(state, "close");

    expect(() => applyAdvance(state, "implement")).toThrow(/human pre-close decision/i);

    state.human.preClose.status = "changes_requested";
    applyAdvance(state, "implement");
    expect(state.currentStep).toBe("implement");
  });

  test("close -> implement is blocked at difficulty level 1", () => {
    const state = createState(
      {
        key: "PC-129",
        title: "t",
        type: "task",
        status: "todo",
        description: "",
        linkedTickets: [],
        labels: [],
      },
      { difficulty: 1 },
    );
    applyAdvance(state, "scout");
    applyAdvance(state, "implement");
    applyAdvance(state, "verify_review");
    applyAdvance(state, "close");

    expect(() => applyAdvance(state, "implement")).toThrow(/difficulty level 1/i);
  });

  test("mergeStatePatch forbids direct currentStep edits", () => {
    const state = createState({
      key: "PC-12",
      title: "t",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    mergeStatePatch(state, { currentStep: "done", summary: "patched title" });
    expect(state.currentStep).toBe("intake");
    expect(state.summary).toBe("patched title");
  });

  test("read/write round-trip", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lean-bfh-unit-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-13.state.json");
    const state = createState({
      key: "PC-13",
      title: "round trip",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    writeState(statePath, state);
    const loaded = readState(statePath);
    expect(loaded.ticketKey).toBe("PC-13");
    expect(loaded.summary).toBe("round trip");
  });

  test("resolveStatePathFromArg accepts key or path", () => {
    const cwd = "/tmp/repo";
    expect(resolveStatePathFromArg(cwd, "pc-9")).toBe(path.join(cwd, ".pi", "bfh", "PC-9.state.json"));
    expect(resolveStatePathFromArg(cwd, ".pi/bfh/PC-9.state.json")).toBe(
      path.resolve(cwd, ".pi/bfh/PC-9.state.json"),
    );
    expect(resolveStatePathFromArg(cwd, "not-a-key")).toBeUndefined();
  });
});
