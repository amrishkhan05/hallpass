---
name: hallpass
description: >
  Runtime policy enforcement for AI coding agents. Compiles the rules already
  written in AGENTS.md, CLAUDE.md, .cursor/rules, and
  .github/copilot-instructions.md into an enforceable policy, then checks the
  current diff against it. Use whenever you are about to finish a coding task
  in a repository that has a hallpass.config.yml, whenever the user asks to
  "check policy", "run hallpass", "audit this change", or before opening a
  pull request. Also use to explain why a change was blocked or to look up
  which rules apply to a path.
license: MIT
---

<!-- @format -->

# Hallpass

Hallpass is a CLI (`hallpass`, or `npx @amrishkhan05/hallpass`) that turns a
repository's existing instruction files into enforceable policy and checks
diffs and sensitive actions against it. Deterministic compiled rules may block;
semantic and ambiguous guidance may not.

## When to run it

- At task start: run `hallpass context --json`; do not edit with unresolved conflicts.
- Before a sensitive action: run the matching `hallpass guard ... --json` command.
- After a coherent change: run `hallpass check --json`.
- Before reporting success: run `hallpass finish --json`; success requires PASS.
- Before opening a PR / in CI: `hallpass ci --base origin/main`.
- To see why something failed: `hallpass explain <ruleId>`.
- To see which rules apply to a path: `hallpass context <path>`.
- To see all discovered instructions: `hallpass scan`.
- To see approved policy rules: `hallpass rules`.

## Exit codes

`0` pass, `1` violation, `2` config error, `3` engine failure, `4` approval
required, `5` unresolved conflict.

## Handling a failure

Fix the reported violation. If it's a legitimate exception, ask a human to run
`hallpass allow <ruleId> --reason "..."` — an agent must never edit
`.hallpass/`, `hallpass.config.yml`, or grant its own approval to make a
finding disappear.

## Installing native pre-tool hooks

For agents with a pre-tool permission hook (Claude Code, Cursor), wire it once
with `hallpass install claude`, `hallpass install cursor`, or
`hallpass install all`. This merges the hook config into
`.claude/settings.json` / `.cursor/hooks.json` without touching other
settings, and is safe to run repeatedly.
