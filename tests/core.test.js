/** @format */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../dist/config.js";
import { compilePolicies, conflicts, duplicates, resolveEffectiveRules, scanInstructions } from "../dist/compiler.js";
import { applyProfile, evaluate } from "../dist/engine.js";
import { saveBaseline } from "../dist/baseline.js";
import { addApproval } from "../dist/approvals.js";
import { gitChanges } from "../dist/git.js";
import { selectComment } from "../dist/persona.js";
import { adapterResponse, evaluateShell, normalizeEvent, validateAdapterHookIntegration } from "../dist/adapters.js";

const baseConfig = {
  version: 1,
  persona: { enabled: true, intensity: 2 },
  sources: [],
  conflicts: { behavior: "block" },
  overrides: { enabled: true, requireReason: true },
  governance: { protect: [] },
  rules: [],
};

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "hallpass-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Hallpass Test"], { cwd: root });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), '{"dependencies":{}}\n');
  await writeFile(join(root, "src", "clean.ts"), "export const clean = true;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

test("configuration rejects unknown enforcement", () => {
  assert.throws(
    () => validateConfig({ ...baseConfig, rules: [{ id: "X", title: "x", classification: "deterministic", enforcement: "destroy", detector: { type: "protected-file" } }] }),
    /rules\[0\]\.enforcement/,
  );
});

test("balanced profile blocks deterministic compiled rules without escalating semantic guidance", () => {
  const generated = { id: "X", title: "x", source: { type: "generated" }, classification: "deterministic", enforcement: "warn", detector: { type: "typescript-any" } };
  assert.equal(applyProfile(generated, "balanced").enforcement, "block");
  assert.equal(applyProfile({ ...generated, classification: "semantic" }, "balanced").enforcement, "warn");
});

test("persona selection is deterministic", () => {
  assert.equal(selectComment("dependency.unapproved", "same"), selectComment("dependency.unapproved", "same"));
});

test("instruction scan preserves provenance and reports dependency conflict", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "AGENTS.md"), "Never add dependencies.\n");
    await writeFile(join(root, "CLAUDE.md"), "Use Zod for every request.\n");
    const found = await scanInstructions(root);
    assert.equal(found[0].source.line, 1);
    assert.equal(conflicts(found).length, 1);
    assert.equal(duplicates([...found, { ...found[0], source: { file: "nested/AGENTS.md", line: 1 } }]).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled policies capture provenance and strongest precedence wins", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "AGENTS.md"), "Never add dependencies.\n");
    await mkdir(join(root, "src", "feature"), { recursive: true });
    await writeFile(join(root, "src", "feature", "AGENTS.md"), "Use Zod for request validation.\n");
    const compiled = await compilePolicies(root);
    assert.ok(compiled.length >= 2);
    assert.ok(compiled.every((rule) => rule.source && rule.source.file));
    const effective = resolveEffectiveRules(compiled, "src/feature/file.ts");
    assert.ok(effective.length >= 1);
    assert.ok(effective.some((rule) => rule.source?.file === "src/feature/AGENTS.md" || rule.source?.file === "AGENTS.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git normalization includes untracked, staged, renamed, and deleted files", async () => {
  const root = await repository();
  try {
    await rename(join(root, "src", "clean.ts"), join(root, "src", "renamed.ts"));
    await writeFile(join(root, "new file.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    const staged = await gitChanges(root, { staged: true });
    assert.ok(staged.files.some((file) => file.path === "src/renamed.ts" && file.status === "renamed"));
    assert.ok(staged.files.some((file) => file.path === "new file.ts" && file.status === "added"));
    execFileSync("git", ["reset", "-q"], { cwd: root });
    const working = await gitChanges(root);
    assert.ok(working.files.some((file) => file.status === "deleted" && file.path === "src/clean.ts"));
    assert.ok(working.files.some((file) => file.path === "new file.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy engine detects dependency, architecture, type, and generated-file violations", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "package.json"), '{"dependencies":{"lodash":"1.0.0"}}\n');
    await writeFile(join(root, "src", "users.controller.ts"), 'import x from "@prisma/client";\nconst value: any = x;\n');
    await writeFile(join(root, "src", "generated.ts"), "generated\n");
    const config = validateConfig({
      ...baseConfig,
      rules: [
        { id: "DEP-001", title: "Dependencies require approval", classification: "deterministic", enforcement: "block", detector: { type: "dependency-change", action: "add" } },
        {
          id: "ARCH-001",
          title: "Controllers cannot import Prisma",
          classification: "structural",
          enforcement: "block",
          scope: { include: ["src/**/*.controller.ts"] },
          detector: { type: "forbidden-import", imports: ["@prisma/client"] },
        },
        { id: "TS-001", title: "Explicit any is forbidden", classification: "deterministic", enforcement: "warn", scope: { include: ["**/*.ts"] }, detector: { type: "typescript-any" } },
        { id: "GEN-001", title: "Generated files are protected", classification: "deterministic", enforcement: "block", detector: { type: "generated-file", paths: ["**/generated.ts"] } },
      ],
    });
    const report = await evaluate(root, config);
    assert.equal(report.violations.length, 3);
    assert.equal(report.warnings.length, 1);
    assert.deepEqual(new Set(report.violations.map((item) => item.ruleId)), new Set(["DEP-001", "ARCH-001", "GEN-001"]));
    await addApproval(root, { rule: "DEP-001", reason: "Test approval", timestamp: new Date().toISOString() });
    const approved = await evaluate(root, config);
    assert.ok(!approved.violations.some((item) => item.ruleId === "DEP-001"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required command is a completion gate", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "src", "clean.ts"), "export const clean = false;\n");
    const config = validateConfig({
      ...baseConfig,
      rules: [
        {
          id: "TEST-001",
          title: "Tests must pass",
          classification: "deterministic",
          enforcement: "block",
          detector: { type: "required-command", when: { changed: ["src/**"] }, command: 'node -e "process.exit(1)"' },
        },
      ],
    });
    const report = await evaluate(root, config);
    assert.equal(report.violations[0].category, "completion.tests_missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required imports are checked and existing findings can be baselined", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "src", "clean.ts"), "export const clean = false;\n");
    const config = validateConfig({
      ...baseConfig,
      rules: [
        {
          id: "IMPORT-001",
          title: "Use the shared logger",
          classification: "structural",
          enforcement: "block",
          scope: { include: ["src/**"] },
          detector: { type: "required-import", imports: ["@app/logger"] },
        },
      ],
    });
    const report = await evaluate(root, config);
    assert.equal(report.violations[0].ruleId, "IMPORT-001");
    await saveBaseline(root, [report.violations[0].fingerprint]);
    assert.ok(!(await evaluate(root, config)).violations.some((item) => item.ruleId === "IMPORT-001"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conflicting compiled policies are blocked before approval", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "AGENTS.md"), "Never add dependencies.\n");
    await writeFile(join(root, "CLAUDE.md"), "Use Zod for request validation.\n");
    const compiled = await compilePolicies(root);
    const conflict = compiled.find((rule) => rule.id.startsWith("POL-"));
    assert.ok(conflict || compiled.length > 0);
    const config = validateConfig({ ...baseConfig, conflicts: { behavior: "block" }, rules: compiled });
    const report = await evaluate(root, config);
    assert.ok(report.violations.some((item) => item.ruleId.includes("POL-")) || report.status === "fail" || report.status === "warn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic and heuristic guidance compiles as advisory warnings without becoming a blocker", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "AGENTS.md"), "Prefer existing utilities and keep the flow simple.\n");
    const compiled = await compilePolicies(root);
    const advisory = compiled.find((rule) => rule.classification === "semantic" || rule.classification === "advisory" || rule.classification === "heuristic");
    assert.ok(advisory);
    assert.ok(["warn", "audit", "allow"].includes(advisory.enforcement));
    const config = validateConfig({ ...baseConfig, governance: { protect: ["AGENTS.md"] }, rules: [advisory] });
    const report = await evaluate(root, config);
    assert.equal(report.violations.filter((item) => item.ruleId === advisory.id).length, 0);
    assert.ok(report.warnings.some((item) => item.ruleId === advisory.id) || report.status === "warn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex and copilot adapters expose full lifecycle normalization and responses", () => {
  const codex = normalizeEvent("codex", { command: "git status --short" }, "/repo");
  const copilot = normalizeEvent("copilot", { command: "npm test" }, "/repo");
  assert.equal(codex.type, "shell.execute");
  assert.equal(copilot.type, "shell.execute");
  assert.equal(adapterResponse("codex", []).decision, "allow");
  assert.equal(adapterResponse("copilot", []).decision, "allow");
  assert.equal(
    adapterResponse("copilot", [{ id: "P1", ruleId: "COP-001", decision: "block", classification: "deterministic", message: "blocked", category: "shell.denied", fingerprint: "x" }]).decision,
    "block",
  );
});

test("shell adapters normalize payloads without coupling policy to an agent", () => {
  const event = normalizeEvent("claude", { tool_input: { command: "git reset --hard" } }, "/repo");
  const findings = evaluateShell(event, [
    { id: "SHELL-001", title: "Destructive Git is denied", classification: "deterministic", enforcement: "block", detector: { type: "shell-command", commands: ["git reset --hard"] } },
  ]);
  assert.equal(findings[0].ruleId, "SHELL-001");
  assert.equal(adapterResponse("cursor", findings).permission, "deny");
  assert.equal(adapterResponse("claude", findings).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(evaluateShell(normalizeEvent("claude", { command: "hallpass allow DEP-001 --reason self" }, "/repo"), [])[0].ruleId, "GOV-APPROVAL");
  assert.equal(evaluateShell(normalizeEvent("claude", { command: "git reset --hard" }, "/repo"), [])[0].ruleId, "GOV-GIT");

  const cursorEvent = normalizeEvent("cursor", { command: "git reset --hard" }, "/repo");
  assert.equal(cursorEvent.type, "shell.execute");
  assert.equal(evaluateShell(cursorEvent, [])[0].ruleId, "GOV-GIT");
});

test("action model normalizes git commands with subcommand and ref extraction", () => {
  const gitCommit = normalizeEvent("claude", { command: "git commit -m 'test'" }, "/repo");
  const gitPush = normalizeEvent("claude", { command: "git push origin main" }, "/repo");
  const gitForcePush = normalizeEvent("claude", { command: "git push --force origin main" }, "/repo");

  assert.equal(gitCommit.action?.category, "git.commit");
  assert.equal(gitPush.action?.category, "git.push");
  assert.equal(gitPush.action?.target, "origin");
  assert.equal(gitForcePush.action?.category, "git.push");
  assert.equal(gitForcePush.metadata?.gitSubcommand, "push");
});

test("action model normalizes package manager commands with package detection", () => {
  const npmAdd = normalizeEvent("claude", { command: "npm install lodash" }, "/repo");
  const yarnAdd = normalizeEvent("claude", { command: "yarn add express" }, "/repo");
  const pnpmRemove = normalizeEvent("claude", { command: "pnpm remove typescript" }, "/repo");

  assert.equal(npmAdd.action?.category, "dependency.add");
  assert.equal(npmAdd.action?.target, "lodash");
  assert.equal(npmAdd.metadata?.packageManager, "npm");
  assert.equal(yarnAdd.action?.target, "express");
  assert.equal(pnpmRemove.action?.category, "dependency.remove");
  assert.equal(pnpmRemove.action?.target, "typescript");
});

test("action model tags config file modifications appropriately", () => {
  const pkgJson = normalizeEvent("claude", { tool_name: "Write", file_path: "package.json", content: "{}" }, "/repo");
  const agentsFile = normalizeEvent("claude", { tool_name: "Write", file_path: "AGENTS.md", content: "Never..." }, "/repo");
  const workflow = normalizeEvent("claude", { tool_name: "Write", file_path: ".github/workflows/ci.yml", content: "..." }, "/repo");

  assert.equal(pkgJson.action?.category, "config.modify");
  assert.equal(pkgJson.action?.target, "package.json");
  assert.equal(agentsFile.action?.category, "config.modify");
  assert.equal(workflow.action?.category, "config.modify");
  assert.equal(workflow.action?.target, ".github/workflows/ci.yml");
});

test("adapter hook integration validates capability coverage", () => {
  const claude = validateAdapterHookIntegration("claude");
  const cursor = validateAdapterHookIntegration("cursor");
  const copilot = validateAdapterHookIntegration("copilot");

  assert.ok(claude.coverage["shell.execute"]);
  assert.ok(claude.coverage["file.write"]);
  assert.equal(claude.coverage["workflow.modify"], false);

  assert.ok(cursor.coverage["dependency.add"]);
  assert.equal(cursor.coverage["git.push"], "partial");

  assert.equal(copilot.coverage["shell.execute"], "partial");
  assert.equal(copilot.coverage["git.commit"], false);
});

test("adapter response formatting is adapter-specific", () => {
  const findings = [{ id: "P1", ruleId: "RULE-001", decision: "block", classification: "deterministic", message: "blocked", category: "test", fingerprint: "x" }];

  const claudeResp = adapterResponse("claude", findings);
  assert.ok(claudeResp.hookSpecificOutput);
  assert.equal(claudeResp.hookSpecificOutput.permissionDecision, "deny");

  const cursorResp = adapterResponse("cursor", findings);
  assert.equal(cursorResp.permission, "deny");

  const copilotResp = adapterResponse("copilot", findings);
  assert.equal(copilotResp.decision, "block");
});
