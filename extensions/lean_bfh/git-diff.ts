import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ChangedRange, TouchedFile } from "./types.ts";

function toNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDiffRanges(diff: string, map: Map<string, ChangedRange[]>): void {
  let currentFile: string | undefined;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length);
      if (!map.has(currentFile)) map.set(currentFile, []);
      continue;
    }

    if (!currentFile || !line.startsWith("@@")) continue;
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;

    const start = toNumber(match[1]);
    const count = toNumber(match[2]) ?? 1;
    if (!start) continue;
    map.get(currentFile)?.push({ startLine: start, endLine: start + Math.max(count, 1) - 1 });
  }
}

function mergeRanges(ranges: ChangedRange[]): ChangedRange[] {
  const normalized = ranges
    .filter((r) => typeof r.startLine === "number" && typeof r.endLine === "number")
    .map((r) => ({
      startLine: Math.max(1, Math.floor(r.startLine!)),
      endLine: Math.max(Math.floor(r.startLine!), Math.floor(r.endLine!)),
    }))
    .sort((a, b) => a.startLine - b.startLine);

  if (normalized.length === 0) return [];
  const merged: ChangedRange[] = [normalized[0]];

  for (let i = 1; i < normalized.length; i++) {
    const prev = merged[merged.length - 1];
    const next = normalized[i];
    if (next.startLine <= (prev.endLine ?? 0) + 3) {
      prev.endLine = Math.max(prev.endLine ?? 0, next.endLine);
    } else {
      merged.push(next);
    }
  }

  return merged;
}

export function discoverTouchedFiles(cwd: string, maxFiles: number): TouchedFile[] {
  const rangeMap = new Map<string, ChangedRange[]>();

  const collectDiff = (args: string[]) => {
    try {
      const output = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      parseDiffRanges(output, rangeMap);
    } catch {
      // Ignore non-git dirs or empty repositories.
    }
  };

  collectDiff(["diff", "--unified=0", "--no-color"]);
  collectDiff(["diff", "--cached", "--unified=0", "--no-color"]);

  const files: TouchedFile[] = [];
  for (const [filePath, ranges] of rangeMap.entries()) {
    const merged = mergeRanges(ranges);
    if (merged.length === 0) {
      files.push({ path: filePath });
    } else {
      for (const range of merged) {
        files.push({ path: filePath, startLine: range.startLine, endLine: range.endLine });
      }
    }
  }

  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    for (const line of status.split(/\r?\n/)) {
      if (!line.startsWith("?? ")) continue;
      const filePath = line.slice(3).trim();
      if (!filePath || files.some((f) => f.path === filePath)) continue;
      files.push({ path: filePath, note: "Untracked file" });
      if (files.length >= maxFiles) break;
    }
  } catch {
    // Ignore status failures.
  }

  return files.slice(0, maxFiles);
}

function renderSnippetWithLineNumbers(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  const safeStart = Math.max(1, startLine);
  const safeEnd = Math.min(lines.length, Math.max(safeStart, endLine));
  const out: string[] = [];

  for (let lineNo = safeStart; lineNo <= safeEnd; lineNo++) {
    out.push(`${String(lineNo).padStart(5, " ")} | ${lines[lineNo - 1] ?? ""}`);
  }

  return out.join("\n");
}

export function buildTouchedFileContext(
  cwd: string,
  touchedFiles: TouchedFile[],
): { context: string; filesUsed: TouchedFile[] } {
  const maxTotalChars = 40_000;
  const maxCharsPerFile = 8_000;
  const parts: string[] = [];
  const filesUsed: TouchedFile[] = [];
  let totalChars = 0;

  for (const touched of touchedFiles) {
    if (totalChars >= maxTotalChars) break;
    const absPath = path.isAbsolute(touched.path) ? touched.path : path.join(cwd, touched.path);
    let block: string;

    if (!fs.existsSync(absPath)) {
      block = `## ${touched.path}\n(File not found on disk)\n`;
    } else {
      try {
        const content = fs.readFileSync(absPath, "utf8");
        const hasRange = typeof touched.startLine === "number" && typeof touched.endLine === "number";
        const lineCount = content.split(/\r?\n/).length;
        const snippet = hasRange
          ? renderSnippetWithLineNumbers(content, Math.max(1, touched.startLine! - 4), touched.endLine! + 4)
          : renderSnippetWithLineNumbers(content, 1, Math.min(lineCount, 120));
        const trimmed =
          snippet.length > maxCharsPerFile ? `${snippet.slice(0, maxCharsPerFile)}\n... (truncated)` : snippet;
        block = [`## ${touched.path}`, touched.note ? `Note: ${touched.note}` : undefined, "```", trimmed, "```"]
          .filter(Boolean)
          .join("\n");
      } catch {
        block = `## ${touched.path}\n(File not readable as utf8 text)\n`;
      }
    }

    if (totalChars + block.length > maxTotalChars) break;
    parts.push(block);
    filesUsed.push(touched);
    totalChars += block.length;
  }

  return { context: parts.join("\n\n"), filesUsed };
}
