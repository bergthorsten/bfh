# BFH — Bergfreunde Harness for Pi

BFH is a [Pi](https://github.com/badlogic/pi-mono) extension for turning a Jira ticket into a reviewed draft pull request.

Humans steer, agents execute: you provide the ticket, acceptance criteria, and repository context; BFH gives the agent a small, enforced workflow so the work stays reliable, reviewable, and easier to improve next time.

You start it from the repository you want to change:

```text
/bfh PC-120
```

BFH then creates a state file under `.pi/bfh/`, guides the agent through scouting, implementation, review, PR creation, and retrospective notes, and keeps the important evidence on disk instead of only in chat.

Repository: [github.com/bergthorsten/bfh](https://github.com/bergthorsten/bfh)

## What You Get

- A step-by-step workflow for Jira ticket work.
- A local state file for every ticket: `.pi/bfh/<TICKET>.state.json`.
- A read-only scout pass before implementation.
- A fresh review pass before closing.
- Close gates for tests, review evidence, and draft PR creation.
- A short retrospective trail with auto-derived run insights and staged harness amendments.

The short version:

```text
intake -> scout -> clarify? -> implement -> verify_review -> close -> pr_review -> retro -> done
```

Set difficulty at start with `--level 1|2|3` (default **2**):

| Level | Meaning |
| --- | --- |
| **1** | Easy / hands-off — internal human checkpoints bypassed (no `human_gate`). |
| **2** | Medium (default) — agent decides when to clarify or ask the human. |
| **3** | Hard — mandatory design review after scout (2–3 options → human choice → proposal → accept/decline) before implement. |

Per-level implementer model hints ship with the package (override in repo-root `config.jsonc` or env `BFH_IMPLEMENT_MODEL_L1`–`L3`).

## Prerequisites

Install these before installing BFH:

1. **Node.js 22 or newer**

   Check your version:

   ```bash
   node --version
   ```

   If the version is below `v22.0.0`, install a newer Node.js version first.

2. **Pi**

   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   ```

3. **Pi subagents**

   BFH uses subagents for scout and review steps.

   ```bash
   pi install npm:@tintinweb/pi-subagents
   ```

4. **GitHub CLI for PR creation**

   This is only needed for the close/PR step.

   ```bash
   gh auth status
   ```

   If you are not logged in, run:

   ```bash
   gh auth login
   ```

## Install BFH

The fastest install path is:

```bash
curl -fsSL https://github.com/bergthorsten/bfh/releases/latest/download/install.sh | sh
```

The installer checks for Node.js 22+, installs Pi, installs `@tintinweb/pi-subagents`, and installs BFH from the latest GitHub release.

Published GitHub releases automatically upload the repository's root `install.sh` as the `install.sh` release asset used by this URL.

If you prefer to run the Pi install manually:

```bash
latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/bergthorsten/bfh/releases/latest)"
latest_tag="${latest_url##*/}"
pi install "git:github.com/bergthorsten/bfh@${latest_tag}"
```

If no release exists yet, install from the current development branch instead:

```bash
pi install git:github.com/bergthorsten/bfh
```

### Local Installer Script

This repository includes the same helper script for local development:

```bash
./install.sh
```

It does not install Node.js for you because Node installation differs by operating system and version manager. Install Node 22+ first, then run the script.

## Configure BFH

BFH reads repo-local settings from **`config.jsonc`** at the repository root (JSON with comments). This file is **gitignored** — the installer or first `/bfh` copies `config.example.jsonc` from the package.

```jsonc
{
  "jira": {
    "baseUrl": "https://portal.bergfreunde.de/jira",
    // "token": "…",  // or export JIRA_TOKEN for CI
    "authMode": "bearer"
  },
  "workflow": {
    "defaultDifficulty": 2,
    "baseBranch": "main"
  },
}
```

Model defaults ship with the BFH package (see commented block in `config.example.jsonc`). Uncomment `models` in `config.jsonc` only to override.

Environment variables override file values (useful for secrets in CI): `JIRA_TOKEN`, `JIRA_BASE_URL`, `BFH_BASE_BRANCH`, `JIRA_ACCEPTANCE_FIELDS`, `JIRA_CONSTRAINT_FIELDS`, and model env vars `BFH_IMPLEMENT_MODEL_L1`–`L3`.

Optional: commit `config.example.jsonc` in your app repo with team workflow defaults (no tokens).

If you only want to try BFH without Jira, use `--no-jira`.

## Your First Run

1. Open the repository where the ticket should be implemented.

   ```bash
   cd ~/devenv/my-project
   pi
   ```

2. Start BFH with a Jira ticket key.

   ```text
   /bfh PC-120
   ```

3. Review the kickoff prompt.

   Pi opens a prepared prompt in the editor. Add useful context, for example:

   ```text
   Focus on checkout timeout in @src/Service/Checkout/PaymentHandler.php
   Repro: POST /api/checkout, see @tests/Integration/CheckoutTest.php
   Do not modify @src/Legacy/
   ```

4. Press **Enter** to start.

5. Check progress at any time:

   ```text
   /bfh-status PC-120
   ```

6. Resume later if needed:

   ```text
   /bfh-resume PC-120
   ```

## Common Commands

| Command | What it does |
| --- | --- |
| `/bfh <KEY>` | Start a new ticket run. |
| `/bfh <KEY> --go` | Start immediately without editing the kickoff prompt. |
| `/bfh <KEY> --no-jira` | Start with only the ticket key, no Jira lookup. |
| `/bfh <KEY> --level 1\|2\|3` | Difficulty (default 2). Level 1 = hands-off; level 3 = mandatory design review. |
| `/bfh-status [KEY\|path]` | Show the current state summary. |
| `/bfh-list` | List BFH state files in this repository. |
| `/bfh-resume [KEY\|path]` | Continue an existing run. |
| `/bfh-scout [KEY\|path]` | Run the scout subagent when the state is in `scout`. |
| `/bfh-verify [KEY\|path]` | Run the review gate when the state is in `verify_review`. |
| `/bfh-close [KEY\|path]` | Run close gates and create or reuse a draft PR. |
| `/bfh-pr-sync [KEY\|path]` | Sync GitHub PR review status into BFH state. |
| `/bfh-retro [KEY\|path]` | Write retrospective notes and proposed harness amendments. |
| `/bfh-selftest` | Run the local BFH smoke test inside Pi. |

## How The Workflow Feels

### 1. Intake

BFH reads the Jira ticket, creates `.pi/bfh/<TICKET>.state.json`, writes a short brief, and prepares the kickoff prompt.

### 2. Scout

The agent investigates before editing. Scout output records relevant files, commands, patterns, and risks in the state file.

### 3. Clarify + Human Pre-Implement Checkpoint (Optional)

If there are real decision points, the agent asks targeted questions and records them in state. You can explicitly approve before implementation starts.

### 4. Implement

The agent makes the code change. Test evidence should be recorded before review. Close gates later require passing evidence and marker files written by BFH.

### 5. Verify And Review

BFH runs a fresh review pass. Outcomes are:

- `approved`: move forward to close.
- `needs_revision`: go back to implementation, up to the revision limit.
- `failed`: stop when the revision budget is exhausted or the review cannot pass.

### 6. Close (Human Pre-Close Approval Required)

BFH checks the state, test markers, review markers, human pre-close approval, and working tree. If everything is ready, it can create a draft PR with `gh`.

After PR creation BFH also waits for GitHub status checks: by default it waits 2 minutes, checks once, then retries every 30 seconds up to 6 total attempts. If checks fail, BFH records the failing workflows and moves back to implementation. If checks are still pending after the retry budget, BFH leaves the PR in review and asks you to wait and run `/bfh-pr-sync` later. Configure this under `workflow.prChecks` in `config.jsonc` or via `BFH_PR_CHECKS_*` env vars.

You can set the base branch explicitly:

```bash
export BFH_BASE_BRANCH="main"
```

### 7. PR Review And Retro

After a draft PR exists, BFH can sync GitHub review status and status-check results, and only move to `done` after approval plus non-failing/non-pending checks unless explicitly overridden. The retro step now auto-derives compact insights (for example revision-loop usage, missing test evidence, and PR review bounce-back), appends them to `LEARNINGS.md`, and stages a structured amendment proposal when requested.

## Files BFH Writes

For a ticket like `PC-120`, expect files like:

```text
.pi/bfh/.gitignore
.pi/bfh/PC-120.state.json
.pi/bfh/PC-120.brief.md
.pi/bfh/PC-120/tested.json
.pi/bfh/PC-120/reviewed.json
.pi/bfh/PC-120/REVIEW.md
.pi/bfh/PC-120/manual-tested.json
.pi/bfh/PC-120/working-memory.json
.pi/bfh/PC-120/pr-review.json
config.jsonc
config.example.jsonc
.pi/bfh/principles.md
.pi/bfh/README.md
.pi/bfh/amendments/
```

The state schema lives in `bfh-state.schema.json`.

## Local Development

Run the deterministic smoke test:

```bash
bun run selftest
```

Validate the state schema:

```bash
bun run validate:schema
```

Run the full local check:

```bash
bun run check
```

## Repository Layout

```text
bfh/
  package.json
  bfh-state.schema.json
  install.sh
  agents/
    scout.md
    reviewer.md
    closer.md
    retrospective.md
  extensions/bfh/
    index.ts
    commands.ts
    tool.ts
    state.ts
    jira.ts
    subagent.ts
    bfh-agents.ts
    pi-subagents-bridge.ts
    close.ts
    kickoff.ts
  ~/.pi/agent/agents/  # auto-synced scout.md + reviewer.md (repo .pi/agents can override)
```

## Troubleshooting

### `node --version` is below 22

Install Node.js 22 or newer, then rerun the install steps.

### `pi: command not found`

Install Pi:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Then open a new shell and try:

```bash
pi --help
```

### Jira lookup fails

Check `JIRA_BASE_URL` and `JIRA_TOKEN`, or start without Jira:

```text
/bfh PC-120 --no-jira
```

### PR creation fails

Check that `gh` is installed and authenticated:

```bash
gh auth status
```

Also make sure you have permission to push the current branch and that the working tree is clean before close.

## Design Principles

- State on disk beats memory in chat.
- Humans steer; agents execute.
- Phase transitions are enforced by code.
- Review runs with fresh context.
- The kickoff is a map, not a manual: add only the concrete file and repo context the agent needs.
- Instructions decay; enforcement persists.
- Knowledge compounds across runs through retrospectives and harness amendments.
