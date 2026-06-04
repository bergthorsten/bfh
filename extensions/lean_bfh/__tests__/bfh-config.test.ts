import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BFH_CONFIG_FILENAME,
  clearBfhConfigCache,
  DEFAULT_BFH_MODELS,
  ensureDefaultThinking,
  ensureBfhConfigFile,
  loadBfhConfig,
  resolveImplementModelHint,
  resolveSubagentModel,
} from "../bfh-config.ts";

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bfh-config-"));
}

afterEach(() => {
  clearBfhConfigCache();
});

describe("bfh-config", () => {
  test("ensureBfhConfigFile copies package example when missing", () => {
    const cwd = tempRepo();
    const result = ensureBfhConfigFile(cwd);
    expect(result.created).toBe(true);
    expect(fs.existsSync(path.join(cwd, BFH_CONFIG_FILENAME))).toBe(true);
  });

  test("env overrides file for jira token", () => {
    const cwd = tempRepo();
    ensureBfhConfigFile(cwd);
    const configPath = path.join(cwd, BFH_CONFIG_FILENAME);
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
    ensureBfhConfigFile(cwd);
    const configPath = path.join(cwd, BFH_CONFIG_FILENAME);
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
    ensureBfhConfigFile(cwd);
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

  test("uses shipped defaults when models omitted from config", () => {
    const cwd = tempRepo();
    clearBfhConfigCache();
    expect(loadBfhConfig(cwd).models.scout).toBe(DEFAULT_BFH_MODELS.scout);
    expect(resolveSubagentModel(cwd, "reviewer")).toBe(DEFAULT_BFH_MODELS.reviewer);
    expect(resolveImplementModelHint(cwd, 2)).toBe(DEFAULT_BFH_MODELS.implement?.["2"]);
  });

  test("empty model string in config does not block package default", () => {
    const cwd = tempRepo();
    const configPath = path.join(cwd, BFH_CONFIG_FILENAME);
    fs.writeFileSync(configPath, `{ "models": { "scout": "" } }`, "utf8");
    clearBfhConfigCache();
    expect(resolveSubagentModel(cwd, "scout")).toBe(DEFAULT_BFH_MODELS.scout);
  });

  test("ensureDefaultThinking appends medium when missing", () => {
    expect(ensureDefaultThinking("github-copilot/gpt-5.5")).toBe("github-copilot/gpt-5.5:medium");
    expect(ensureDefaultThinking("github-copilot/gpt-5.5:high")).toBe("github-copilot/gpt-5.5:high");
    expect(ensureDefaultThinking("github-copilot/codex-5.2:fast")).toBe("github-copilot/codex-5.2:fast:medium");
  });

  test("config model override without thinking suffix gets medium", () => {
    const cwd = tempRepo();
    const configPath = path.join(cwd, BFH_CONFIG_FILENAME);
    fs.writeFileSync(configPath, `{ "models": { "reviewer": "custom/reviewer" } }`, "utf8");
    clearBfhConfigCache();
    expect(resolveSubagentModel(cwd, "reviewer")).toBe("custom/reviewer:medium");
  });
});
