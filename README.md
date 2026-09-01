# Hallpass 🎉

> **Because apparently AI agents need adult supervision.**

![Hallpass Mascot](https://raw.githubusercontent.com/amrishkhan05/hallpass/main/assets/hallpass_mascot.jpg)

Your new best friend for keeping AI‑generated code in check. Hallpass snoops around your repo, remembers where every rule came from, and makes sure the AI doesn’t go rogue. Think of it as the hall monitor who actually knows the rules.

> **Prompts tell the story. Policies keep it honest.**  
> **Your AI has a brain; Hallpass gives it a conscience.**

---

## 🚀 Install

```bash
npm install -g @amrishkhan05/hallpass
hallpass init
```

Or, if you hate installing globals (who doesn’t?), just run it on the fly:

```bash
npx @amrishkhan05/hallpass init
```

`hallpass init` scans for instruction files and drops a proposal into `.hallpass/compiled.json`. It never turns vague prose into a hard stop—review the scan first, then sprinkle your approved rules into `hallpass.config.yml`. The [example config](hallpass.config.example.yml) shows you what’s possible.

---

## ⚡ Quick start (no PhD required)

```bash
hallpass scan          # Gather every instruction we can find
hallpass rules         # Turn them into policies
hallpass check         # See if your changes pass the test
hallpass check --staged
hallpass ci --base origin/main   # CI‑friendly mode
hallpass explain ARCH-001       # Deep dive on a rule
hallpass context src/users/users.controller.ts   # Why did this rule fire?
hallpass doctor        # Give the engine a health check
hallpass conflicts     # Spot any rule clashes
```

Add `--json` to any command for machine‑readable output. Exit codes are our way of saying “All good” or “Uh‑oh”:
- `0` – pass
- `1` – violation
- `2` – config error
- `3` – engine failure
- `4` – approval needed
- `5` – unresolved conflict

---

## 🛡️ What v0.1 actually enforces

- **Path rules** – protect, forbid, or generate files.
- **Governance changes** – watch dependency adds/removes.
- **Deny‑lists & forbidden imports** – keep bad libs out.
- **Architecture boundaries** – simple but effective.
- **Explicit `any`, `@ts‑ignore`, `eslint‑disable`** – no sneaky escapes.
- **Test deletions & required commands** – keep your test suite alive.
- **Max changed files / LOC** – avoid massive accidental rewrites.
- **Shell‑command policies** – keep dangerous shells in check.

All checks are diff‑aware (working tree, staged, single commit, or base‑ref). Untracked, renamed, deleted, and binary files are normalized as events. Existing debt stays hidden unless the current diff touches it.

Our natural‑language scanner tags instructions as deterministic, structural, semantic, advisory, or ambiguous. Only explicit YAML rules are enforced; heuristics are just friendly suggestions in v0.1.

---

## 📚 Evidence & approvals (the paperwork you actually want to read)

Every finding comes with a nice package:
- Rule ID, classification, decision, and location.
- Evidence, remediation steps, and a stable fingerprint.
- A little persona blurb generated from that fingerprint (turn it off with `persona.intensity=0` or use `hallpass ci` for a corporate tone).

Record a human approval outside the policy file like this:

```bash
hallpass allow DEP-001 --reason "Approved Zod migration" --expires 2026-12-31
```

Approvals live under `.hallpass/` with reason, time, scope, and expiry. A repo edit can’t grant itself an approval—CI stays the ultimate gatekeeper.

> **Pro tip:** Keep the `hallpass allow` command out of the agent allow‑list. Local enforcement can’t stop a rogue process that already has full filesystem access.

---

## 🔎 Where Hallpass looks for instructions

It recursively hunts for:
- `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`
- `.cursor/rules/**/*.md` & `.cursor/rules/**/*.mdc`
- `.github/copilot-instructions.md`
- `.github/instructions/**/*.instructions.md`

We keep the source file, line, original text, compiler version, and a fingerprint for every proposal. If two rules clash, `hallpass conflicts` will point it out—Hallpass never picks a winner in secret.

---

## 🤖 Agent adapters (the nice people who talk to Hallpass)

The core is agent‑agnostic. `hallpass hook <adapter>` accepts native hook JSON on stdin, normalizes it, runs our policies, and spits out the adapter‑specific permission response.

**Claude’s pre‑tool hook:**
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

**Cursor’s project hook (`.cursor/hooks.json`):**
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

Claude and Cursor have native pre‑shell responses. Generic Git/CI provides the ultimate diff verification. Codex and Copilot metadata are there, but we don’t claim native lifecycle installation in v0.1.

---

## 🏗️ CI integration (because automation is cool)

```yaml
- run: npx @amrishkhan05/hallpass ci --base origin/main
```

Git hooks are optional shortcuts; protected‑branch CI is the real enforcer. Hallpass is a policy‑enforcer, not a sandbox for your OS.

---

## 🛠️ Development & release (how to ship this thing)

```bash
npm ci
npm run check
npm pack
```

When you push a GitHub Release named `v<package.json version>`, the workflow publishes the same version to **npm** *and* **GitHub Packages**. You’ll need npm Trusted Publishing set up for `amrishkhan05/hallpass` and the `publish.yml` workflow. `NPM_TOKEN` is just a fallback, not the default.

First release steps:
```bash
git tag v0.1.0
git push origin main
git push origin v0.1.0
# Then create a GitHub Release v0.1.0
```

If Trusted Publishing isn’t available, fall back to:
```bash
npm publish --access public --provenance
```
Make sure the `NODE_AUTH_TOKEN` secret is only used on the publish step and keep `id-token: write`.

---

## 📖 Further reading (because you love docs)

- See [SECURITY.md](SECURITY.md) for the trust model.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for how to help out.

> **The AI can forget your rules. Hallpass doesn’t.**


> **Because apparently AI agents need adult supervision.**

![Hallpass Mascot](https://raw.githubusercontent.com/amrishkhan05/hallpass/main/hallpass_mascot.jpg)

Your trusty **policy‑as‑code sidekick** for AI‑generated software changes. Hallpass discovers repository instructions, preserves their provenance, and evaluates deterministic constraints against real Git changes. Think of it as a vigilant hall monitor for your code‑base—ensuring AI agents stay in line.

> **Prompts express intent. Policies enforce invariants.**  
> **Your AI has instructions. Hallpass gives them teeth.**


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
## 📊 Project analysis & missing pieces

> **What’s cooking?** Hallpass already packs a punch, but there’s room for extra flavor:

- **Feature completeness**: Core policy enforcement is solid, but a **web UI dashboard** for visual rule inspection is not yet bundled.
- **Language support**: Currently tuned for JavaScript/TypeScript projects; extending to Python, Go, or Rust would broaden appeal.
- **Integration hooks**: We have adapters for Claude and Cursor; adding generic LLM hooks (e.g., GitHub Copilot, Bard) could simplify adoption.
- **Documentation**: The README now shines, but a **quick‑start video** or animated GIF would help newcomers get up‑to‑speed.
- **Testing suite**: Automated tests for rule parsing and engine behavior exist, yet **end‑to‑end CI examples** across multiple CI providers (GitHub Actions, GitLab CI) would be valuable.

These are **opportunities**, not deficiencies—Hallpass works great out‑of‑the‑box, and the community can help grow it.

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
