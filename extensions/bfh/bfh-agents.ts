/**
 * Sync BFH scout/reviewer agent definitions into .pi/agents/ for @tintinweb/pi-subagents.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentPromptPath, getPackageRoot } from "./prompt-loader.ts";

const BFH_SUBAGENT_NAMES = ["scout", "reviewer"] as const;
export type BfhSubagentName = (typeof BFH_SUBAGENT_NAMES)[number];

const READ_ONLY_TOOLS = "read, bash, grep, find, ls";

const AGENT_META: Record<
  BfhSubagentName,
  { description: string; maxTurns: number }
> = {
  scout: {
    description:
      "Read-only exploration agent for BFH. Surfaces relevant files, patterns, and constraints before implementation.",
    maxTurns: 30,
  },
  reviewer: {
    description:
      "Fresh-context code review agent for BFH. Produces severity-classified findings that gate PR creation.",
    maxTurns: 40,
  },
};

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?---\n*/, "").trim();
}

function buildTintinwebAgentMarkdown(agentName: BfhSubagentName, body: string): string {
  const meta = AGENT_META[agentName];
  return [
    "---",
    `description: ${meta.description}`,
    `tools: ${READ_ONLY_TOOLS}`,
    "extensions: false",
    "skills: false",
    "prompt_mode: replace",
    `max_turns: ${meta.maxTurns}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** Write scout/reviewer agent .md files to `<cwd>/.pi/agents/` when content differs. */
export function ensureBfhSubagentDefinitions(cwd: string): void {
  const destDir = path.join(cwd, ".pi", "agents");
  fs.mkdirSync(destDir, { recursive: true });

  for (const agentName of BFH_SUBAGENT_NAMES) {
    const sourcePath = getAgentPromptPath(agentName);
    const destPath = path.join(destDir, `${agentName}.md`);
    const raw = fs.readFileSync(sourcePath, "utf8");
    const body = stripFrontmatter(raw);
    const content = buildTintinwebAgentMarkdown(agentName, body);

    if (!fs.existsSync(destPath) || fs.readFileSync(destPath, "utf8") !== content) {
      fs.writeFileSync(destPath, content, "utf8");
    }
  }
}

export function getBfhSubagentDefinitionsDir(cwd: string): string {
  return path.join(cwd, ".pi", "agents");
}

export function getPackageAgentsDir(): string {
  return path.join(getPackageRoot(), "agents");
}
