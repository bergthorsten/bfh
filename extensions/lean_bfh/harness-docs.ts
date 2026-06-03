import * as fs from "node:fs";
import * as path from "node:path";
import { stateDirFor } from "./state.ts";

const PRINCIPLES_TEMPLATE = `# BFH principles (repo-local)

Mark rules as **[enforced]** (reviewer may block close) or **[advisory]** (warnings only).

## Enforced

- **[enforced]** Tests pass before \`mark_tested\` / close.
- **[enforced]** No secrets or credentials in the diff.
- **[enforced]** Conventional commits; no direct push to default branch.

## Advisory

- **[advisory]** Match existing patterns in touched modules.
- **[advisory]** Add regression tests for bug fixes when practical.

Reviewer findings may cite \`enforced/N\` or \`advisory/N\` via \`principleRef\`.
`;

const HARNESS_README_TEMPLATE = `# BFH harness map

Lean Bergfreunde Harness state for this repo lives under \`.pi/bfh/\`.

| Path | Purpose |
|------|---------|
| \`<TICKET>.state.json\` | Phase, review, evidence (agent may patch via \`bfh_state\`) |
| \`<TICKET>.brief.md\` | Mission summary + progress log |
| \`<TICKET>/tested.json\` | SHA-pinned test output (harness only) |
| \`<TICKET>/reviewed.json\` | Review counts at verify time (harness only) |
| \`<TICKET>/working-memory.json\` | Repair-loop context |
| \`<TICKET>/pr-review.json\` | Last GitHub PR review sync (harness only) |
| \`principles.md\` | Enforced vs advisory rules for reviewer |
| \`amendments/\` | Staged structured harness improvement proposals from retro |

**Commands:** \`/bfh\`, \`/bfh-resume\`, \`/bfh-verify\`, \`/bfh-close\`, \`/bfh-pr-sync\`, \`/bfh-retro\`

Full user docs: package README in the BFH repo.
`;

export function principlesPath(cwd: string): string {
  return path.join(stateDirFor(cwd), "principles.md");
}

export function harnessReadmePath(cwd: string): string {
  return path.join(stateDirFor(cwd), "README.md");
}

export function ensurePrinciplesFile(cwd: string): string {
  const filePath = principlesPath(cwd);
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, PRINCIPLES_TEMPLATE, "utf8");
  }
  return filePath;
}

export function ensureHarnessReadme(cwd: string): string {
  const filePath = harnessReadmePath(cwd);
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, HARNESS_README_TEMPLATE, "utf8");
  }
  return filePath;
}

export function readPrinciplesExcerpt(cwd: string, maxChars = 1500): string | undefined {
  const filePath = principlesPath(cwd);
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n… [see ${filePath}]`;
}
