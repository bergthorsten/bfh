import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearAttentionPingCache,
  markAttentionPinged,
  maybeNotifyHarnessAttention,
  shouldSkipAttentionPing,
} from "../attention.ts";
import { clearBfhConfigCache, loadBfhConfig } from "../bfh-config.ts";
import { BFH_CONFIG_FILENAME } from "../bfh-config.ts";
import { createState, statePathFor, writeState } from "../state.ts";

const emptyIssue = {
  key: "PC-88",
  title: "Attention",
  type: "task",
  status: "todo",
  description: "",
  linkedTickets: [] as Array<{ key: string; type: string }>,
  labels: [] as string[],
};

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bfh-attention-"));
}

afterEach(() => {
  clearAttentionPingCache();
  clearBfhConfigCache();
});

describe("attention ping dedupe", () => {
  test("skips repeat pings for the same signature", () => {
    const statePath = "/tmp/PC-1.state.json";
    markAttentionPinged(statePath, "pre_close:2026-01-01");
    expect(shouldSkipAttentionPing(statePath, "pre_close:2026-01-01")).toBe(true);
    expect(shouldSkipAttentionPing(statePath, "pre_close:2026-01-02")).toBe(false);
  });
});

describe("maybeNotifyHarnessAttention", () => {
  test("notifies when pending gate and enabled in config", () => {
    const cwd = tempRepo();
    fs.writeFileSync(
      path.join(cwd, BFH_CONFIG_FILENAME),
      JSON.stringify({ notifications: { enabled: true, sound: false, osNotify: false } }),
      "utf8",
    );
    clearBfhConfigCache();

    const state = createState(emptyIssue, { cwd, difficulty: 2 });
    state.human.preImplement = {
      required: true,
      status: "pending",
      requestedAt: "2026-01-01T00:00:00.000Z",
    };
    const statePath = statePathFor(cwd, emptyIssue.key);
    writeState(statePath, state);

    const notifications: string[] = [];
    const ctx = {
      cwd,
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
      sessionManager: { getBranch: () => [] },
    } as Parameters<typeof maybeNotifyHarnessAttention>[0];

    maybeNotifyHarnessAttention(ctx);
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("PC-88");

    maybeNotifyHarnessAttention(ctx);
    expect(notifications.length).toBe(1);
  });

  test("respects notifications.enabled=false", () => {
    const cwd = tempRepo();
    fs.writeFileSync(
      path.join(cwd, BFH_CONFIG_FILENAME),
      JSON.stringify({ notifications: { enabled: false } }),
      "utf8",
    );
    clearBfhConfigCache();

    const state = createState(emptyIssue, { cwd, difficulty: 2 });
    state.human.preClose.status = "pending";
    writeState(statePathFor(cwd, emptyIssue.key), state);

    const notifications: string[] = [];
    const ctx = {
      cwd,
      ui: { notify: (message: string) => notifications.push(message) },
      sessionManager: { getBranch: () => [] },
    } as Parameters<typeof maybeNotifyHarnessAttention>[0];

    maybeNotifyHarnessAttention(ctx);
    expect(notifications.length).toBe(0);
    expect(loadBfhConfig(cwd).notifications.enabled).toBe(false);
  });
});
