import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readPrinciplesExcerpt } from "./harness-docs.ts";

export type BfhAgentName = "scout" | "reviewer" | "closer";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_DIR, "../..");
const AGENTS_DIR = path.join(PACKAGE_ROOT, "agents");

const promptCache = new Map<BfhAgentName, string>();

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?---\n*/, "").trim();
}

export function getPackageRoot(): string {
  return PACKAGE_ROOT;
}

export function getAgentPromptPath(agentName: BfhAgentName): string {
  return path.join(AGENTS_DIR, `${agentName}.md`);
}

/** Load agent system prompt from `agents/<name>.md` (YAML frontmatter stripped). */
export function loadAgentPrompt(agentName: BfhAgentName): string {
  const cached = promptCache.get(agentName);
  if (cached) return cached;

  const filePath = getAgentPromptPath(agentName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`BFH agent prompt not found: ${filePath}`);
  }

  const body = stripFrontmatter(fs.readFileSync(filePath, "utf8"));
  promptCache.set(agentName, body);
  return body;
}

export function clearAgentPromptCache(): void {
  promptCache.clear();
}

export function getReviewSystemPrompt(cwd?: string): string {
  let prompt = loadAgentPrompt("reviewer");
  if (cwd) {
    const principles = readPrinciplesExcerpt(cwd);
    if (principles) {
      prompt += `\n\n## Repo principles (cite via principleRef)\n\n${principles}`;
    }
  }
  return prompt;
}

export function getScoutSystemPrompt(): string {
  return loadAgentPrompt("scout");
}

export function getCloserSystemPrompt(): string {
  return loadAgentPrompt("closer");
}
