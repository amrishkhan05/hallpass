import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { URL } from "node:url";

const cli = new URL("../dist/cli/index.js", import.meta.url).pathname;

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
  } finally { await rm(root, { recursive: true, force: true }); }
});
