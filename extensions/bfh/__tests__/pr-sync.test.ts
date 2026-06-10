import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyPrSnapshotToState,
  doneBlockedReasons,
  readPrReviewMarker,
  writePrReviewMarker,
  type PrReviewSnapshot,
} from "../pr-sync.ts";
import { applyAdvance, createState, writeState } from "../state.ts";

function makePrReviewState() {
  const state = createState({
    key: "PC-40",
    title: "pr sync",
    type: "task",
    status: "todo",
    description: "",
    linkedTickets: [],
    labels: [],
  });
  state.pr.url = "https://github.com/acme/shop/pull/42";
  applyAdvance(state, "scout");
  applyAdvance(state, "implement");
  applyAdvance(state, "verify_review");
  applyAdvance(state, "close");
  applyAdvance(state, "pr_review");
  return state;
}

describe("pr sync marker", () => {
  test("marker written after persisted state is not immediately stale", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-pr-sync-"));
    const statePath = path.join(cwd, ".pi", "bfh", "PC-40.state.json");
    const state = makePrReviewState();
    writeState(statePath, state);

    const snapshot: PrReviewSnapshot = {
      prUrl: state.pr.url!,
      prNumber: 42,
      state: "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      unresolvedThreads: 0,
      reviewCommentCount: 0,
      checksPending: 0,
      checksFailing: 0,
      threads: [],
      syncedAt: new Date().toISOString(),
    };

    applyPrSnapshotToState(state, snapshot);
    applyAdvance(state, "retro", statePath);
    writeState(statePath, state);
    writePrReviewMarker(statePath, state, snapshot);

    expect(doneBlockedReasons(state, readPrReviewMarker(statePath))).toEqual([]);
  });
});
