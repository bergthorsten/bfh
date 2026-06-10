import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { registerBfhCommands } from "../commands.ts";
import { briefPathFor } from "../brief.ts";
import { ticketMarkerDir } from "../evidence-markers.ts";
import { createState, statePathFor, writeState } from "../state.ts";
import { HARNESS_ENTRY_TYPE } from "../types.ts";

function setupGitRepo(): { cwd: string; branch: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bfh-commands-"));
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  fs.writeFileSync(path.join(cwd, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["commit", "-m", "init"], { cwd });
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
  return { cwd, branch };
}

function makeHarnessState(ticketKey: string, branch: string) {
  const state = createState({
    key: ticketKey,
    title: `${ticketKey} summary`,
    type: "task",
    status: "todo",
    description: "",
    linkedTickets: [],
    labels: [],
  });
  state.git.branch = branch;
  state.git.baseBranch = branch;
  return state;
}

function createHarnessFixture(cwd: string, branch: string, ticketKey: string): string {
  const statePath = statePathFor(cwd, ticketKey);
  const state = makeHarnessState(ticketKey, branch);
  writeState(statePath, state);
  return statePath;
}

function makePiHarness(options?: { confirmResults?: boolean[] }) {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const notifications: Array<{ message: string; level: string }> = [];
  const sentPrompts: string[] = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  let confirmIndex = 0;

  const pi = {
    on: () => {},
    registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, options);
    },
    appendEntry: (customType: string, data: unknown) => {
      appendedEntries.push({ customType, data });
    },
    setSessionName: () => {},
    sendUserMessage: (content: string) => {
      sentPrompts.push(content);
    },
  };

  const ctx = {
    cwd: "",
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: () => {},
      setEditorText: () => {},
      input: async () => undefined,
      confirm: async () => options?.confirmResults?.[confirmIndex++] ?? false,
      select: async () => "Stash changes and continue",
    },
    sessionManager: {
      getBranch: () => [],
    },
  };

  return { pi, ctx, commands, notifications, sentPrompts, appendedEntries };
}

describe("commands", () => {
  test("registerBfhCommands registers core commands", () => {
    const harness = makePiHarness();
    registerBfhCommands(harness.pi as any);

    for (const name of [
      "bfh",
      "bfh-status",
      "bfh-list",
      "bfh-selftest",
      "bfh-resume",
      "bfh-scout",
      "bfh-verify",
      "bfh-close",
      "bfh-pr-sync",
      "bfh-retro",
    ]) {
      expect(harness.commands.has(name)).toBe(true);
    }
  });

  test("bfh-status warns when no state exists", async () => {
    const harness = makePiHarness();
    const { cwd } = setupGitRepo();
    harness.ctx.cwd = cwd;
    registerBfhCommands(harness.pi as any);

    const command = harness.commands.get("bfh-status");
    expect(command).toBeDefined();

    await command!.handler("", harness.ctx);

    const last = harness.notifications[harness.notifications.length - 1];
    expect(last?.level).toBe("warning");
    expect(last?.message).toContain("No BFH state found");
  });

  test("bfh declines fresh start when user cancels first prompt", async () => {
    const harness = makePiHarness({ confirmResults: [false] });
    const { cwd, branch } = setupGitRepo();
    harness.ctx.cwd = cwd;
    registerBfhCommands(harness.pi as any);

    const statePath = createHarnessFixture(cwd, branch, "PC-300");

    const command = harness.commands.get("bfh");
    expect(command).toBeDefined();

    await command!.handler("PC-300 --no-jira", harness.ctx);

    expect(fs.existsSync(statePath)).toBe(true);
    const resumeHint = harness.notifications.find((entry) => entry.message.includes("/bfh-resume PC-300"));
    expect(resumeHint).toBeDefined();
    expect(harness.sentPrompts.length).toBe(0);
  });

  test("bfh --fresh removes existing state after double confirmation", async () => {
    const harness = makePiHarness({ confirmResults: [true, true] });
    const { cwd, branch } = setupGitRepo();
    harness.ctx.cwd = cwd;
    registerBfhCommands(harness.pi as any);

    const statePath = createHarnessFixture(cwd, branch, "PC-301");
    const briefPath = briefPathFor(statePath);
    const markerDir = ticketMarkerDir(statePath);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(briefPath, "# brief\n", "utf8");
    fs.writeFileSync(path.join(markerDir, "tested.json"), "{}\n", "utf8");

    const command = harness.commands.get("bfh");
    expect(command).toBeDefined();

    await command!.handler("PC-301 --no-jira --fresh --go", harness.ctx);

    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(briefPath)).toBe(false);
    expect(fs.existsSync(markerDir)).toBe(false);

    const removed = harness.notifications.find((entry) => entry.message.includes("Removed existing BFH state"));
    expect(removed).toBeDefined();
  });

  test("bfh-resume resolves explicit ticket key even when flags are present", async () => {
    const harness = makePiHarness();
    const { cwd, branch } = setupGitRepo();
    harness.ctx.cwd = cwd;
    registerBfhCommands(harness.pi as any);

    const targetPath = createHarnessFixture(cwd, branch, "PC-100");
    createHarnessFixture(cwd, branch, "PC-200");
    execFileSync("git", ["add", ".pi/bfh"], { cwd });
    execFileSync("git", ["commit", "-m", "add harness states"], { cwd });

    const command = harness.commands.get("bfh-resume");
    expect(command).toBeDefined();

    await command!.handler("PC-100 --go", harness.ctx);

    const resumed = harness.notifications.find((entry) => entry.message.includes("Resuming BFH:"));
    expect(resumed).toBeDefined();
    expect(resumed!.message).toContain(targetPath);

    const entry = harness.appendedEntries[harness.appendedEntries.length - 1];
    expect(entry?.customType).toBe(HARNESS_ENTRY_TYPE);
    expect((entry?.data as { issueKey?: string })?.issueKey).toBe("PC-100");
    expect(harness.sentPrompts.length).toBe(1);
  });
});
