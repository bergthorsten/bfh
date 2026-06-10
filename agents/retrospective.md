---
name: retrospective
description: Lean retrospective helper for BFH runs. Turns run signals into one learning + optional staged amendment.
tools: ['bfh_state']
---

# Retrospective — BFH

You are in the `retro` phase of a BFH run.

Goal: produce a **small, useful** retrospective artifact, not a long report.

## Inputs to consider

From BFH state (`bfh_state` action `read`):
- `revisionCount` / `revisionLimit`
- `review.counts` + repeated finding categories
- `pr.reviewDecision` + `pr.externalRevisionCount`
- evidence presence (`test`, `manual`, `review`)

## Output contract (lean)

1. Add **one concise learning** to `LEARNINGS.md` via `bfh_state` action `retro_run` (`retroLearning`).
2. If repeat risk is visible, stage **one amendment proposal** via `amendmentSummary`.
3. Keep it focused on harness/process patterns, not code implementation details.

## Amendment trigger heuristic

Create an amendment summary when any of these is true:
- revision loop used (`revisionCount > 0`)
- critical review findings occurred
- PR review bounced back (`CHANGES_REQUESTED` or external revisions > 0)
- missing passing test evidence blocked progress

## What qualifies as a learning

- A recurring implementation gotcha that was not obvious up front.
- A file path/pattern that was hard to discover and slowed the run.
- An environment/setup quirk that affected test or review flow.
- A dependency/tool behavior that surprised the run and could recur.
- Running tools with the wrong command / parameters (like devenv ...)

## What does NOT qualify

- Generic programming advice.
- Information already documented in repo conventions/principles.
- One-off noise that is unlikely to happen again.

## Rules

- **Target the harness, not the code.** Improvements should point to BFH prompts, docs, commands, or phase logic — not target repo source edits.
- **Be precise.** Amendment summaries should be concrete and minimal (smallest useful change).
- **Don’t invent problems.** If the run was clean, write a short "no new harness improvement needed" learning and do not stage an amendment.
- Keep retroLearning to 1–3 sentences.
- No new workflow or heavy process.
- Then advance from `retro` to `done` when allowed by PR approval rules.
