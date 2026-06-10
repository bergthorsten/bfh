import * as fs from "node:fs";
import { ticketMarkerDir } from "./evidence-markers.ts";

export const WORKING_MEMORY_VERSION = 1;
export const WORKING_MEMORY_FILENAME = "working-memory.json";

export type WorkingMemory = {
  version: typeof WORKING_MEMORY_VERSION;
  updatedAt: string;
  failedApproaches: string[];
  blockers: string[];
  filesChanged: string[];
};

export type WorkingMemoryUpdate = {
  failedApproaches?: string[];
  blockers?: string[];
  filesChanged?: string[];
};

export function workingMemoryPath(statePath: string): string {
  return `${ticketMarkerDir(statePath)}/${WORKING_MEMORY_FILENAME}`;
}

function dedupeStrings(items: string[]): string[] {
  return Array.from(new Set(items.map((s) => s.trim()).filter(Boolean)));
}

export function emptyWorkingMemory(): WorkingMemory {
  return {
    version: WORKING_MEMORY_VERSION,
    updatedAt: new Date().toISOString(),
    failedApproaches: [],
    blockers: [],
    filesChanged: [],
  };
}

export function readWorkingMemory(statePath: string): WorkingMemory | null {
  const filePath = workingMemoryPath(statePath);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkingMemory;
    if (parsed.version !== WORKING_MEMORY_VERSION) return null;
    return {
      version: WORKING_MEMORY_VERSION,
      updatedAt: parsed.updatedAt,
      failedApproaches: Array.isArray(parsed.failedApproaches) ? parsed.failedApproaches : [],
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
    };
  } catch {
    return null;
  }
}

export function mergeWorkingMemory(existing: WorkingMemory, update: WorkingMemoryUpdate): WorkingMemory {
  return {
    version: WORKING_MEMORY_VERSION,
    updatedAt: new Date().toISOString(),
    failedApproaches: dedupeStrings([...existing.failedApproaches, ...(update.failedApproaches ?? [])]),
    blockers: dedupeStrings([...existing.blockers, ...(update.blockers ?? [])]),
    filesChanged: dedupeStrings([...existing.filesChanged, ...(update.filesChanged ?? [])]),
  };
}

export function writeWorkingMemory(statePath: string, memory: WorkingMemory): void {
  const dir = ticketMarkerDir(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const stamped = { ...memory, updatedAt: new Date().toISOString() };
  fs.writeFileSync(workingMemoryPath(statePath), `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
}

export function updateWorkingMemory(statePath: string, update: WorkingMemoryUpdate): WorkingMemory {
  const existing = readWorkingMemory(statePath) ?? emptyWorkingMemory();
  const merged = mergeWorkingMemory(existing, update);
  writeWorkingMemory(statePath, merged);
  return merged;
}

export function formatWorkingMemoryForPrompt(memory: WorkingMemory | null): string | undefined {
  if (!memory) return undefined;
  const lines: string[] = ["## Prior context (working memory)"];
  if (memory.failedApproaches.length) {
    lines.push("Failed approaches:", ...memory.failedApproaches.map((a) => `- ${a}`));
  }
  if (memory.blockers.length) {
    lines.push("Blockers:", ...memory.blockers.map((b) => `- ${b}`));
  }
  if (memory.filesChanged.length) {
    lines.push("Files touched:", ...memory.filesChanged.map((f) => `- ${f}`));
  }
  if (lines.length === 1) return undefined;
  return lines.join("\n");
}
