import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.ts";
import type { DifficultyLevel, JiraAuthMode } from "./types.ts";
import { DEFAULT_JIRA_BASE_URL } from "./types.ts";

export const BFH_CONFIG_FILENAME = "config.jsonc";
export const BFH_CONFIG_EXAMPLE_FILENAME = "config.example.jsonc";
export const BFH_GLOBAL_CONFIG_SUBDIR = "bfh";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Default Pi thinking level appended to BFH model refs when not already specified. */
export const DEFAULT_BFH_THINKING = "medium";

const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export type BfhThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ResolvedSubagentInvocation = {
  model?: string;
  thinking?: BfhThinkingLevel;
};

/** Append `:thinking` when the model ref has no Pi thinking suffix (see pi --model docs). */
export function ensureDefaultThinking(
  model: string | undefined,
  level: string = DEFAULT_BFH_THINKING,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return `${trimmed}:${level}`;

  const suffix = trimmed.slice(lastColon + 1).toLowerCase();
  if (PI_THINKING_LEVELS.has(suffix)) return trimmed;

  return `${trimmed}:${level}`;
}

/** Shipped model defaults; bump on release. Overridden only when set in config.jsonc (non-empty). */
export const DEFAULT_BFH_MODELS: BfhModelsConfig = {
  implement: {
    "1": "github-copilot/gemini-3.5-flash:medium",
    "2": "github-copilot/gpt-5.3-codex:medium",
    "3": "github-copilot/gpt-5.5:medium",
  },
  scout: "github-copilot/gemini-3.5-flash:medium",
  reviewer: "github-copilot/gpt-5.3-codex:medium",
  closer: "github-copilot/gpt-5.4-mini:medium",
  retro: "github-copilot/gpt-5.4-mini:medium",
};

export type BfhJiraConfig = {
  baseUrl?: string;
  token?: string;
  authMode?: JiraAuthMode;
  email?: string;
  acceptanceFields?: string[];
  constraintFields?: string[];
};

export type BfhPrChecksConfig = {
  /** Wait for GitHub status checks after draft PR creation (default true). */
  enabled?: boolean;
  /** Delay before the first check after PR creation (default 120000ms). */
  initialDelayMs?: number;
  /** Delay between follow-up checks while checks are pending (default 30000ms). */
  pollIntervalMs?: number;
  /** Maximum number of check attempts after the initial delay (default 6). */
  maxAttempts?: number;
};

export type BfhWorkflowConfig = {
  defaultDifficulty?: DifficultyLevel;
  baseBranch?: string;
  verifyRevisionLimit?: number;
  designReviewRevisionLimit?: number;
  externalPrRevisionLimit?: number;
  maxReviewTouchedFiles?: number;
  prChecks?: BfhPrChecksConfig;
};

export type BfhModelsConfig = {
  implement?: Partial<Record<"1" | "2" | "3", string>>;
  scout?: string;
  reviewer?: string;
  closer?: string;
  retro?: string;
};

export type BfhNotificationsConfig = {
  /** Master switch for harness attention pings on agent_end. */
  enabled?: boolean;
  /** Terminal bell (and macOS notification sound when osNotify uses osascript). */
  sound?: boolean;
  /** Native OS or terminal notification (OSC / osascript / notify-send). */
  osNotify?: boolean;
};

export type BfhSafeModeConfig = {
  /** Block dangerous shell commands and sensitive file access (default true). */
  enabled?: boolean;
  /** Extra case-insensitive regex patterns merged with BFH defaults. */
  commandPatterns?: string[];
  /** SSH destination hosts allowed when running `ssh` (empty = block all). */
  allowedSshHosts?: string[];
  /** Exact basenames blocked for read/write/edit (default includes .env, history files). */
  blockedFileBasenames?: string[];
};

export type BfhConfigFile = {
  jira?: BfhJiraConfig;
  workflow?: BfhWorkflowConfig;
  models?: BfhModelsConfig;
  notifications?: BfhNotificationsConfig;
  safeMode?: BfhSafeModeConfig;
};

export type BfhResolvedConfig = {
  jira: {
    baseUrl: string;
    token?: string;
    authMode: JiraAuthMode;
    email?: string;
    acceptanceFields: string[];
    constraintFields: string[];
  };
  workflow: {
    defaultDifficulty: DifficultyLevel;
    baseBranch: string;
    verifyRevisionLimit: number;
    designReviewRevisionLimit: number;
    externalPrRevisionLimit: number;
    maxReviewTouchedFiles: number;
    prChecks: Required<BfhPrChecksConfig>;
  };
  models: BfhModelsConfig;
  notifications: {
    enabled: boolean;
    sound: boolean;
    osNotify: boolean;
  };
  safeMode: Required<Pick<BfhSafeModeConfig, "enabled" | "commandPatterns" | "allowedSshHosts" | "blockedFileBasenames">>;
};

const CODE_DEFAULTS: BfhResolvedConfig = {
  jira: {
    baseUrl: DEFAULT_JIRA_BASE_URL,
    authMode: "bearer",
    acceptanceFields: [],
    constraintFields: [],
  },
  workflow: {
    defaultDifficulty: 2,
    baseBranch: "master",
    verifyRevisionLimit: 2,
    designReviewRevisionLimit: 3,
    externalPrRevisionLimit: 2,
    maxReviewTouchedFiles: 20,
    prChecks: {
      enabled: true,
      initialDelayMs: 120_000,
      pollIntervalMs: 30_000,
      maxAttempts: 6,
    },
  },
  models: DEFAULT_BFH_MODELS,
  notifications: {
    enabled: true,
    sound: true,
    osNotify: true,
  },
  safeMode: {
    enabled: true,
    commandPatterns: [],
    allowedSshHosts: [],
    blockedFileBasenames: [],
  },
};

const configCache = new Map<string, BfhResolvedConfig>();

export function clearBfhConfigCache(): void {
  configCache.clear();
}

/** Pi global agent dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). */
export function resolvePiAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".pi", "agent");
}

export function bfhGlobalConfigDir(): string {
  return path.join(resolvePiAgentDir(), BFH_GLOBAL_CONFIG_SUBDIR);
}

/** Primary BFH settings path under the Pi agent dir. */
export function bfhConfigPath(_cwd?: string): string {
  return path.join(bfhGlobalConfigDir(), BFH_CONFIG_FILENAME);
}

/** Legacy repo-root config (read-only fallback for older installs). */
export function legacyBfhConfigPath(cwd: string): string {
  return path.join(path.resolve(cwd), BFH_CONFIG_FILENAME);
}

export function bfhConfigExamplePath(cwd: string): string {
  return path.join(path.resolve(cwd), BFH_CONFIG_EXAMPLE_FILENAME);
}

function resolveConfigFilePath(cwd: string): string {
  const globalPath = bfhConfigPath();
  if (fs.existsSync(globalPath)) return globalPath;
  const legacyPath = legacyBfhConfigPath(cwd);
  if (fs.existsSync(legacyPath)) return legacyPath;
  return globalPath;
}

export function packageConfigExamplePath(): string {
  return path.join(PACKAGE_ROOT, BFH_CONFIG_EXAMPLE_FILENAME);
}

function readConfigFileRaw(filePath: string): BfhConfigFile | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return undefined;
    const parsed = parseJsonc(raw);
    return parsed && typeof parsed === "object" ? (parsed as BfhConfigFile) : undefined;
  } catch {
    return undefined;
  }
}

function parseFieldList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function parseDifficulty(value: unknown): DifficultyLevel | undefined {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (n === 1 || n === 2 || n === 3) return n;
  return undefined;
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return undefined;
}

function envBool(...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const parsed = parseBool(process.env[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function envString(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return undefined;
}

function envFieldList(envKey: string, fileValue: unknown): string[] {
  const fromEnv = envString(envKey);
  if (fromEnv) {
    return fromEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return parseFieldList(fileValue);
}

function nonEmptyModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function mergeModels(file: BfhModelsConfig | undefined): BfhModelsConfig {
  const fromFile = file ?? {};
  const level = (n: "1" | "2" | "3") =>
    nonEmptyModel(fromFile.implement?.[n]) ?? nonEmptyModel(DEFAULT_BFH_MODELS.implement?.[n]);

  return {
    implement: {
      "1": level("1"),
      "2": level("2"),
      "3": level("3"),
    },
    scout: nonEmptyModel(fromFile.scout) ?? nonEmptyModel(DEFAULT_BFH_MODELS.scout),
    reviewer: nonEmptyModel(fromFile.reviewer) ?? nonEmptyModel(DEFAULT_BFH_MODELS.reviewer),
    closer: nonEmptyModel(fromFile.closer) ?? nonEmptyModel(DEFAULT_BFH_MODELS.closer),
    retro: nonEmptyModel(fromFile.retro) ?? nonEmptyModel(DEFAULT_BFH_MODELS.retro),
  };
}

function mergeSafeMode(file: BfhSafeModeConfig | undefined): BfhResolvedConfig["safeMode"] {
  const fromFile = file ?? {};
  const enabled =
    envBool("BFH_SAFE_MODE", "BFH_SAFE_MODE_ENABLED") ??
    parseBool(fromFile.enabled) ??
    CODE_DEFAULTS.safeMode.enabled;

  return {
    enabled,
    commandPatterns: Array.isArray(fromFile.commandPatterns)
      ? fromFile.commandPatterns.map((p) => String(p).trim()).filter(Boolean)
      : CODE_DEFAULTS.safeMode.commandPatterns,
    allowedSshHosts: Array.isArray(fromFile.allowedSshHosts)
      ? fromFile.allowedSshHosts.map((h) => String(h).trim()).filter(Boolean)
      : CODE_DEFAULTS.safeMode.allowedSshHosts,
    blockedFileBasenames: Array.isArray(fromFile.blockedFileBasenames)
      ? fromFile.blockedFileBasenames.map((p) => String(p).trim()).filter(Boolean)
      : CODE_DEFAULTS.safeMode.blockedFileBasenames,
  };
}

function mergeNotifications(file: BfhNotificationsConfig | undefined): BfhResolvedConfig["notifications"] {
  const fromFile = file ?? {};
  const enabled =
    envBool("BFH_NOTIFICATIONS_ENABLED", "BFH_NOTIFICATIONS") ??
    parseBool(fromFile.enabled) ??
    CODE_DEFAULTS.notifications.enabled;
  const sound =
    envBool("BFH_NOTIFICATIONS_SOUND") ?? parseBool(fromFile.sound) ?? CODE_DEFAULTS.notifications.sound;
  const osNotify =
    envBool("BFH_NOTIFICATIONS_OS", "BFH_NOTIFICATIONS_OS_NOTIFY") ??
    parseBool(fromFile.osNotify) ??
    CODE_DEFAULTS.notifications.osNotify;

  return {
    enabled,
    sound: enabled ? sound : false,
    osNotify: enabled ? osNotify : false,
  };
}

function mergeResolved(file: BfhConfigFile | undefined): BfhResolvedConfig {
  const jira = file?.jira ?? {};
  const workflow = file?.workflow ?? {};
  const prChecks = workflow.prChecks ?? {};

  const authModeRaw = (envString("JIRA_AUTH_MODE") || jira.authMode || CODE_DEFAULTS.jira.authMode).toLowerCase();
  const authMode: JiraAuthMode = authModeRaw === "basic" ? "basic" : "bearer";

  return {
    jira: {
      baseUrl: (envString("JIRA_BASE_URL") || jira.baseUrl || CODE_DEFAULTS.jira.baseUrl).replace(/\/+$/, ""),
      token: envString("JIRA_TOKEN") || jira.token?.trim() || undefined,
      authMode,
      email: envString("JIRA_EMAIL") || jira.email?.trim() || undefined,
      acceptanceFields: envFieldList("JIRA_ACCEPTANCE_FIELDS", jira.acceptanceFields),
      constraintFields: envFieldList("JIRA_CONSTRAINT_FIELDS", jira.constraintFields),
    },
    workflow: {
      defaultDifficulty:
        parseDifficulty(envString("BFH_DEFAULT_DIFFICULTY")) ??
        parseDifficulty(workflow.defaultDifficulty) ??
        CODE_DEFAULTS.workflow.defaultDifficulty,
      baseBranch: envString("BFH_BASE_BRANCH") || workflow.baseBranch?.trim() || CODE_DEFAULTS.workflow.baseBranch,
      verifyRevisionLimit:
        Number(envString("BFH_VERIFY_REVISION_LIMIT")) ||
        workflow.verifyRevisionLimit ||
        CODE_DEFAULTS.workflow.verifyRevisionLimit,
      designReviewRevisionLimit:
        Number(envString("BFH_DESIGN_REVIEW_REVISION_LIMIT")) ||
        workflow.designReviewRevisionLimit ||
        CODE_DEFAULTS.workflow.designReviewRevisionLimit,
      externalPrRevisionLimit:
        Number(envString("BFH_EXTERNAL_PR_REVISION_LIMIT")) ||
        workflow.externalPrRevisionLimit ||
        CODE_DEFAULTS.workflow.externalPrRevisionLimit,
      maxReviewTouchedFiles:
        Number(envString("BFH_MAX_REVIEW_TOUCHED_FILES")) ||
        workflow.maxReviewTouchedFiles ||
        CODE_DEFAULTS.workflow.maxReviewTouchedFiles,
      prChecks: {
        enabled:
          envBool("BFH_PR_CHECKS_ENABLED") ??
          parseBool(prChecks.enabled) ??
          CODE_DEFAULTS.workflow.prChecks.enabled,
        initialDelayMs:
          positiveInt(envString("BFH_PR_CHECKS_INITIAL_DELAY_MS")) ??
          positiveInt(prChecks.initialDelayMs) ??
          CODE_DEFAULTS.workflow.prChecks.initialDelayMs,
        pollIntervalMs:
          positiveInt(envString("BFH_PR_CHECKS_POLL_INTERVAL_MS")) ??
          positiveInt(prChecks.pollIntervalMs) ??
          CODE_DEFAULTS.workflow.prChecks.pollIntervalMs,
        maxAttempts:
          positiveInt(envString("BFH_PR_CHECKS_MAX_ATTEMPTS")) ??
          positiveInt(prChecks.maxAttempts) ??
          CODE_DEFAULTS.workflow.prChecks.maxAttempts,
      },
    },
    models: mergeModels(file?.models),
    notifications: mergeNotifications(file?.notifications),
    safeMode: mergeSafeMode(file?.safeMode),
  };
}

export function loadBfhConfig(cwd: string): BfhResolvedConfig {
  const key = resolveConfigFilePath(cwd);
  const cached = configCache.get(key);
  if (cached) return cached;

  const file = readConfigFileRaw(key);
  const resolved = mergeResolved(file);
  configCache.set(key, resolved);
  return resolved;
}

export type EnsureBfhConfigResult = {
  configPath: string;
  created: boolean;
};

/** Create `~/.pi/agent/bfh/config.jsonc` from example when missing. */
export function ensureBfhConfigFile(_cwd: string): EnsureBfhConfigResult {
  const configPath = bfhConfigPath();
  if (fs.existsSync(configPath)) {
    return { configPath, created: false };
  }

  const packageExample = packageConfigExamplePath();
  const source = fs.existsSync(packageExample) ? packageExample : undefined;

  fs.mkdirSync(bfhGlobalConfigDir(), { recursive: true });

  if (!source) {
    fs.writeFileSync(configPath, `${JSON.stringify(CODE_DEFAULTS, null, 2)}\n`, "utf8");
  } else {
    fs.copyFileSync(source, configPath);
  }

  clearBfhConfigCache();
  return { configPath, created: true };
}

export function resolveJiraConfigPath(cwd: string): string {
  return resolveConfigFilePath(cwd);
}

export function hasJiraToken(cwd: string): boolean {
  return Boolean(loadBfhConfig(cwd).jira.token?.trim());
}

export function jiraTokenSetupHint(cwd: string): string {
  const baseUrl = loadBfhConfig(cwd).jira.baseUrl.replace(/\/+$/, "");
  return `Create a Personal Access Token in Jira: ${baseUrl}/secure/ViewProfile.jspa → Personal Access Tokens`;
}

/** Persist Jira token to the global config file (always `~/.pi/agent/bfh/config.jsonc`). */
export function saveJiraToken(cwd: string, token: string): string {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Jira token cannot be empty.");

  ensureBfhConfigFile(cwd);
  const configPath = bfhConfigPath();
  let raw = fs.readFileSync(configPath, "utf8");

  const commentedTokenLine = /^\s*\/\/\s*"token"\s*:\s*"[^"]*".*$/m;
  const tokenLine = /^\s*"token"\s*:\s*"[^"]*".*$/m;
  if (commentedTokenLine.test(raw)) {
    raw = raw.replace(commentedTokenLine, `    "token": ${JSON.stringify(trimmed)},`);
  } else if (tokenLine.test(raw)) {
    raw = raw.replace(tokenLine, `    "token": ${JSON.stringify(trimmed)},`);
  } else {
    const file = readConfigFileRaw(configPath) ?? {};
    const updated: BfhConfigFile = {
      ...file,
      jira: { ...file.jira, token: trimmed },
    };
    raw = `${JSON.stringify(updated, null, 2)}\n`;
  }

  fs.writeFileSync(configPath, raw, "utf8");
  clearBfhConfigCache();
  return configPath;
}

function splitModelAndThinking(raw: string | undefined): ResolvedSubagentInvocation {
  const trimmed = raw?.trim();
  if (!trimmed) return {};

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return { model: trimmed };

  const suffix = trimmed.slice(lastColon + 1).toLowerCase();
  if (PI_THINKING_LEVELS.has(suffix)) {
    return {
      model: trimmed.slice(0, lastColon),
      thinking: suffix as BfhThinkingLevel,
    };
  }

  return { model: trimmed };
}

export function resolveSubagentInvocation(
  cwd: string,
  role: keyof Pick<BfhModelsConfig, "scout" | "reviewer" | "closer" | "retro">,
  sessionModel?: string,
): ResolvedSubagentInvocation {
  const fromConfig = loadBfhConfig(cwd).models[role]?.trim();
  if (fromConfig) {
    const resolved = splitModelAndThinking(fromConfig);
    return {
      model: resolved.model,
      thinking: resolved.thinking ?? DEFAULT_BFH_THINKING,
    };
  }

  return splitModelAndThinking(sessionModel?.trim());
}

export function resolveSubagentModel(
  cwd: string,
  role: keyof Pick<BfhModelsConfig, "scout" | "reviewer" | "closer" | "retro">,
  sessionModel?: string,
): string | undefined {
  return resolveSubagentInvocation(cwd, role, sessionModel).model;
}

export function resolveImplementModelHint(cwd: string, level: DifficultyLevel): string | undefined {
  const envKeys: Record<DifficultyLevel, string> = {
    1: "BFH_IMPLEMENT_MODEL_L1",
    2: "BFH_IMPLEMENT_MODEL_L2",
    3: "BFH_IMPLEMENT_MODEL_L3",
  };
  const fromEnv = ensureDefaultThinking(process.env[envKeys[level]]?.trim());
  if (fromEnv) return fromEnv;

  return ensureDefaultThinking(
    loadBfhConfig(cwd).models.implement?.[String(level) as "1" | "2" | "3"]?.trim(),
  );
}
