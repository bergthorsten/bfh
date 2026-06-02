# BFH — Bergfreunde Harness for Pi

**BFH** is a [Pi](https://github.com/badlogic/pi-mono) extension that turns a Jira ticket into a reviewed pull request with evidence on disk. You run `/bfh PC-120` in the repository you want to change; Pi loads ticket context, writes a state file under `.pi/bfh/`, and guides the agent through scout → implement → verify/review → close → retro with hard transition rules and a two-revision cap.

Repository: [github.com/bergthorsten/bfh](https://github.com/bergthorsten/bfh)

---

## Install

Requires Pi with `@mariozechner/pi-coding-agent` and `typebox` (peer dependencies).

### From GitHub (recommended)

```bash
pi install git:github.com/bergthorsten/bfh@v0.1.0
```


### Jira credentials

Set environment variables or `~/.pi/agents/jira.json`:

```bash
export JIRA_BASE_URL="https://portal.bergfreunde.de/jira"
export JIRA_TOKEN="..."
```

Example `~/.pi/agents/jira.json`:

```json
{
  "JIRA_BASE_URL": "https://jira.your-company.com",
  "JIRA_TOKEN": "..."
}
```

For close/PR steps you also need `git`, `gh` (authenticated), and permission to push the current branch.

---

## Quick start

From the target repository:

```bash
cd ~/devenv/src
pi
/bfh PC-120
```

1. Jira ticket **PC-120** is fetched (unless `--no-jira`).
2. State is saved to `.pi/bfh/PC-120.state.json`.
3. The kickoff prompt appears **in the editor** — add `@path/to/file` context, then press **Enter**.

Skip the editor and start the agent immediately:

```bash
/bfh PC-120 --go
```

No Jira (offline smoke test):

```bash
/bfh POC-120 --no-jira
```

Check progress:

```text
/bfh-status PC-120
```

Resume later:

```text
/bfh-resume PC-120
```

Validate the extension locally (no Jira, no LLM):

```bash
bun extensions/lean_bfh/run-selftest.ts
```

or inside Pi: `/bfh-selftest`

---

## How it works

### Phase flow

```text
intake → scout → clarify? → implement → verify_review
                              ↳ max 2× back to implement
       → close → retro → done
```

| Phase | What happens |
| ----- | ------------ |
| `scout` | Read-only recon; `/bfh-scout` or `bfh_state` `scout_auto` |
| `clarify` | Optional questions in `openQuestions` |
| `implement` | Code change + test evidence |
| `verify_review` | Fresh reviewer subagent; may return to `implement`, advance to `close`, or `failed` |
| `close` | Gates + draft PR via `gh` |
| `retro` | Notes in state / `LEARNINGS.md` |
| `done` | Finished |

Illegal step changes are rejected by the `bfh_state` tool (the agent must not edit `currentStep` in the JSON file directly).

### State on disk

```text
.pi/bfh/
  PC-120.state.json
```

Schema: `bfh-state.schema.json` in this repo.

Example excerpt:

```json
{
  "schemaVersion": 1,
  "ticketKey": "PC-120",
  "summary": "Fix checkout timeout",
  "currentStep": "implement",
  "revisionCount": 1,
  "revisionLimit": 2,
  "acceptanceCriteria": ["Redirect completes within 30s"],
  "evidence": [
    {
      "type": "test",
      "passed": true,
      "summary": "Integration test green",
      "command": "vendor/bin/phpunit tests/Integration/CheckoutTest.php",
      "createdAt": "2026-06-02T12:00:00.000Z"
    }
  ],
  "review": { "verdict": "needs_revision", "findings": [], "summary": "..." },
  "pr": { "url": null, "draft": true },
  "finalVerdict": "pending"
}
```

---

## Commands

| Command | Description |
| ------- | ----------- |
| `/bfh <KEY> [--no-jira] [--go]` | Start a run; editor prefill unless `--go` |
| `/bfh-resume [KEY\|path] [--go]` | Continue an existing state file |
| `/bfh-status [KEY\|path]` | Print status summary |
| `/bfh-list` | List `.pi/bfh/*.state.json` in cwd |
| `/bfh-scout [KEY\|path]` | Run scout subagent (step must be `scout`) |
| `/bfh-verify [KEY\|path]` | Run verify/review subagent (step must be `verify_review`) |
| `/bfh-close [KEY\|path]` | Close gates + create/reuse draft PR |
| `/bfh-pr-sync [KEY\|path]` | Pull GitHub PR review status (`gh`) into state |
| `/bfh-retro [KEY\|path]` | Append `LEARNINGS.md`, stage `.pi/bfh/amendments/` |
| `/bfh-selftest` | Smoke-test state machine |

**Flags**

| Flag | Meaning |
| ---- | ------- |
| `--no-jira` / `-n` | Ticket key only; no Jira API |
| `--go` / `-g` | Send kickoff immediately (no editor prefill) |

---

## In-depth examples

### 1. Start with file context (recommended)

```text
/bfh PC-120
```

The editor is prefilled with ticket summary, acceptance criteria, and the phase contract. Add:

```text
Focus on checkout timeout in @src/Service/Checkout/PaymentHandler.php
Repro: POST /api/checkout — see @tests/Integration/CheckoutTest.php
Do not modify @src/Legacy/
```

Press **Enter**. The agent should call `bfh_state` with `advance` → `scout` before editing production code.

### 2. Scout, then implement

After kickoff, the agent (or you via command) runs scout:

```text
/bfh-scout PC-120
```

Or the agent calls:

```json
{ "action": "scout_auto", "scoutFocus": "payment redirect only" }
```

`state.scout` is filled with `relevantFiles`, `commands`, `patterns`, and a `summary`.

Advance manually if needed:

```json
{ "action": "advance", "nextStep": "implement" }
```

### 3. Record test evidence

```json
{
  "action": "evidence",
  "evidence": {
    "type": "test",
    "command": "vendor/bin/phpunit tests/Integration/CheckoutTest.php",
    "passed": true,
    "summary": "Checkout redirect test green",
    "logPath": ".pi/bfh/logs/pc-120-phpunit.log"
  }
}
```

### 4. Verify / review gate

When `currentStep` is `verify_review`:

```text
/bfh-verify PC-120
```

Or:

```json
{
  "action": "verify_review",
  "implementationNotes": "Added 30s timeout on Adyen return handler",
  "reviewFocus": "Session restore vs payment capture race",
  "maxFiles": 15
}
```

Outcomes:

- **Approved** → auto-advance to `close`
- **Needs revision** and budget left → back to `implement` (`revisionCount` increments)
- **Needs revision** and budget exhausted → `failed`

`diff_context` supplies compact git snippets without dumping whole files:

```json
{ "action": "diff_context", "maxFiles": 20 }
```

### 5. Draft PR

When review is approved and test evidence exists:

```text
/bfh-close PC-120
```

Dry-run first via the tool:

```json
{
  "action": "close_check"
}
```

```json
{
  "action": "close_create",
  "prTitle": "PC-120: Fix checkout timeout on Adyen redirect",
  "dryRun": true
}
```

Then without `dryRun` to push and run `gh pr create --draft`.

### 6. Clarify open questions

```json
{
  "action": "question",
  "question": {
    "id": "timeout-value",
    "question": "Should the redirect timeout be 30s or 60s?",
    "answer": "30s per PC-120 comment"
  }
}
```

Patch other fields (not `currentStep`):

```json
{
  "action": "patch",
  "patch": {
    "implementationPlan": [
      "Add timeout constant",
      "Wire into PaymentHandler",
      "Extend integration test"
    ]
  }
}
```

### 7. Status output

```text
/bfh-status PC-120
```

Example:

```text
# PC-120 — Fix checkout timeout on Adyen redirect

State: .pi/bfh/PC-120.state.json
Step: implement
Revision: 1/2
Review: needs_revision
Evidence: 3
PR: (none)
Verdict: pending

## Acceptance criteria
- Redirect completes within 30s

## Latest evidence
- test passed=true command=vendor/bin/phpunit ...: Integration test green
```

---

## `bfh_state` tool reference

Registered for the agent as **`bfh_state`**. Defaults `statePath` to the active session’s `.pi/bfh` file.

| Action | Purpose |
| ------ | ------- |
| `read` | Full state JSON |
| `advance` | `nextStep`: legal transition only |
| `patch` | Update non-guarded fields |
| `evidence` | Append evidence item |
| `question` | Upsert `openQuestions` |
| `verdict` | Set `finalVerdict` |
| `diff_context` | Git diff snippets for review |
| `scout_auto` | Subagent scout → `state.scout` |
| `verify_review` | Subagent review + auto-transition |
| `close_check` | Readiness + PR body, no PR |
| `close_create` | Gates, push, draft PR |

Guarded fields (use `advance`, not `patch`): `currentStep`, `revisionCount`, `revisionLimit`, `schemaVersion`, `ticketKey`, `createdAt`, `updatedAt`.

---

## Repository layout

```text
bfh/
  package.json              # pi.extensions → ./extensions/lean_bfh
  bfh-state.schema.json
  extensions/lean_bfh/
    index.ts                # extension entry
    commands.ts             # /bfh, /bfh-status, …
    tool.ts                 # bfh_state
    state.ts                # transitions + persistence
    jira.ts                 # ticket fetch for /bfh intake
    subagent.ts             # scout/review subprocess runners
    close.ts                # PR gates + gh
    kickoff.ts              # editor prefill vs --go
    …
```

---

## Principles

- **State file beats chat** — humans and reviewers read `.pi/bfh/*.state.json`.
- **Transitions are enforced in code** — not by prompt politeness alone.
- **Fresh context for review** — verify/review runs in an isolated subagent process.
- **You steer at kickoff** — default editor prefill with `@` files; `--go` when the plan is already clear.
