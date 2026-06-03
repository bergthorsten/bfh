# AGENTS.md

## What this is

**BFH (Bergfreunde Harness for Pi)** — a [Pi](https://github.com/badlogic/pi-mono) extension that turns a Jira ticket into a reviewed draft PR.

## The idea

Humans steer, agents execute. You provide the ticket + repo context; BFH gives the agent a small, enforced workflow (`intake → scout → clarify? → implement → verify_review → close → pr_review → retro → done`) with phase transitions gated by code (schema + markers), fresh-context subagents for scout/review, and on-disk state per ticket at `.pi/bfh/<TICKET>.state.json`. Knowledge compounds via retrospectives and staged harness amendments. Borrowed patterns live under `case/` (read-only reference).

## Key files

| File | What & when |
| --- | --- |
| `README.md` | User docs: install, commands, workflow, troubleshooting. Read first. |
| `DRAFT.md` | Idea paper + backlog (done/deferred). Read for design rationale. |
| `package.json` | Pi package manifest; defines `extensions/lean_bfh` and npm scripts. |
| `install.sh` | One-shot installer (Node 22+, Pi, pi-subagents, BFH release). |
| `bfh-state.schema.json` | JSON Schema for ticket state; source of truth for phases/fields. |
| `agents/scout.md` | Read-only scout subagent prompt; run pre-implement. |
| `agents/reviewer.md` | Fresh-context review subagent; run at `verify_review`. |
| `agents/closer.md` | Closer subagent prompt; used for draft PR creation. |
| `agents/retrospective.md` | Retro subagent; writes learnings + amendments. |
| `extensions/lean_bfh/index.ts` | Extension entry; wires commands + `bfh_state` tool. |
| `extensions/lean_bfh/commands.ts` | `/bfh`, `/bfh-status`, `/bfh-resume`, `/bfh-close`, etc. |
| `extensions/lean_bfh/tool.ts` | `bfh_state` tool: all phase gates, markers, subagent calls. |
| `extensions/lean_bfh/state.ts` | State CRUD, transition validation, evidence handling. |
| `extensions/lean_bfh/difficulty.ts` | Level 1–3 behavior, model hints, hands-off bypass. |
| `extensions/lean_bfh/design-review.ts` | Level-3 design_gate flow (options → choice → proposal → accept/decline). |
| `extensions/lean_bfh/outcome-table.ts` | Maps subagent outcomes → next phase. |
| `extensions/lean_bfh/close.ts` | Close gates + draft PR creation via `gh`. |
| `extensions/lean_bfh/subagent.ts` | Spawns fresh-context scout/review subagents; parses `AGENT_RESULT`. |
| `extensions/lean_bfh/evidence-markers.ts` | Writes `tested.json` / `reviewed.json` markers; close-gate evidence. |
| `extensions/lean_bfh/jira.ts` | Fetches ticket details + custom fields during intake. |
| `extensions/lean_bfh/brief.ts` | Builds `.brief.md`, kickoff, and resume prompts. |
| `extensions/lean_bfh/pr-sync.ts` | Pulls GitHub PR review status; gates `done` until approved. |
| `extensions/lean_bfh/retro.ts` | Runs retro: appends `LEARNINGS.md`, stages amendments. |
| `extensions/lean_bfh/types.ts` | Shared TS types: `HarnessState`, `STEP_ORDER`, config shapes. |
| `extensions/lean_bfh/schema.ts` | TypeBox schema for `bfh_state` tool params + actions. |
| `extensions/lean_bfh/display.ts` | Renders human-readable state text from the `bfh_state` tool. |
| `extensions/lean_bfh/status.ts` | Renders progress bar for `/bfh-status` and status command. |
| `extensions/lean_bfh/working-memory.ts` | CRUD for `working-memory.json`; repair-loop context. |
| `extensions/lean_bfh/metrics.ts` | Per-ticket telemetry: `events.jsonl` + `metrics.json` under `.pi/bfh/<TICKET>/`. |
| `bfh-metrics.schema.json` | JSON Schema for aggregated ticket metrics snapshot. |

## Current Status

We are in development phase, so we can rip apart features without debrecating it! No customers yet, we decide what to bring in or rip out!

Before implementation, look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."


## Coding Style
Write modern / clean / and easy to read - easy to maintain code!