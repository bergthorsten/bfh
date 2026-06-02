# Team skills

Put shared Claude-style skills in this folder.

Each skill should be a directory containing `SKILL.md`:

```
.claude/skills/
  my-skill/
    SKILL.md
```

Pi loads this folder via `.pi/settings.json` (`"skills": ["../.claude/skills"]`).
