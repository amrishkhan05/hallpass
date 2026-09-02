/** @format */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { URL } from "node:url";

const cli = new URL("../dist/cli/index.js", import.meta.url).pathname;
const missing = (path) => access(path).then(() => false, (error) => error.code === "ENOENT");

test("built CLI exposes version and help", () => {
  assert.equal(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim(), "0.1.4");
  assert.match(execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }), /Runtime policy enforcement/);
});

test("init creates human-owned config and generated state", async () => {
  const root = await mkdtemp(join(tmpdir(), "hallpass-cli-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const result = spawnSync(process.execPath, [cli, "init", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).config, "hallpass.config.yml");
    assert.match(await readFile(join(root, ".gitignore"), "utf8"), /\.hallpass\//);
    assert.equal(JSON.parse(await readFile(join(root, ".hallpass", "compiled.json"), "utf8")).compilerVersion, "0.1.4");
    assert.equal(await missing(join(root, "AGENTS.md")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan reports configured, inferred, and unconfigured repositories without requiring AGENTS.md", async () => {
  for (const expected of ["CONFIGURED", "INFERRED", "UNCONFIGURED"]) {
    const root = await mkdtemp(join(tmpdir(), "hallpass-cli-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      if (expected === "CONFIGURED") await writeFile(join(root, "hallpass.config.yml"), "version: 1\n");
      if (expected === "INFERRED") await writeFile(join(root, "CLAUDE.md"), "Run npm test before completing a task.\n");
      const scan = spawnSync(process.execPath, [cli, "scan", "--json"], { cwd: root, encoding: "utf8" });
      assert.equal(scan.status, 0, scan.stderr);
      const result = JSON.parse(scan.stdout);
      assert.equal(result.policyState, expected);
      assert.equal(result.agentsFileExists, false);
      if (expected === "INFERRED") assert.equal(result.instructions[0].source.file, "CLAUDE.md");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("check and context succeed with built-in safety in an unconfigured repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "hallpass-cli-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Hallpass Test"], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "baseline"], { cwd: root });
    const checked = spawnSync(process.execPath, [cli, "check", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).status, "pass");
    const context = JSON.parse(execFileSync(process.execPath, [cli, "context", "--json"], { cwd: root, encoding: "utf8" }));
    assert.equal(context.policyState, "UNCONFIGURED");
    assert.equal(context.projectSpecificEnforcement.length, 0);
    assert.equal(context.builtInSafety.active, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("init creates AGENTS.md only when explicitly requested and respects overwrite safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "hallpass-cli-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "package.json"), '{"scripts":{"check":"npm test"}}\n');
    const created = spawnSync(process.execPath, [cli, "init", "--create-agents", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).agents.created, true);
    assert.match(await readFile(join(root, "AGENTS.md"), "utf8"), /npm run check/);
    await writeFile(join(root, "AGENTS.md"), "keep me\n");
    const existing = spawnSync(process.execPath, [cli, "init", "--create-agents", "--force", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(existing.status, 0, existing.stderr);
    assert.equal(JSON.parse(existing.stdout).agents.overwritten, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agents suggest is read-only and agents init never overwrites silently", async () => {
  const root = await mkdtemp(join(tmpdir(), "hallpass-cli-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "package.json"), '{"scripts":{"check":"npm run typecheck && npm test"}}\n');
    const suggested = JSON.parse(execFileSync(process.execPath, [cli, "agents", "suggest", "--json"], { cwd: root, encoding: "utf8" }));
    assert.equal(await missing(join(root, "AGENTS.md")), true);
    assert.deepEqual(suggested.suggestions[0], { text: "Run `npm run check` before completing a task.", origin: "repository-derived", evidence: { file: "package.json", path: "scripts.check" }, confidence: "deterministic" });
    const initialized = JSON.parse(execFileSync(process.execPath, [cli, "agents", "init", "--json"], { cwd: root, encoding: "utf8" }));
    assert.equal(initialized.created, true);
    await writeFile(join(root, "AGENTS.md"), "keep me\n");
    const unchanged = JSON.parse(execFileSync(process.execPath, [cli, "agents", "init", "--json"], { cwd: root, encoding: "utf8" }));
    assert.equal(unchanged.created, false);
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "keep me\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("install wires claude and cursor pre-tool hooks and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "hallpass-cli-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const first = spawnSync(process.execPath, [cli, "install", "all", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const firstStatus = JSON.parse(first.stdout);
    assert.equal(firstStatus.claude.status, "created");
    assert.equal(firstStatus.cursor.status, "created");

    const claudeSettings = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8"));
    assert.equal(claudeSettings.hooks.PreToolUse[0].hooks[0].command, "hallpass hook claude");
    const cursorHooks = JSON.parse(await readFile(join(root, ".cursor", "hooks.json"), "utf8"));
    assert.equal(cursorHooks.hooks.beforeShellExecution[0].command, "hallpass hook cursor");

    const second = spawnSync(process.execPath, [cli, "install", "all", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(JSON.parse(second.stdout).claude.status, "already-installed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MVP blocks a dependency forbidden by AGENTS.md with provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "hallpass-cli-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Hallpass Test"], { cwd: root });
    await writeFile(join(root, "AGENTS.md"), "Never add dependencies.\n");
    await writeFile(join(root, "package.json"), '{"dependencies":{}}\n');
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
    assert.equal(spawnSync(process.execPath, [cli, "init", "--json"], { cwd: root, encoding: "utf8" }).status, 0);
    const guarded = spawnSync(process.execPath, [cli, "guard", "dependency", "--add", "axios", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(guarded.status, 1, guarded.stderr);
    assert.equal(JSON.parse(guarded.stdout).violations[0].ruleId, "DEP-001");
    await writeFile(join(root, "hallpass.tests.yml"), 'tests:\n  - name: dependency rule\n    given:\n      file: package.json\n      before: |\n        {"dependencies":{}}\n      content: |\n        {"dependencies":{"axios":"1.0.0"}}\n    expect:\n      rule: DEP-001\n      decision: deny\n');
    const policyTests = spawnSync(process.execPath, [cli, "test", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(policyTests.status, 0, policyTests.stderr);
    assert.equal(JSON.parse(policyTests.stdout).tests[0].status, "pass");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "hallpass"], { cwd: root });
    await writeFile(join(root, "package.json"), '{"dependencies":{"axios":"1.0.0"}}\n');

    const checked = spawnSync(process.execPath, [cli, "check", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(checked.status, 1, checked.stderr);
    const report = JSON.parse(checked.stdout);
    const violation = report.violations.find((item) => item.ruleId === "DEP-001");
    assert.equal(report.schemaVersion, 1);
    assert.equal(violation.decision, "block");
    assert.deepEqual(violation.evidence, { package: "axios", action: "add" });
    assert.deepEqual(violation.source, { file: "AGENTS.md", line: 1, instruction: "Never add dependencies." });

    const finished = spawnSync(process.execPath, [cli, "finish", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(finished.status, 1, finished.stderr);
    assert.ok(JSON.parse(finished.stdout).violations.some((item) => item.ruleId === "DEP-001"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
