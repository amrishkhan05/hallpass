# Hallpass

### Because apparently AI agents need adult supervision.

Your coding agent read `AGENTS.md`. It also read `CLAUDE.md`, your Cursor rules, and your Copilot instructions. Then it ignored one of them. **Hallpass noticed.**

Hallpass is local-first policy-as-code for AI-generated software changes. It discovers repository instructions, preserves their provenance, and evaluates approved deterministic constraints against real Git changes.

> **Prompts express intent. Policies enforce invariants.**

> **Your AI has instructions. Hallpass gives them teeth.**

## Install

```bash
npm install -g @amrishkhan05/hallpass
hallpass init
```

Or run it without installing:

```bash
npx @amrishkhan05/hallpass init
```

`init` discovers instruction sources and writes proposals to `.hallpass/compiled.json`. It does not silently turn ambiguous prose into blocking policy. Review the scan, then add approved rules to `hallpass.config.yml`; [the example config](hallpass.config.example.yml) documents the supported shape.

## Quick start

```bash
hallpass scan
hallpass rules
hallpass check
hallpass check --staged
hallpass ci --base origin/main
hallpass explain ARCH-001
hallpass context src/users/users.controller.ts
hallpass doctor
hallpass conflicts
```

Machine-readable output is available with `--json` on the primary commands. Stable exit codes are `0` pass, `1` violation, `2` configuration error, `3` engine failure, `4` approval required, and `5` unresolved conflict.

## What v0.1 enforces

The engine supports protected/forbidden/generated paths, governance changes, dependency additions/removals and deny lists, forbidden imports and simple architecture boundaries, explicit TypeScript `any`, `@ts-ignore`, `eslint-disable`, test deletion, required commands, maximum changed files/LOC, and shell command policies.

Checks are diff-aware and understand working-tree, staged, single-commit, and base-ref comparisons. Untracked, renamed, deleted, and binary files are normalized as events. Existing repository debt is not reported unless the current diff touches it.

Natural-language scanning classifies instructions as deterministic, structural, semantic, advisory, or ambiguous. Only explicit YAML rules enforce outcomes. Heuristic and semantic interpretation is deliberately not a blocking dependency in v0.1.

## Evidence and approvals

Every finding includes a rule ID, classification, decision, location, evidence, remediation, and stable fingerprint. Persona text is selected deterministically from that fingerprint and never changes the policy result. Set `persona.intensity` to `0`, disable it entirely, or use `hallpass ci` for professional output.

Record a human approval outside the policy file:

```bash
hallpass allow DEP-001 --reason "Approved Zod migration" --expires 2026-12-31
```

Approvals are stored locally under `.hallpass/` with reason, time, scope, and expiry. A repository edit cannot grant itself an approval. CI should remain the authoritative final gate.

Agent shell hooks always deny `hallpass allow` and direct writes to the approval store. Keep the approval command outside agent allowlists; local enforcement cannot protect against a process that already has unrestricted access to the user's filesystem.

## Instruction sources

Hallpass recursively discovers `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `.cursor/rules/**/*.md`, `.cursor/rules/**/*.mdc`, `.github/copilot-instructions.md`, and `.github/instructions/**/*.instructions.md`. Source file, line, original text, compiler version, and fingerprints are retained in compiled proposals.

Possible contradictions are surfaced by `hallpass conflicts`; Hallpass never silently chooses a winner.

## Agent adapters

The core is agent-independent. `hallpass hook <adapter>` accepts native hook JSON on stdin, normalizes it into a Hallpass event, evaluates shell policies, and emits the adapter's native permission response.

Claude Code `PreToolUse` command hook:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "hallpass hook claude" }]
    }]
  }
}
```

Cursor project hook in `.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [{
      "command": "hallpass hook cursor",
      "failClosed": true
    }]
  }
}
```

Claude and Cursor have native pre-shell responses. Generic Git/CI provides authoritative diff verification. Codex and Copilot capability metadata and event normalization are present, but native lifecycle installation is not claimed in v0.1.

## CI

```yaml
- run: npx @amrishkhan05/hallpass ci --base origin/main
```

Git hooks are optional convenience gates and can be bypassed; protected branch CI is the reliable final boundary. Hallpass is policy enforcement, not an operating-system sandbox.

## Development and release

```bash
npm ci
npm run check
npm pack
```

The release workflow publishes the same package version to npm and GitHub Packages when a GitHub Release named `v<package.json version>` is published. npm Trusted Publishing must first be configured on npmjs.com for repository `amrishkhan05/hallpass` and workflow `publish.yml`. `NPM_TOKEN` is a documented fallback, not the default.

First release:

```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0
# Publish GitHub Release v0.1.0
```

If Trusted Publishing is unavailable, set `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` only on the npm publish step and run `npm publish --access public --provenance`; retain `id-token: write`. Do not configure one permanent registry in `package.json`, because the workflow publishes separately to npm and GitHub Packages.

See [SECURITY.md](SECURITY.md) for the trust model and [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance.

> **The AI can forget your rules. Hallpass doesn't.**
