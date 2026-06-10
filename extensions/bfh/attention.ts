import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import { loadBfhConfig } from "./bfh-config.ts";
import { describePendingHarnessInput } from "./pending-input.ts";
import {
  activeStatePathFromSession,
  listStateFiles,
  readState,
} from "./state.ts";
import type { HarnessState } from "./types.ts";

const lastPingByStatePath = new Map<string, string>();

export function clearAttentionPingCache(): void {
  lastPingByStatePath.clear();
}

export function shouldSkipAttentionPing(statePath: string, signature: string): boolean {
  return lastPingByStatePath.get(statePath) === signature;
}

export function markAttentionPinged(statePath: string, signature: string): void {
  lastPingByStatePath.set(statePath, signature);
}

function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  const safeTitle = title.replace(/'/g, "''");
  const safeBody = body.replace(/'/g, "''");
  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${safeBody}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${safeTitle}').Show(${toast})`,
  ].join("; ");
}

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
  process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
  process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
  execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function notifyTerminalNative(title: string, body: string): void {
  if (process.env.WT_SESSION) {
    notifyWindows(title, body);
  } else if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body);
  } else {
    notifyOSC777(title, body);
  }
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function notifyMacOs(title: string, body: string, playSound: boolean): void {
  const soundClause = playSound ? ' sound name "Ping"' : "";
  const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}"${soundClause}`;
  execFile("osascript", ["-e", script]);
}

function notifyLinux(title: string, body: string): void {
  execFile("notify-send", [title, body]);
}

export function sendOsNotification(title: string, body: string, playSound: boolean): void {
  if (process.platform === "darwin") {
    notifyMacOs(title, body, playSound);
    return;
  }
  if (process.platform === "linux") {
    execFile("which", ["notify-send"], (err) => {
      if (!err) notifyLinux(title, body);
      else notifyTerminalNative(title, body);
    });
    return;
  }
  notifyTerminalNative(title, body);
}

const MACOS_DEFAULT_SOUND = "/System/Library/Sounds/Ping.aiff";

function playTerminalBell(): void {
  try {
    process.stderr.write("\x07");
  } catch {
    // ignore — bell is often disabled in terminal settings
  }
}

function spawnDetached(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    playTerminalBell();
  }
}

/** Audible ping — prefers system sound over terminal bell (often silent). */
export function playAttentionSound(): void {
  const custom = process.env.BFH_NOTIFICATION_SOUND_FILE?.trim();

  if (process.platform === "darwin") {
    const soundPath = custom || MACOS_DEFAULT_SOUND;
    if (fs.existsSync(soundPath)) {
      spawnDetached("afplay", [soundPath]);
      return;
    }
  }

  if (process.platform === "linux") {
    const candidates = [
      custom,
      "/usr/share/sounds/freedesktop/stereo/message.oga",
      "/usr/share/sounds/freedesktop/stereo/complete.oga",
    ].filter((p): p is string => Boolean(p?.trim()) && fs.existsSync(p));
    const soundPath = candidates[0];
    if (soundPath) {
      spawnDetached("paplay", [soundPath]);
      return;
    }
  }

  playTerminalBell();
}

export function resolveAttentionStatePath(ctx: ExtensionContext): string | undefined {
  const active = activeStatePathFromSession(ctx);
  if (active && fs.existsSync(active)) {
    return active;
  }

  for (const statePath of listStateFiles(ctx.cwd)) {
    if (!fs.existsSync(statePath)) continue;
    try {
      const state = readState(statePath);
      if (describePendingHarnessInput(state)) {
        return statePath;
      }
    } catch {
      // skip corrupt state files
    }
  }

  return active;
}

export function maybeNotifyHarnessAttention(ctx: ExtensionContext): void {
  const notifications = loadBfhConfig(ctx.cwd).notifications;
  if (!notifications.enabled) {
    return;
  }

  const statePath = resolveAttentionStatePath(ctx);
  if (!statePath || !fs.existsSync(statePath)) {
    return;
  }

  let state: HarnessState;
  try {
    state = readState(statePath);
  } catch {
    return;
  }

  const pending = describePendingHarnessInput(state);
  if (!pending) {
    return;
  }

  if (shouldSkipAttentionPing(statePath, pending.signature)) {
    return;
  }

  markAttentionPinged(statePath, pending.signature);

  if (notifications.sound) {
    playAttentionSound();
  }
  // Visual OS banner; audible ping is playAttentionSound() (afplay), not osascript sound.
  if (notifications.osNotify) {
    sendOsNotification(pending.title, pending.body, false);
  }

  ctx.ui.notify(`${pending.title} — ${pending.body}`, "warning");
}

export function registerBfhAttentionNotifications(pi: ExtensionAPI): void {
  pi.on("agent_end", async (_event, ctx) => {
    maybeNotifyHarnessAttention(ctx);
  });
}
