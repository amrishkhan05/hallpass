---
name: hallpass-help
description: >
  Quick-reference card for hallpass commands and hook installation.
  One-shot display, not a persistent mode. Trigger: /hallpass-help,
  "hallpass help", "what hallpass commands", "how do I use hallpass".
---

<!-- @format -->

# Hallpass Help

Display this reference card when invoked. One-shot, do NOT run any command
or change any file unless the user asks for that separately.

## Commands

| Command                                  | What it does                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `hallpass init`                          | Scan the repo and activate deterministic policy.                                |
| `hallpass scan`                          | Discover and classify instruction sources.                                      |
| `hallpass rules`                         | List approved policy rules.                                                     |
| `hallpass check [--staged]`              | Check changes against policy.                                                   |
| `hallpass guard <action>`                | Check a sensitive action before execution.                                      |
| `hallpass finish`                        | Run the authoritative completion gate.                                          |
| `hallpass watch`                         | Report meaningful policy state changes.                                         |
| `hallpass baseline create\|status\|update\|clear` | Manage accepted existing violations.                                 |
| `hallpass ci --base <ref>`               | CI-friendly completion gate.                                                    |
| `hallpass explain <ruleId>`              | Explain why a rule fired.                                                       |
| `hallpass context <path>`                | Show effective policy for a path.                                               |
| `hallpass conflicts`                     | Show contradictory instruction proposals.                                       |
| `hallpass doctor`                        | Diagnose repository policy health.                                              |
| `hallpass allow <ruleId> --reason "..."` | Record a human approval (never run by an agent).                                |
| `hallpass audit`                         | Show local policy audit events.                                                 |
| `hallpass install claude\|cursor\|all`   | Wire native pre-tool hooks into `.claude/settings.json` / `.cursor/hooks.json`. |

Add `--json` to any command for machine-readable output.

## Exit codes

`0` pass, `1` violation, `2` config error, `3` engine failure, `4` approval
required, `5` unresolved conflict.

## Skills & install

- **hallpass** — main skill, run `hallpass check`/`hallpass ci` before finishing a task.
- **hallpass-help** — this card.
- Claude Code: `/plugin marketplace add amrishkhan05/hallpass` then `/plugin install hallpass`.
- Cursor: `.cursor/rules/hallpass.mdc` is picked up automatically; run `hallpass install cursor` for the enforced pre-shell hook.
- Copilot / Codex / any agent: discover via `skills/hallpass/SKILL.md`, or keep `AGENTS.md` / `.github/copilot-instructions.md` in the repo.
