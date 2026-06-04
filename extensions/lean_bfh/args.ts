import { loadBfhConfig } from "./bfh-config.ts";
import { DEFAULT_DIFFICULTY, parseDifficultyLevel } from "./difficulty.ts";
import type { DifficultyLevel, HarnessStartArgs } from "./types.ts";

const START_FLAGS = new Set(["--no-jira", "-n", "--go", "-g", "--level", "-l"]);

export function normalizeIssueKey(raw: string): string {
  return raw.trim().toUpperCase();
}

function parseLevelFromTokens(tokens: string[], fallback: DifficultyLevel): DifficultyLevel {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--level" || token === "-l") {
      const parsed = parseDifficultyLevel(tokens[i + 1]);
      if (parsed) return parsed;
    }
    const eqMatch = /^--level=(.+)$/.exec(token);
    if (eqMatch) {
      const parsed = parseDifficultyLevel(eqMatch[1]);
      if (parsed) return parsed;
    }
  }
  return fallback;
}

export function parseHarnessStartArgs(raw: string, cwd = process.cwd()): HarnessStartArgs {
  const tokens = raw.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  const noJira = tokens.includes("--no-jira") || tokens.includes("-n");
  const autoGo = tokens.includes("--go") || tokens.includes("-g");
  const defaultDifficulty = loadBfhConfig(cwd).workflow.defaultDifficulty ?? DEFAULT_DIFFICULTY;
  const difficulty = parseLevelFromTokens(tokens, defaultDifficulty);

  const issueTokens: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (START_FLAGS.has(token)) {
      if (token === "--level" || token === "-l") i++;
      continue;
    }
    if (/^--level=/.test(token)) continue;
    issueTokens.push(token);
  }

  return {
    issueKey: normalizeIssueKey(issueTokens[0] || ""),
    noJira,
    autoGo,
    difficulty,
  };
}
