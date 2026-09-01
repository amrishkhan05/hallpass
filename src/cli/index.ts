#!/usr/bin/env node
import { Command } from "commander";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { addApproval } from "../approvals.js";
import { adapterResponse, capabilities, evaluateShell, normalizeEvent } from "../adapters.js";
import { readAudit, recordAudit } from "../audit.js";
import { ConfigurationError, loadConfig, validateConfig } from "../config.js";
import { conflicts as findConflicts, duplicates as findDuplicates, scanInstructions, sourcesFingerprint } from "../compiler.js";
import { EXIT, VERSION, type HallpassConfig, type ShellActionEvent } from "../core/types.js";
import { evaluate } from "../engine.js";
import { repositoryRoot, type DiffOptions } from "../git.js";
import { renderReport } from "../persona.js";
import { matchesAny } from "../utils.js";

const program = new Command();
program.name("hallpass").description("Runtime policy enforcement for AI coding agents.").version(VERSION);
const print = (value: unknown, json = false): void => console.log(json ? JSON.stringify(value, null, 2) : String(value));
const countBy = <T extends string>(values: T[]): Record<T, number> => values.reduce((result, value) => ({ ...result, [value]: (result[value] ?? 0) + 1 }), {} as Record<T, number>);
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

async function root(): Promise<string> { return repositoryRoot(process.cwd()); }
async function compile(rootPath: string): Promise<{ instructions: Awaited<ReturnType<typeof scanInstructions>>; conflicts: ReturnType<typeof findConflicts>; duplicates: ReturnType<typeof findDuplicates>; fingerprint: string }> {
  const instructions = await scanInstructions(rootPath);
  return { instructions, conflicts: findConflicts(instructions), duplicates: findDuplicates(instructions), fingerprint: sourcesFingerprint(instructions) };
}
async function saveCompiled(rootPath: string): Promise<Awaited<ReturnType<typeof compile>>> {
  const result = await compile(rootPath);
  await mkdir(join(rootPath, ".hallpass"), { recursive: true });
  await writeFile(join(rootPath, ".hallpass", "compiled.json"), `${JSON.stringify({ compilerVersion: VERSION, timestamp: new Date().toISOString(), sourceFingerprint: result.fingerprint, instructions: result.instructions, conflicts: result.conflicts, duplicates: result.duplicates }, null, 2)}\n`);
  return result;
}

const initialConfig: HallpassConfig = {
  version: 1,
  persona: { enabled: true, intensity: 2 },
  sources: ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", ".cursor/rules", ".github/copilot-instructions.md", ".github/instructions"],
  conflicts: { behavior: "block" },
  overrides: { enabled: true, requireReason: true },
  governance: { protect: ["hallpass.config.yml", ".hallpass.yml", ".hallpass/**", "AGENTS.md", "CLAUDE.md", ".claude/hooks/**", ".claude/settings.json", ".cursor/hooks.json", ".github/workflows/**"] },
  rules: [],
};

program.command("init").description("Initialize Hallpass in this Git repository").option("--force", "replace existing configuration").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root();
  const configPath = join(rootPath, "hallpass.config.yml");
  if (!options.force) {
    try { await stat(configPath); throw new ConfigurationError("hallpass.config.yml already exists. Use --force to replace it."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await writeFile(configPath, stringify(initialConfig));
  await mkdir(join(rootPath, ".hallpass"), { recursive: true });
  const gitignore = join(rootPath, ".gitignore");
  const ignored = await readFile(gitignore, "utf8").catch(() => "");
  if (!ignored.split("\n").includes(".hallpass/")) await appendFile(gitignore, `${ignored && !ignored.endsWith("\n") ? "\n" : ""}.hallpass/\n`);
  const result = await saveCompiled(rootPath);
  const summary = { repository: rootPath, sources: [...new Set(result.instructions.map((item) => item.source.file))], instructions: result.instructions.length, classifications: countBy(result.instructions.map((item) => item.classification)), duplicates: result.duplicates.length, conflicts: result.conflicts.length, config: "hallpass.config.yml" };
  print(options.json ? summary : `HALLPASS INIT\n\nRepository detected.\n${summary.sources.length} instruction sources, ${summary.instructions} instructions, ${summary.duplicates} duplicates, ${summary.conflicts} conflicts.\n\nReview hallpass.config.yml and add approved blocking rules.`, options.json);
});

program.command("scan").description("Discover and classify repository instructions").option("--json", "emit JSON").action(async (options) => {
  const result = await compile(await root());
  print(options.json ? result : `HALLPASS SCAN\n\n${result.instructions.map((item) => `${item.classification.padEnd(13)} ${item.source.file}:${item.source.line}  ${item.text}`).join("\n") || "No instructions found."}\n\n${result.duplicates.length} duplicates; ${result.conflicts.length} possible conflicts.`, options.json);
});

program.command("sync").description("Refresh compiled instruction proposals").option("--json", "emit JSON").action(async (options) => {
  const result = await saveCompiled(await root());
  print(options.json ? result : `POLICY SYNCED\n\n${result.instructions.length} instructions; ${result.duplicates.length} duplicates; ${result.conflicts.length} conflicts. Blocking policies were not changed.`, options.json);
});

program.command("rules").description("List approved policy rules").option("--json", "emit JSON").option("--active", "only active rules").option("--source <file>", "filter by source").action(async (options) => {
  const { config } = await loadConfig(await root());
  const rules = config.rules.filter((rule) => (!options.active || rule.enforcement !== "allow") && (!options.source || rule.source?.file === options.source));
  print(options.json ? rules : `HALLPASS RULEBOOK\n\n${rules.map((rule) => `${rule.id.padEnd(12)} ${rule.enforcement.padEnd(16)} ${rule.title}`).join("\n") || "No approved rules. Add rules to hallpass.config.yml."}`, options.json);
});

interface CheckOptions { staged?: boolean; commit?: string; base?: string; json?: boolean; noPersona?: boolean }
async function runCheck(options: CheckOptions, ci = false): Promise<void> {
  const rootPath = await root();
  const { config } = await loadConfig(rootPath);
  const diff: DiffOptions = { ...(options.staged ? { staged: true } : {}), ...(options.commit ? { commit: options.commit } : {}), ...(options.base ? { base: options.base } : {}), ...(ci && !options.base && !options.commit && !options.staged ? { commit: "HEAD" } : {}) };
  const report = await evaluate(rootPath, config, diff);
  await recordAudit(rootPath, report, ci ? "ci" : "generic");
  print(options.json ? report : renderReport(report, config, ci || options.noPersona), Boolean(options.json));
  if (report.violations.some((item) => item.decision === "require-approval")) process.exitCode = EXIT.APPROVAL;
  else if (report.violations.length) process.exitCode = EXIT.VIOLATION;
}
for (const name of ["check", "ci"] as const) program.command(name).description(name === "ci" ? "Run the CI completion gate" : "Check Git changes against policy").option("--staged", "check staged changes").option("--commit <ref>", "check one commit").option("--base <ref>", "compare HEAD with a base ref").option("--json", "emit JSON").option("--no-persona", "disable humor").action((options) => runCheck(options, name === "ci"));

program.command("conflicts").description("Show contradictory instruction proposals").option("--json", "emit JSON").action(async (options) => {
  const result = findConflicts(await scanInstructions(await root()));
  print(options.json ? result : result.length ? `RESOLUTION REQUIRED\n\n${result.map((item) => `${item.ruleA.source.file}:${item.ruleA.source.line}  ${item.ruleA.text}\n${item.ruleB.source.file}:${item.ruleB.source.line}  ${item.ruleB.text}\nReason: ${item.reason}`).join("\n\n")}` : "No policy conflicts found.", options.json);
  if (result.length) process.exitCode = EXIT.CONFLICT;
});

program.command("explain").description("Explain a rule or the last report").argument("[ruleId]").option("--json", "emit JSON").action(async (ruleId, options) => {
  const rootPath = await root(); const { config } = await loadConfig(rootPath);
  const rule = ruleId ? config.rules.find((item) => item.id === ruleId) : undefined;
  if (ruleId && !rule) throw new ConfigurationError(`Unknown rule: ${ruleId}`);
  const report = await evaluate(rootPath, config);
  const findings = [...report.violations, ...report.warnings].filter((item) => !ruleId || item.ruleId === ruleId);
  if (options.json) print(rule ? { rule, violations: findings } : { violations: findings }, true);
  else if (rule) print(`${rule.id}\n\n${rule.title}\nClassification: ${rule.classification}\nEnforcement: ${rule.enforcement}\nDetector: ${rule.detector.type}${rule.source?.file ? `\nSource: ${rule.source.file}${rule.source.line ? `:${rule.source.line}` : ""}` : ""}${findings.length ? `\n\nCurrent evidence:\n${findings.map((item) => `${item.location?.file ?? "repository"}${item.location?.line ? `:${item.location.line}` : ""}\n${typeof item.evidence === "string" ? item.evidence : JSON.stringify(item.evidence)}`).join("\n\n")}` : "\n\nNo current violation."}`);
  else print(findings.length ? findings.map((item) => `${item.ruleId} ${item.message}\n${item.location?.file ?? "repository"}${item.location?.line ? `:${item.location.line}` : ""}\nEvidence: ${JSON.stringify(item.evidence)}`).join("\n\n") : "No current violations to explain.");
});

program.command("context").alias("effective").description("Show policy applicable to a path").argument("[path]", "repository-relative path", ".").option("--json", "emit JSON").action(async (path, options) => {
  const { config } = await loadConfig(await root());
  const rules = config.rules.filter((rule) => (!rule.scope?.include?.length || matchesAny(path, rule.scope.include)) && (!rule.scope?.exclude?.length || !matchesAny(path, rule.scope.exclude)));
  print(options.json ? { path, rules } : `EFFECTIVE POLICY\n\n${rules.map((rule) => `${rule.id} ${rule.enforcement}  ${rule.title}${rule.locked ? " (locked)" : ""}`).join("\n") || "No path-specific rules."}`, options.json);
});

program.command("doctor").description("Diagnose repository policy health").option("--agent <name>").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root(); const { config, path } = await loadConfig(rootPath); const current = await compile(rootPath);
  const compiled = await readFile(join(rootPath, ".hallpass", "compiled.json"), "utf8").then((text) => JSON.parse(text) as { sourceFingerprint?: string }).catch(() => undefined);
  const checks = { git: true, config: path, instructionSources: new Set(current.instructions.map((item) => item.source.file)).size, activeRules: config.rules.filter((item) => item.enforcement !== "allow").length, deterministicProposals: current.instructions.filter((item) => item.classification === "deterministic").length, ambiguous: current.instructions.filter((item) => item.classification === "ambiguous").length, duplicates: current.duplicates.length, conflicts: current.conflicts.length, compiledPolicyFresh: compiled?.sourceFingerprint === current.fingerprint, adapter: options.agent ? capabilities[options.agent] ?? null : undefined };
  print(options.json ? checks : `HALLPASS DOCTOR\n\n✓ Git repository\n✓ ${path}\n${checks.compiledPolicyFresh ? "✓" : "✗"} Compiled policy fresh\n${checks.conflicts ? "✗" : "✓"} ${checks.conflicts} conflicts\n${checks.duplicates ? "⚠" : "✓"} ${checks.duplicates} duplicates\n${checks.ambiguous ? "⚠" : "✓"} ${checks.ambiguous} ambiguous instructions\n${checks.activeRules} active constraints; ${checks.deterministicProposals} deterministic proposals${options.agent ? `\n${checks.adapter ? "✓" : "✗"} ${options.agent} adapter` : ""}`, options.json);
  if (!checks.compiledPolicyFresh) process.exitCode = EXIT.CONFIG;
  else if (checks.conflicts) process.exitCode = EXIT.CONFLICT;
});

program.command("allow").description("Record a human policy approval").argument("<ruleId>").requiredOption("--reason <reason>").option("--scope <path>").option("--expires <iso-date>").action(async (ruleId, options) => {
  const rootPath = await root(); const { config } = await loadConfig(rootPath);
  if (!config.overrides.enabled) throw new ConfigurationError("Approvals are disabled.");
  if (!config.rules.some((item) => item.id === ruleId) && ruleId !== "GOV-001") throw new ConfigurationError(`Unknown rule: ${ruleId}`);
  if (options.expires && Number.isNaN(Date.parse(options.expires))) throw new ConfigurationError("--expires must be an ISO date.");
  await addApproval(rootPath, { rule: ruleId, reason: options.reason, timestamp: new Date().toISOString(), ...(options.scope ? { scope: options.scope } : {}), ...(options.expires ? { expires: options.expires } : {}) });
  print(`Approval recorded for ${ruleId}.`);
});

program.command("audit").description("Show local policy audit events").option("--json", "emit JSON").action(async (options) => {
  const lines = (await readAudit(await root())).trim().split("\n").filter(Boolean);
  const events = lines.map((line) => JSON.parse(line));
  print(options.json ? events : events.map((event) => `${event.timestamp} ${event.decision} ${event.ruleId}`).join("\n") || "No audit events.", options.json);
});

program.command("capabilities").description("Show adapter enforcement capabilities").option("--json", "emit JSON").action((options) => print(options.json ? capabilities : Object.entries(capabilities).map(([name, value]) => `${name.padEnd(9)} pre-action=${value.preActionGuard} shell=${value.shellGuard} diff=${value.diffVerification} completion=${value.completionGate}`).join("\n"), options.json));

program.command("hook").description("Evaluate a normalized agent hook payload").argument("<adapter>").option("--payload <json>").action(async (adapter, options) => {
  const rootPath = await root(); const { config } = await loadConfig(rootPath);
  if (!capabilities[adapter]) throw new ConfigurationError(`Unknown adapter: ${adapter}`);
  const input = options.payload ?? await readStdin();
  const payload = parse(input || "{}") as Record<string, unknown>;
  const event = normalizeEvent(adapter, payload, rootPath);
  const findings = event.type === "shell.action" ? evaluateShell(event as ShellActionEvent, config.rules) : [];
  print(adapterResponse(adapter, findings), true);
});

program.command("test").description("Validate Hallpass configuration and policy compilation").action(async () => { const rootPath = await root(); validateConfig(parse(await readFile(join(rootPath, (await loadConfig(rootPath)).path), "utf8"))); await compile(rootPath); print("Hallpass configuration and instruction compilation passed."); });

program.parseAsync().catch((error: unknown) => {
  const known = error instanceof ConfigurationError || (error instanceof Error && error.message.startsWith("Git command failed"));
  console.error(`HALLPASS ${known ? "CONFIGURATION ERROR" : "ENGINE FAILURE"}\n\n${error instanceof Error ? error.message : String(error)}`);
  if (process.env.HALLPASS_DEBUG && error instanceof Error) console.error(error.stack);
  process.exitCode = known ? EXIT.CONFIG : EXIT.INTERNAL;
});
