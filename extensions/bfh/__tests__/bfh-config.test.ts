import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BFH_CONFIG_FILENAME,
  BFH_GLOBAL_CONFIG_SUBDIR,
  clearBfhConfigCache,
  DEFAULT_BFH_MODELS,
  ensureDefaultThinking,
  ensureBfhConfigFile,
  hasJiraToken,
  legacyBfhConfigPath,
  loadBfhConfig,
  resolveImplementModelHint,
  resolveSubagentInvocation,
  resolveSubagentModel,
  saveJiraToken,
} from "../bfh-config.ts";

let tempAgentDir: string | undefined;
let prevPiAgentDir: string | undefined;

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bfh-config-"));
}

function useTempPiAgentDir(): string {
  tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-"));
  prevPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  clearBfhConfigCache();
  return tempAgentDir;
}

afterEach(() => {
  clearBfhConfigCache();
  if (prevPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevPiAgentDir;
  prevPiAgentDir = undefined;
  if (tempAgentDir) {
    fs.rmSync(tempAgentDir, { recursive: true, force: true });
    tempAgentDir = undefined;
  }
});

describe("bfh-config", () => {
  beforeEach(() => {
    useTempPiAgentDir();
  });

  test("ensureBfhConfigFile copies package example when missing", () => {
    const agentDir = tempAgentDir!;
    const cwd = tempRepo();
    const result = ensureBfhConfigFile(cwd);
    expect(result.created).toBe(true);
    expect(fs.existsSync(path.join(agentDir, BFH_GLOBAL_CONFIG_SUBDIR, BFH_CONFIG_FILENAME))).toBe(true);
  });

  test("loadBfhConfig falls back to legacy repo-root config", () => {
    const cwd = tempRepo();
    const legacyPath = legacyBfhConfigPath(cwd);
    fs.writeFileSync(
      legacyPath,
      `{ "jira": { "baseUrl": "https://legacy.example.com", "token": "legacy-token" } }`,
      "utf8",
    );
    clearBfhConfigCache();
    expect(loadBfhConfig(cwd).jira.token).toBe("legacy-token");
  });

  test("env overrides file for jira token", () => {
    const cwd = tempRepo();
    const configPath = legacyBfhConfigPath(cwd);
    fs.writeFileSync(
      configPath,
      `{
        "jira": { "baseUrl": "https://jira.example.com", "token": "file-token" }
      }`,
      "utf8",
    );
    clearBfhConfigCache();

    const prev = process.env.JIRA_TOKEN;
    process.env.JIRA_TOKEN = "env-token";
    try {
      expect(loadBfhConfig(cwd).jira.token).toBe("env-token");
    } finally {
      if (prev === undefined) delete process.env.JIRA_TOKEN;
      else process.env.JIRA_TOKEN = prev;
    }
  });

  test("resolveImplementModelHint prefers env over config", () => {
    const cwd = tempRepo();
    const configPath = legacyBfhConfigPath(cwd);
    fs.writeFileSync(
      configPath,
      `{ "models": { "implement": { "2": "config/model" } } }`,
      "utf8",
    );
    clearBfhConfigCache();

    expect(resolveImplementModelHint(cwd, 2)).toBe("config/model:medium");

    const prev = process.env.BFH_IMPLEMENT_MODEL_L2;
    process.env.BFH_IMPLEMENT_MODEL_L2 = "env/model";
    try {
      clearBfhConfigCache();
      expect(resolveImplementModelHint(cwd, 2)).toBe("env/model:medium");
    } finally {
      if (prev === undefined) delete process.env.BFH_IMPLEMENT_MODEL_L2;
      else process.env.BFH_IMPLEMENT_MODEL_L2 = prev;
    }
  });

  test("notifications default to enabled with sound and osNotify", () => {
    const cwd = tempRepo();
    clearBfhConfigCache();
    expect(loadBfhConfig(cwd).notifications).toEqual({
      enabled: true,
      sound: true,
      osNotify: true,
    });
  });

  test("notifications respect env disable", () => {
    const cwd = tempRepo();
    clearBfhConfigCache();

    const prevEnabled = process.env.BFH_NOTIFICATIONS_ENABLED;
    const prevSound = process.env.BFH_NOTIFICATIONS_SOUND;
    process.env.BFH_NOTIFICATIONS_ENABLED = "false";
    process.env.BFH_NOTIFICATIONS_SOUND = "true";
    try {
      clearBfhConfigCache();
      const cfg = loadBfhConfig(cwd).notifications;
      expect(cfg.enabled).toBe(false);
      expect(cfg.sound).toBe(false);
      expect(cfg.osNotify).toBe(false);
    } finally {
      if (prevEnabled === undefined) delete process.env.BFH_NOTIFICATIONS_ENABLED;
      else process.env.BFH_NOTIFICATIONS_ENABLED = prevEnabled;
      if (prevSound === undefined) delete process.env.BFH_NOTIFICATIONS_SOUND;
      else process.env.BFH_NOTIFICATIONS_SOUND = prevSound;
    }
  });

  test("safeMode defaults to enabled", () => {
    const cwd = tempRepo();
    clearBfhConfigCache();
    expect(loadBfhConfig(cwd).safeMode).toEqual({
      enabled: true,
      commandPatterns: [],
      allowedSshHosts: [],
      blockedFileBasenames: [],
    });
  });

  test("safeMode respects env disable", () => {
    const cwd = tempRepo();
    clearBfhConfigCache();

    const prev = process.env.BFH_SAFE_MODE;
    process.env.BFH_SAFE_MODE = "false";
    try {
      clearBfhConfigCache();
      expect(loadBfhConfig(cwd).safeMode.enabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.BFH_SAFE_MODE;
      else process.env.BFH_SAFE_MODE = prev;
    }
  });

  test("uses shipped defaults when models omitted from config", () => {
    const cwd = tempRepo();
    clearBfhConfigCache();
    expect(loadBfhConfig(cwd).models.scout).toBe(DEFAULT_BFH_MODELS.scout);
    expect(resolveSubagentModel(cwd, "reviewer")).toBe("github-copilot/gpt-5.3-codex");
    expect(resolveSubagentInvocation(cwd, "reviewer")).toEqual({
      model: "github-copilot/gpt-5.3-codex",
      thinking: "medium",
    });
    expect(resolveImplementModelHint(cwd, 2)).toBe(DEFAULT_BFH_MODELS.implement?.["2"]);
  });

  test("empty model string in config does not block package default", () => {
    const cwd = tempRepo();
    const configPath = legacyBfhConfigPath(cwd);
    fs.writeFileSync(configPath, `{ "models": { "scout": "" } }`, "utf8");
    clearBfhConfigCache();
    expect(resolveSubagentModel(cwd, "scout")).toBe("github-copilot/gemini-3.5-flash");
  });

  test("ensureDefaultThinking appends medium when missing", () => {
    expect(ensureDefaultThinking("github-copilot/gpt-5.5")).toBe("github-copilot/gpt-5.5:medium");
    expect(ensureDefaultThinking("github-copilot/gpt-5.5:high")).toBe("github-copilot/gpt-5.5:high");
    expect(ensureDefaultThinking("github-copilot/codex-5.2:fast")).toBe("github-copilot/codex-5.2:fast:medium");
  });

  test("config model override without thinking suffix gets medium", () => {
    const cwd = tempRepo();
    const configPath = legacyBfhConfigPath(cwd);
    fs.writeFileSync(configPath, `{ "models": { "reviewer": "custom/reviewer" } }`, "utf8");
    clearBfhConfigCache();
    expect(resolveSubagentModel(cwd, "reviewer")).toBe("custom/reviewer");
    expect(resolveSubagentInvocation(cwd, "reviewer")).toEqual({ model: "custom/reviewer", thinking: "medium" });
  });

  test("config model with explicit thinking suffix is split for subagents", () => {
    const cwd = tempRepo();
    const configPath = legacyBfhConfigPath(cwd);
    fs.writeFileSync(configPath, `{ "models": { "reviewer": "custom/reviewer:high" } }`, "utf8");
    clearBfhConfigCache();
    expect(resolveSubagentModel(cwd, "reviewer")).toBe("custom/reviewer");
    expect(resolveSubagentInvocation(cwd, "reviewer")).toEqual({ model: "custom/reviewer", thinking: "high" });
  });

  test("hasJiraToken is false until token is configured", () => {
    const cwd = tempRepo();
    clearBfhConfigCache();
    expect(hasJiraToken(cwd)).toBe(false);
  });

  test("saveJiraToken uncomments token line in seeded config", () => {
    const cwd = tempRepo();
    ensureBfhConfigFile(cwd);
    const configPath = path.join(tempAgentDir!, BFH_GLOBAL_CONFIG_SUBDIR, BFH_CONFIG_FILENAME);
    saveJiraToken(cwd, "pat-abc123");
    clearBfhConfigCache();
    expect(hasJiraToken(cwd)).toBe(true);
    expect(loadBfhConfig(cwd).jira.token).toBe("pat-abc123");
    const raw = fs.readFileSync(configPath, "utf8");
    expect(raw).toContain('"token": "pat-abc123"');
    expect(raw).not.toMatch(/\/\/\s*"token"/);
  });
});
