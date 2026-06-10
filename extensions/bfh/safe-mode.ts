import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { loadBfhConfig } from "./bfh-config.ts";

/** Default bash command regex patterns (case-insensitive). Extend via config `safeMode.commandPatterns`. */
export const DEFAULT_COMMAND_PATTERN_STRINGS: readonly string[] = [
  String.raw`\brm\s+(?:-[^\s]+\s+)*-?r(?:f|\s|$)`,
  String.raw`\bsudo\b`,
  String.raw`\bDROP\s+(?:DATABASE|TABLE)\b`,
  String.raw`\bgh\s+pr\s+merge\b`,
  String.raw`\bgh\s+repo\s+delete\b`,
  String.raw`\bkubectl\s+delete\b`,
  String.raw`\b(?:cat|less|more|tail|head|bat)(?:\s+-[^\s]+|\s+[^\s|&;]+)*\s+[^\s|&;]*(?:bash|zsh)_history\b`,
  String.raw`(?:^|\s)\.(?:bash|zsh)_history\b`,
  // Force-push overwrites shared history; common agent "fix" that destroys team state.
  String.raw`\bgit\s+push\b[^\n|&;]*(?:--force(?:-with-lease)?|\s-f(?:\s|$))`,
  // Remote code execution: curl/wget piped straight into a shell.
  String.raw`\b(?:curl|wget)\b[^\n|&;]*\|\s*(?:ba)?sh\b`,
  // Wipes uncommitted work; agents often run this to "clean up" before committing.
  String.raw`\bgit\s+reset\s+(?:--hard|-hard)\b`,
  // Raw disk writes — catastrophic if aimed at a block device.
  String.raw`\bdd\b[^\n|&;]*\bof=/dev/`,
  // World-writable permissions on files/dirs (recursive chmod/chown 777).
  String.raw`\b(?:chmod|chown)\b[^\n|&;]*\b777\b`,
];

/** Basenames blocked for read/write/edit (exact match). `.env.example` and similar are allowed. */
export const DEFAULT_BLOCKED_FILE_BASENAMES: readonly string[] = [
  ".env",
  ".env.production",
  ".bash_history",
  ".zsh_history",
];

/** Non-secret files under `.ssh/` that safe mode still allows. */
export const SSH_DIR_SAFE_BASENAMES: readonly string[] = [
  "config",
  "known_hosts",
  "authorized_keys",
  "allowed_signers",
];

export type ResolvedSafeModeConfig = {
  enabled: boolean;
  commandPatterns: RegExp[];
  allowedSshHosts: Set<string>;
  blockedFileBasenames: Set<string>;
};

export function compileCommandPatterns(extraPatternStrings: string[]): RegExp[] {
  const all = [...DEFAULT_COMMAND_PATTERN_STRINGS, ...extraPatternStrings];
  return all.map((pattern) => new RegExp(pattern, "i"));
}

export function resolveSafeModeConfig(options: {
  enabled?: boolean;
  commandPatterns?: string[];
  allowedSshHosts?: string[];
  blockedFileBasenames?: string[];
}): ResolvedSafeModeConfig {
  return {
    enabled: options.enabled ?? true,
    commandPatterns: compileCommandPatterns(options.commandPatterns ?? []),
    allowedSshHosts: new Set((options.allowedSshHosts ?? []).map(normalizeHost)),
    blockedFileBasenames: new Set(
      (options.blockedFileBasenames?.length ? options.blockedFileBasenames : [...DEFAULT_BLOCKED_FILE_BASENAMES])
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  };
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function basenameOf(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) return "";
  return path.basename(trimmed.replace(/\\/g, "/"));
}

function isUnderSshDir(filePath: string): boolean {
  const norm = filePath.trim().replace(/\\/g, "/");
  return /(?:^|\/)\.ssh\//.test(norm) || /^~\/\.ssh\//.test(norm);
}

export function isBlockedSshPrivateKeyPath(filePath: string): string | null {
  if (!isUnderSshDir(filePath)) return null;

  const base = basenameOf(filePath);
  if (!base) return null;
  if (base.endsWith(".pub")) return null;
  if (SSH_DIR_SAFE_BASENAMES.includes(base)) return null;

  return `Access to SSH private key "${base}" is blocked by safe mode`;
}

export function isBlockedFilePath(filePath: string, blockedBasenames: Set<string>): string | null {
  const base = basenameOf(filePath);
  if (base && blockedBasenames.has(base)) {
    return `Access to "${base}" is blocked by safe mode`;
  }
  return isBlockedSshPrivateKeyPath(filePath);
}

function commandReferencesSshPrivateKey(command: string): string | null {
  for (const match of command.matchAll(/\.ssh\/([^\s|&;'"`]+)/gi)) {
    const base = path.basename(match[1] ?? "");
    if (!base || base.endsWith(".pub")) continue;
    if (SSH_DIR_SAFE_BASENAMES.includes(base)) continue;
    return `Access to SSH private key "${base}" is blocked by safe mode`;
  }
  return null;
}

const SSH_HOST_RE = /\bssh(?:\s+-[^\s]+)*\s+(?:[^\s@]+@)?([^\s]+)/i;

export function extractSshHost(command: string): string | undefined {
  const match = command.match(SSH_HOST_RE);
  if (!match?.[1]) return undefined;
  return normalizeHost(match[1]);
}

export function commandUsesSsh(command: string): boolean {
  // Avoid matching `.ssh/` paths (e.g. `cat ~/.ssh/id_rsa`).
  return /(?<![.\w])ssh\b/i.test(command);
}

export function checkCommand(
  command: string,
  patterns: RegExp[],
  allowedSshHosts: Set<string>,
): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (commandUsesSsh(trimmed)) {
    const host = extractSshHost(trimmed);
    if (!host || !allowedSshHosts.has(host)) {
      const hostLabel = host ?? "unknown host";
      return `SSH to "${hostLabel}" is blocked by safe mode (add to safeMode.allowedSshHosts to allow)`;
    }
  }

  const sshKeyRead = commandReferencesSshPrivateKey(trimmed);
  if (sshKeyRead) return sshKeyRead;

  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      return `Command blocked by safe mode (matched ${pattern})`;
    }
  }

  return null;
}

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "glob"]);

export function extractPathFromToolInput(toolName: string, input: Record<string, unknown>): string | undefined {
  if (!PATH_TOOLS.has(toolName)) return undefined;

  const directPath = input.path ?? input.file_path ?? input.filePath;
  if (typeof directPath === "string" && directPath.trim()) {
    return directPath.trim();
  }

  if (toolName === "glob") {
    const pattern = input.glob_pattern ?? input.pattern ?? input.glob;
    if (typeof pattern === "string" && pattern.trim()) {
      return pattern.trim();
    }
  }

  return undefined;
}

export function checkToolCall(
  toolName: string,
  input: Record<string, unknown>,
  config: ResolvedSafeModeConfig,
): string | null {
  if (!config.enabled) return null;

  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return checkCommand(command, config.commandPatterns, config.allowedSshHosts);
  }

  const filePath = extractPathFromToolInput(toolName, input);
  if (filePath && (toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "grep")) {
    return isBlockedFilePath(filePath, config.blockedFileBasenames);
  }

  return null;
}

export function registerBfhSafeMode(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const fileConfig = loadBfhConfig(ctx.cwd).safeMode;
    const config = resolveSafeModeConfig(fileConfig);
    const reason = checkToolCall(event.toolName, event.input as Record<string, unknown>, config);
    if (!reason) return undefined;

    if (ctx.hasUI) {
      ctx.ui.notify(reason, "warning");
    }
    return { block: true, reason };
  });
}
