import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  deriveBranchName,
  MAX_BRANCH_NAME_LENGTH,
  prepareGitForResume,
  slugifyBranch,
} from "../git-prep.ts";
import { applyAdoptEntryMode, createState, resolveAdoptInitialStep } from "../state.ts";

describe("deriveBranchName", () => {
  test("builds ticket-first branch with slug from summary", () => {
    expect(deriveBranchName("PC-120", "Fix checkout timeout on mobile")).toBe(
      "PC-120-fix-checkout-timeout-on-mobile",
    );
  });

  test("caps total length at 50 characters", () => {
    const branch = deriveBranchName(
      "PC-120",
      "Fix checkout timeout on mobile devices with very long descriptive title",
    );
    expect(branch.length).toBeLessThanOrEqual(MAX_BRANCH_NAME_LENGTH);
    expect(branch.startsWith("PC-120-")).toBe(true);
  });

  test("preserves ticket key when summary slug is empty", () => {
    expect(deriveBranchName("PC-120", "!!!")).toBe("PC-120");
  });
});

describe("slugifyBranch", () => {
  test("lowercases and hyphenates", () => {
    expect(slugifyBranch("Fix Checkout Timeout")).toBe("fix-checkout-timeout");
  });
});

describe("createState git defaults", () => {
  test("includes derived branch metadata", () => {
    const state = createState({
      key: "PC-99",
      title: "Add payment retry",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    expect(state.git.branch).toBe("PC-99-add-payment-retry");
    expect(state.git.baseBranch).toBe("master");
    expect(state.git.entryMode).toBe("greenfield");
  });
});

describe("prepareGitForResume", () => {
  test("allows dirty working tree when already on the BFH branch", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-git-prep-"));
    execFileSync("git", ["init"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd });
    fs.writeFileSync(path.join(cwd, "README.md"), "# test\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd });
    execFileSync("git", ["commit", "-m", "init"], { cwd });

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(cwd, "README.md"), "# test\nmodified\n", "utf8");

    const notifications: Array<{ message: string; level: string }> = [];
    const ok = await prepareGitForResume(
      cwd,
      {
        hasUI: false,
        ui: {
          notify: (message: string, level: string) => notifications.push({ message, level }),
        },
      } as any,
      { branch, baseBranch: branch, entryMode: "greenfield" },
    );

    expect(ok).toBe(true);
    expect(notifications.some((entry) => entry.message.includes("with existing uncommitted changes"))).toBe(true);
  });
});

describe("applyAdoptEntryMode", () => {
  test("adopt-verify starts at verify_review and skips scout", () => {
    const state = createState({
      key: "PC-50",
      title: "Verify existing work",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    state.git.entryMode = "adopt-verify";
    applyAdoptEntryMode(state);
    expect(state.currentStep).toBe("verify_review");
    expect(state.scout.summary).toMatch(/skipped/i);
    expect(state.evidence.some((e) => /verify_review/i.test(e.summary))).toBe(true);
  });

  test("adopt-fix starts at implement and skips scout", () => {
    const state = createState({
      key: "PC-51",
      title: "Fix existing work",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    state.git.entryMode = "adopt-fix";
    applyAdoptEntryMode(state);
    expect(state.currentStep).toBe("implement");
    expect(state.scout.summary).toMatch(/skipped/i);
  });

  test("adopt-fix at level 3 bypasses design review", () => {
    const state = createState(
      {
        key: "PC-52",
        title: "Fix hard ticket",
        type: "task",
        status: "todo",
        description: "",
        linkedTickets: [],
        labels: [],
      },
      { difficulty: 3 },
    );
    state.git.entryMode = "adopt-fix";
    applyAdoptEntryMode(state);
    expect(state.currentStep).toBe("implement");
    expect(state.designReview.status).toBe("approved");
  });

  test("adopt-continue starts at scout for recon", () => {
    const state = createState({
      key: "PC-53",
      title: "Continue work",
      type: "task",
      status: "todo",
      description: "",
      linkedTickets: [],
      labels: [],
    });
    state.git.entryMode = "adopt-continue";
    applyAdoptEntryMode(state);
    expect(state.currentStep).toBe("scout");
    expect(state.scout.summary).toMatch(/recon/i);
  });

  test("greenfield stays at intake", () => {
    expect(resolveAdoptInitialStep("greenfield")).toBe("intake");
  });
});
