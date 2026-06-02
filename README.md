# pi-team-tools

Starter bundle for team-shared Pi extensions.

Included tools:
- `jira_myself`
- `jira_get_issue`
- `jira_search`
- `bf_shop_db_query`
- `build_questionnaire`
- `run_fresh_review`
- `bfh_state`

Included commands:
- `/build <TICKET-123>` — existing Jira ticket → production workflow
- `/bfh <TICKET-123> [--no-jira]` — lean BFH POC: Jira intake (or local/offline mode) → state file → scout/clarify/implement/verify-review/close/retro loop
- `/bfh-status [TICKET-123|state-path]` — show compact current state
- `/bfh-list` — list local harness state files
- `/bfh-resume [TICKET-123|state-path]` — resume an existing run
- `/bfh-scout [TICKET-123|state-path]` — run automated read-only scout subagent and patch `state.scout`
- `/bfh-verify [TICKET-123|state-path]` — run the combined verify/review helper and auto-transition
- `/bfh-close [TICKET-123|state-path]` — enforce close gates and create/reuse a draft PR
- `/bfh-selftest` — run local deterministic harness smoke checks

## Team-ready repo setup (already included)

This starter now includes:

- `.pi/settings.json` with:
  - `"packages": [".."]` (loads this package from repo root)
  - `"skills": ["../.claude/skills"]` (loads shared Claude-style skills)
- `.claude/skills/` folder for shared skills

So teammates can clone this repo and run `pi` directly.

## Install

### From git (published package usage)

```bash
pi install git:git@github.com:your-org/pi-team-tools.git
# or
pi install https://github.com/your-org/pi-team-tools
```

### Local test before publishing

```bash
pi install /absolute/path/to/pi-team-tools-starter
```

## Using this package from another project repo

In the consuming repo, create `.pi/settings.json`:

```json
{
  "packages": [
    "git:github.com/your-org/pi-team-tools@v0.1.0"
  ],
  "skills": [
    "../.claude/skills"
  ]
}
```

Then commit these folders in that consuming repo:

- `.pi/settings.json`
- `.claude/skills/`

## Required environment

### Jira

```bash
export JIRA_BASE_URL="https://jira.your-company.com"
export JIRA_TOKEN="..."
# optional:
export JIRA_AUTH_MODE="bearer"   # or "basic"
export JIRA_EMAIL="you@company.com"   # required for basic mode
```

### DB (for `bf_shop_db_query`)

Supported vars:
- `DB_HOST` (optional, default `localhost`)
- `DB_PORT` (optional, default `3306`)
- `DB_NAME` or `DB_DATABASE`
- `DB_USER` or `DB_USERNAME`
- `DB_PASSWORD`

Env source precedence in current tool:
1. `envFile` tool argument
2. `DB_ENV_FILE`
3. `.env`
4. `shop/source/.env`
5. `source/.env`

Exported env vars override `.env` values.

## Lean BFH POC

Start it from the target repository:

```bash
pi
/bfh PC-120
# local/offline smoke start without Jira credentials:
/bfh POC-120 --no-jira
```

The command fetches the Jira ticket, writes a compact state record to:

```text
.pi/bfh/<TICKET>.state.json
```

State schema reference:

```text
bfh-state.schema.json
```

The active agent is then prompted to follow the deterministic phase contract:

```text
intake → scout → clarify? → implement → verify_review
       ↳ max 2 repair loops back to implement
       → close → retro → done
```

`bfh_state` is the state gate. It records patches/evidence and enforces legal `advance` transitions plus the two-cycle revision cap. Its `diff_context` action returns compact git diff/status snippets for verify/review without dumping whole files. Its `scout_auto` action runs a fresh read-only scout subagent and patches `state.scout`. Its `verify_review` action runs a fresh reviewer subagent, normalizes findings into `state.review`, records review evidence, and auto-transitions to `implement`, `close`, or `failed`. Its `close_check` action verifies readiness and returns a PR body without creating anything. Its `close_create` action enforces close gates, creates/reuses a draft PR via `gh`, records PR evidence, and can auto-advance `close -> retro`.

For quick validation that the extension wiring and transition guards work locally, run:

```bash
/bfh-selftest
```

## Dev notes

- `mysql2` is declared in `dependencies` and is installed automatically when installed as a Pi package.
- Pi core extension imports (`@mariozechner/pi-coding-agent`, `typebox`) are peer dependencies.

## Publish checklist

1. Create GitHub repo (`your-org/pi-team-tools`)
2. Copy this folder contents into that repo
3. Commit + push
4. Tag a release (for pinned installs), e.g. `v0.1.0`
5. Teammates install with:
   ```bash
   pi install git:git@github.com:your-org/pi-team-tools.git@v0.1.0
   ```
