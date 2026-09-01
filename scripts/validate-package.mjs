/** @format */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { URL } from "node:url";

const project = new URL("..", import.meta.url).pathname;
const temporary = await mkdtemp(join(tmpdir(), "hallpass-package-"));
const installRoot = join(temporary, "install");
const repository = join(temporary, "repository");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const expectedVersion = packageJson.version;
const run = (command, args, cwd = project) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

try {
  const archiveName = run("npm", ["pack", "--silent", "--pack-destination", temporary]).trim();
  const archive = join(temporary, basename(archiveName));
  run("npm", ["install", "--global", "--prefix", installRoot, archive]);
  const hallpass = process.platform === "win32" ? join(installRoot, "hallpass.cmd") : join(installRoot, "bin", "hallpass");
  assert.equal(run(hallpass, ["--version"]).trim(), expectedVersion);
  assert.match(run(hallpass, ["--help"]), /Runtime policy enforcement/);

  await mkdir(join(repository, "src"), { recursive: true });
  run("git", ["init", "-q"], repository);
  run("git", ["config", "user.email", "test@example.com"], repository);
  run("git", ["config", "user.name", "Hallpass Validation"], repository);
  await writeFile(join(repository, "AGENTS.md"), "Never add dependencies.\n");
  await writeFile(join(repository, "CLAUDE.md"), "Use Zod for every request.\n");
  await writeFile(join(repository, "package.json"), '{"dependencies":{}}\n');
  await writeFile(join(repository, "src", "clean.ts"), "export const clean = true;\n");
  await writeFile(
    join(repository, "hallpass.config.yml"),
    `version: 1
persona: { enabled: true, intensity: 2 }
governance: { protect: [hallpass.config.yml, AGENTS.md, CLAUDE.md] }
rules:
  - { id: DEP-001, title: Dependencies require approval, classification: deterministic, enforcement: block, detector: { type: dependency-change, action: add } }
  - { id: ARCH-001, title: Controllers cannot import Prisma, classification: structural, enforcement: block, scope: { include: ["src/**/*.controller.ts"] }, detector: { type: forbidden-import, imports: ["@prisma/client"] } }
  - { id: TYPE-001, title: Explicit any is forbidden, classification: deterministic, enforcement: block, scope: { include: ["**/*.ts"] }, detector: { type: typescript-any } }
  - { id: SHELL-001, title: Destructive Git is denied, classification: deterministic, enforcement: block, detector: { type: shell-command, commands: [git reset --hard] } }
`,
  );
  run("git", ["add", "."], repository);
  run("git", ["commit", "-qm", "baseline"], repository);

  const passing = JSON.parse(run(hallpass, ["check", "--json"], repository));
  assert.equal(passing.status, "pass");
  const claudeHook = JSON.parse(run(hallpass, ["hook", "claude", "--payload", '{"tool_input":{"command":"git reset --hard"}}'], repository));
  assert.equal(claudeHook.hookSpecificOutput.permissionDecision, "deny");
  const cursorHook = JSON.parse(run(hallpass, ["hook", "cursor", "--payload", '{"command":"git reset --hard"}'], repository));
  assert.equal(cursorHook.permission, "deny");
  let conflictStatus = 0;
  try {
    run(hallpass, ["conflicts", "--json"], repository);
  } catch (error) {
    conflictStatus = error.status;
  }
  assert.equal(conflictStatus, 5);

  await writeFile(join(repository, "package.json"), '{"dependencies":{"lodash":"1.0.0"}}\n');
  await writeFile(join(repository, "AGENTS.md"), "Never add dependencies. This policy was edited.\n");
  await writeFile(join(repository, "src", "users.controller.ts"), 'import prisma from "@prisma/client";\nconst result: any = prisma;\n');
  let json = "";
  try {
    run(hallpass, ["check", "--json"], repository);
  } catch (error) {
    json = error.stdout;
  }
  const failing = JSON.parse(json);
  assert.equal(failing.status, "fail");
  assert.deepEqual(new Set(failing.violations.map((item) => item.ruleId)), new Set(["GOV-001", "DEP-001", "ARCH-001", "TYPE-001"]));
  let human = "";
  try {
    run(hallpass, ["check"], repository);
  } catch (error) {
    human = error.stdout;
  }
  assert.match(human, /PRINCIPAL'S OFFICE/);
  assert.equal((await readFile(hallpass)).subarray(0, 20).toString(), "#!/usr/bin/env node\n");
  console.log("Packed install, CLI, pass/fail, evidence, conflict, JSON, persona, and shebang checks passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
