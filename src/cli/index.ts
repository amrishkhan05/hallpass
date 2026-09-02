#!/usr/bin/env node
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { watch as watchRepository } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse, stringify } from "yaml";
import { agentsFileExists, policyConfigPath, policyState, renderStarter, suggestAgents, writeStarter } from "../agents.js";
import { addApproval, approvals, isApproved } from "../approvals.js";
import { baselineFingerprints, clearBaseline, saveBaseline } from "../baseline.js";
import { adapterResponse, capabilities, evaluateShell, normalizeEvent } from "../adapters.js";
import { readAudit, recordAudit } from "../audit.js";
import { ConfigurationError, loadConfig, loadConfigOrDefault, validateConfig } from "../config.js";
import { compilePolicies, conflicts as findConflicts, discoverSources, duplicates as findDuplicates, scanInstructions, sourcesFingerprint } from "../compiler.js";
import { EXIT, VERSION, type HallpassConfig, type ShellActionEvent, type Violation } from "../core/types.js";
import { applyProfile, evaluate } from "../engine.js";
import { repositoryRoot, type DiffOptions } from "../git.js";
import { renderReport } from "../persona.js";
import { fingerprint, matchesAny } from "../utils.js";

const program = new Command();
program.name("hallpass").description("Runtime policy enforcement for AI coding agents.").version(VERSION);
const print = (value: unknown, json = false): void => console.log(json ? JSON.stringify(value, null, 2) : String(value));
const countBy = <T extends string>(values: T[]): Record<T, number> => values.reduce((result, value) => ({ ...result, [value]: (result[value] ?? 0) + 1 }), {} as Record<T, number>);
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};
const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);
async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(question)).trim().toLowerCase(); }
  finally { prompt.close(); }
}

async function root(): Promise<string> { return repositoryRoot(process.cwd()); }
async function compile(rootPath: string): Promise<{ instructions: Awaited<ReturnType<typeof scanInstructions>>; rules: Awaited<ReturnType<typeof compilePolicies>>; conflicts: ReturnType<typeof findConflicts>; duplicates: ReturnType<typeof findDuplicates>; fingerprint: string; policyHash: string }> {
  const instructions = await scanInstructions(rootPath);
  const rules = await compilePolicies(rootPath);
  return { instructions, rules, conflicts: findConflicts(instructions), duplicates: findDuplicates(instructions), fingerprint: sourcesFingerprint(instructions), policyHash: createHash("sha256").update(JSON.stringify(rules)).digest("hex") };
}
async function saveCompiled(rootPath: string, configHash?: string): Promise<Awaited<ReturnType<typeof compile>>> {
  const result = await compile(rootPath);
  await mkdir(join(rootPath, ".hallpass"), { recursive: true });
  await writeFile(join(rootPath, ".hallpass", "compiled.json"), `${JSON.stringify({ compilerVersion: VERSION, timestamp: new Date().toISOString(), sourceFingerprint: result.fingerprint, policyHash: result.policyHash, ...(configHash ? { configHash } : {}), instructions: result.instructions, rules: result.rules, conflicts: result.conflicts, duplicates: result.duplicates }, null, 2)}\n`);
  return result;
}

const initialConfig: HallpassConfig = {
  version: 1,
  profile: "balanced",
  persona: { enabled: true, intensity: 2 },
  sources: ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", ".cursor/rules", ".github/copilot-instructions.md", ".github/instructions"],
  conflicts: { behavior: "block" },
  overrides: { enabled: true, requireReason: true },
  governance: { protect: ["hallpass.config.yml", ".hallpass.yml", ".hallpass/**", "AGENTS.md", "CLAUDE.md", ".claude/hooks/**", ".claude/settings.json", ".cursor/hooks.json", ".github/workflows/**"] },
  rules: [],
};

program.command("init").description("Initialize Hallpass in this Git repository").option("--agent <name>", "install one supported adapter hook").option("--all-agents", "install all supported adapter hooks").option("--no-hooks", "do not install hooks").option("--create-agents", "create a starter AGENTS.md").option("--force", "replace existing configuration and explicitly requested AGENTS.md").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root();
  const configPath = join(rootPath, "hallpass.config.yml");
  if (!options.force) {
    try { await stat(configPath); throw new ConfigurationError("hallpass.config.yml already exists. Use --force to replace it."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const suggestions = await suggestAgents(rootPath);
  let agents = { created: false, path: "AGENTS.md", overwritten: false, suggestionCount: suggestions.length };
  if (options.createAgents) agents = await writeStarter(rootPath, suggestions, Boolean(options.force));
  else if (!await agentsFileExists(rootPath) && interactive() && !options.json) {
    const choice = await ask("No AGENTS.md found.\n\nHallpass can work without one, but AGENTS.md gives coding agents a\nhuman-readable source of repository instructions.\n\nCreate one now?\n\n  Yes — generate a starter AGENTS.md\n  No — use Hallpass config only\n  Not now\n\nChoose [Y/n/later]: ");
    if (!choice || choice === "y" || choice === "yes" || choice === "1") agents = await writeStarter(rootPath, suggestions);
  }
  const compiled = await compile(rootPath);
  const config = { ...initialConfig, rules: compiled.rules };
  const configText = stringify(config);
  await writeFile(configPath, configText);
  await mkdir(join(rootPath, ".hallpass"), { recursive: true });
  const gitignore = join(rootPath, ".gitignore");
  const ignored = await readFile(gitignore, "utf8").catch(() => "");
  if (!ignored.split("\n").includes(".hallpass/")) await appendFile(gitignore, `${ignored && !ignored.endsWith("\n") ? "\n" : ""}.hallpass/\n`);
  const result = await saveCompiled(rootPath, createHash("sha256").update(configText).digest("hex"));
  const hookTargets = options.hooks === false ? [] : options.allAgents ? Object.keys(INSTALL_HOOKS) : options.agent ? [options.agent] : [];
  const hooks: Record<string, string> = {};
  for (const name of hookTargets) {
    const spec = INSTALL_HOOKS[name];
    if (!spec) throw new ConfigurationError(`Unknown hook-capable agent: ${name}.`);
    hooks[name] = await mergeHook(join(rootPath, ...spec.file), spec.base ?? {}, spec.group, spec.entry, spec.match);
  }
  const summary = { schemaVersion: 1, repository: rootPath, policyState: "CONFIGURED", agents, sources: [...new Set(result.instructions.map((item) => item.source.file))], instructions: result.instructions.length, classifications: countBy(result.instructions.map((item) => item.classification)), duplicates: result.duplicates.length, conflicts: result.conflicts.length, config: "hallpass.config.yml", hooks };
  print(options.json ? summary : `HALLPASS INIT\n\nRepository detected.\n${summary.sources.length} instruction sources, ${summary.instructions} instructions, ${summary.duplicates} duplicates, ${summary.conflicts} conflicts.\n\nReview hallpass.config.yml and add approved blocking rules.`, options.json);
});

program.command("scan").description("Discover and classify repository instructions").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root();
  const [result, state, instructionSources, hasAgents, configSource] = await Promise.all([compile(rootPath), policyState(rootPath), discoverSources(rootPath), agentsFileExists(rootPath), policyConfigPath(rootPath)]);
  const sources = [...(configSource ? [configSource] : []), ...instructionSources];
  const sourceLines = sources.map((source) => `✓ ${source}`);
  if (!hasAgents) sourceLines.push("— AGENTS.md not present");
  const classifications = countBy(result.rules.map((rule) => rule.classification));
  const text = sources.length
    ? `HALLPASS SCAN\n\nPolicy sources\n\n${sourceLines.join("\n")}\n\nPolicy state: ${state}\n\nCompiled:\n${classifications.deterministic ?? 0} deterministic rules\n${classifications.structural ?? 0} structural rules\n${(classifications.heuristic ?? 0) + (classifications.semantic ?? 0) + (classifications.advisory ?? 0)} advisory instructions`
    : `HALLPASS SCAN\n\nNo project-specific policy sources found.\n\n— AGENTS.md not present\n\nPolicy state: ${state}\n\nBuilt-in safety guard: active\n\nRun \`hallpass init\` to configure repository policy.`;
  print(options.json ? { schemaVersion: 1, agentsFileExists: hasAgents, policyState: state, sources, ...result } : text, options.json);
});

const agentsCommand = program.command("agents").description("Suggest or create repository agent instructions");
agentsCommand.command("suggest").description("Suggest AGENTS.md instructions without modifying files").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root();
  const [suggestions, hasAgents, state] = await Promise.all([suggestAgents(rootPath), agentsFileExists(rootPath), policyState(rootPath)]);
  const result = { schemaVersion: 1, agentsFileExists: hasAgents, policyState: state, suggestions };
  if (options.json) print(result, true);
  else {
    const groups = [
      ["Repository-derived", suggestions.filter((item) => item.origin === "repository-derived")],
      ["Existing policy", suggestions.filter((item) => item.origin === "existing-policy")],
      ["Hallpass recommendations", suggestions.filter((item) => item.origin === "hallpass-recommended")],
    ] as const;
    let number = 0;
    const body = groups.filter(([, items]) => items.length).map(([title, items]) => `${title}:\n\n${items.map((item) => `${++number}. ${item.text}\n   Evidence: ${item.evidence.file}${item.evidence.path ? ` (${item.evidence.path})` : ""}`).join("\n\n")}`).join("\n\n");
    print(`Suggested AGENTS.md rules\n\n${body}\n\nThese are suggestions, not active policy.\n\nRun:\nhallpass agents init\n\nto review and create AGENTS.md.`);
  }
});
agentsCommand.command("init").description("Review and create a starter AGENTS.md").option("--force", "replace an existing AGENTS.md").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root();
  const suggestions = await suggestAgents(rootPath);
  const present = await agentsFileExists(rootPath);
  if (present && !options.force && !interactive()) {
    const result = { schemaVersion: 1, created: false, path: "AGENTS.md", overwritten: false, suggestionCount: suggestions.length };
    print(options.json ? result : "AGENTS.md already exists; left untouched. Use --force to replace it.", Boolean(options.json));
    return;
  }
  if (interactive() && !options.json) {
    const content = renderStarter(suggestions);
    const answer = await ask(`${content}\n${present ? "AGENTS.md already exists. Replace it?" : "Create AGENTS.md with this content?"} [y/N]: `);
    if (answer !== "y" && answer !== "yes") { print("AGENTS.md was not changed."); return; }
  }
  const result = await writeStarter(rootPath, suggestions, Boolean(options.force || present));
  print(options.json ? { schemaVersion: 1, ...result } : `${result.overwritten ? "Replaced" : "Created"} AGENTS.md with ${result.suggestionCount} suggestions.`, Boolean(options.json));
});

program.command("sync").description("Refresh compiled instruction proposals").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root(); const loaded = await loadConfig(rootPath); const compiled = await compile(rootPath);
  const config = { ...loaded.config, rules: [...loaded.config.rules.filter((rule) => rule.source?.type !== "generated"), ...compiled.rules] };
  const configText = stringify(config);
  await writeFile(join(rootPath, loaded.path), configText);
  const result = await saveCompiled(rootPath, createHash("sha256").update(configText).digest("hex"));
  print(options.json ? { schemaVersion: 1, ...result } : `POLICY SYNCED\n\n${result.instructions.length} instructions; ${result.duplicates.length} duplicates; ${result.conflicts.length} conflicts.`, options.json);
});

program.command("rules").description("List approved policy rules").option("--json", "emit JSON").option("--active", "only active rules").option("--blocking", "only blocking rules").option("--advisory", "only advisory rules").option("--classification <value>").option("--source <file>", "filter by source").option("--scope <path>", "filter by effective path").action(async (options) => {
  const { config } = await loadConfig(await root());
  const rules = config.rules.filter((rule) => (!options.active || rule.enforcement !== "allow") && (!options.blocking || rule.enforcement === "block" || rule.enforcement === "require-approval") && (!options.advisory || rule.enforcement === "warn" || rule.enforcement === "audit") && (!options.classification || rule.classification === options.classification) && (!options.source || rule.source?.file === options.source) && (!options.scope || (!rule.scope?.include?.length || matchesAny(options.scope, rule.scope.include)) && (!rule.scope?.exclude?.length || !matchesAny(options.scope, rule.scope.exclude))));
  print(options.json ? { schemaVersion: 1, rules } : `HALLPASS RULEBOOK\n\n${rules.map((rule) => `${rule.id.padEnd(12)} ${rule.enforcement.padEnd(16)} ${rule.title}`).join("\n") || "No approved rules. Add rules to hallpass.config.yml."}`, options.json);
});

interface CheckOptions { staged?: boolean; commit?: string; base?: string; files?: string[]; json?: boolean; noPersona?: boolean; format?: string }
async function runCheck(options: CheckOptions, ci = false): Promise<void> {
  const rootPath = await root();
  const { config } = await loadConfigOrDefault(rootPath);
  const diff: DiffOptions = { ...(options.staged ? { staged: true } : {}), ...(options.commit ? { commit: options.commit } : {}), ...(options.base ? { base: options.base } : {}), ...(options.files?.length ? { files: options.files } : {}), ...(ci && !options.base && !options.commit && !options.staged ? { commit: "HEAD" } : {}) };
  const report = await evaluate(rootPath, config, diff);
  await recordAudit(rootPath, report, ci ? "ci" : "generic");
  const format = options.json ? "json" : options.format ?? "terminal";
  if (!["terminal", "json", "github", "sarif"].includes(format)) throw new ConfigurationError("--format must be terminal | json | github | sarif.");
  if (format === "json") print(report, true);
  else if (format === "github") print([...report.violations, ...report.warnings].map((item) => `::${item.decision === "warn" || item.decision === "audit" ? "warning" : "error"}${item.location?.file ? ` file=${item.location.file}${item.location.line ? `,line=${item.location.line}` : ""}` : ""}::[${item.ruleId}] ${item.message}`).join("\n") || "PASS GRANTED ✓");
  else if (format === "sarif") print({ version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs: [{ tool: { driver: { name: "Hallpass", version: VERSION } }, results: [...report.violations, ...report.warnings].map((item) => ({ ruleId: item.ruleId, level: item.decision === "warn" || item.decision === "audit" ? "warning" : "error", message: { text: item.message }, ...(item.location?.file ? { locations: [{ physicalLocation: { artifactLocation: { uri: item.location.file }, ...(item.location.line ? { region: { startLine: item.location.line } } : {}) } }] } : {}) })) }] }, true);
  else print(renderReport(report, config, ci || options.noPersona));
  if (report.violations.some((item) => item.decision === "require-approval")) process.exitCode = EXIT.APPROVAL;
  else if (report.violations.length) process.exitCode = EXIT.VIOLATION;
}
for (const name of ["check", "ci"] as const) program.command(name).description(name === "ci" ? "Run the CI completion gate" : "Check Git changes against policy").option("--staged", "check staged changes").option("--commit <ref>", "check one commit").option("--base <ref>", "compare HEAD with a base ref").option("--files <paths...>", "check explicit files").option("--format <format>", "terminal, json, github, or sarif").option("--json", "emit JSON").option("--no-persona", "disable humor").action((options) => runCheck(options, name === "ci"));

program.command("watch").description("Watch meaningful repository changes without duplicate reports").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root(); const { config } = await loadConfig(rootPath);
  let previous = ""; let timer: NodeJS.Timeout | undefined;
  const check = async (): Promise<void> => {
    const report = await evaluate(rootPath, config);
    const signature = [...report.violations, ...report.warnings].map((item) => item.fingerprint).sort().join(":");
    if (signature === previous) return;
    previous = signature;
    await recordAudit(rootPath, report, "watch");
    print(options.json ? report : renderReport(report, config), Boolean(options.json));
  };
  await check();
  watchRepository(rootPath, { recursive: true }, (_event, file) => {
    if (!file || file.startsWith(".git/") || file.startsWith(".hallpass/audit/")) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void check().catch((error) => console.error(error)), 150);
  });
});

program.command("finish").description("Run the authoritative completion gate").option("--staged", "check staged changes").option("--commit <ref>", "check one commit").option("--base <ref>", "compare HEAD with a base ref").option("--files <paths...>", "check explicit files").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root();
  const { config } = await loadConfig(rootPath);
  const current = await compile(rootPath);
  const saved = await readFile(join(rootPath, ".hallpass", "compiled.json"), "utf8").then((text) => JSON.parse(text) as { sourceFingerprint?: string }).catch(() => undefined);
  const report = await evaluate(rootPath, config, options);
  const gateFindings: Violation[] = [];
  const addGateFinding = (ruleId: string, message: string, evidence: unknown): void => {
    const id = fingerprint(ruleId, evidence);
    gateFindings.push({ id, ruleId, decision: "block", classification: "deterministic", message, category: "completion.gate", evidence, fingerprint: id });
  };
  if (saved?.sourceFingerprint !== current.fingerprint) addGateFinding("POLICY-STALE", "Compiled policy is stale. Run hallpass sync.", { expected: current.fingerprint, actual: saved?.sourceFingerprint });
  if (current.conflicts.length) addGateFinding("POLICY-CONFLICT", "Unresolved instruction conflicts prevent completion.", current.conflicts);
  report.violations.unshift(...gateFindings);
  if (gateFindings.length) report.status = "fail";
  await recordAudit(rootPath, report, "completion-gate");
  print(options.json ? report : renderReport(report, config), Boolean(options.json));
  if (current.conflicts.length) process.exitCode = EXIT.CONFLICT;
  else if (gateFindings.some((item) => item.ruleId === "POLICY-STALE")) process.exitCode = EXIT.CONFIG;
  else if (report.violations.some((item) => item.decision === "require-approval")) process.exitCode = EXIT.APPROVAL;
  else if (report.violations.length) process.exitCode = EXIT.VIOLATION;
});

program.command("conflicts").description("Show contradictory instruction proposals").option("--json", "emit JSON").action(async (options) => {
  const result = findConflicts(await scanInstructions(await root()));
  print(options.json ? { schemaVersion: 1, conflicts: result } : result.length ? `RESOLUTION REQUIRED\n\n${result.map((item) => `${item.ruleA.source.file}:${item.ruleA.source.line}  ${item.ruleA.text}\n${item.ruleB.source.file}:${item.ruleB.source.line}  ${item.ruleB.text}\nReason: ${item.reason}`).join("\n\n")}` : "No policy conflicts found.", options.json);
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
  const rootPath = await root(); const { config } = await loadConfigOrDefault(rootPath); const compiled = await compile(rootPath); const state = await policyState(rootPath);
  const rules = config.rules.filter((rule) => (!rule.scope?.include?.length || matchesAny(path, rule.scope.include)) && (!rule.scope?.exclude?.length || !matchesAny(path, rule.scope.exclude)));
  const context = { schemaVersion: 1, path, policyState: state, projectSpecificEnforcement: rules.length ? rules : [], builtInSafety: { active: true, protected: ["destructive Git operations", "Hallpass governance", "approval integrity"] }, rules, blocked: rules.filter((rule) => rule.enforcement === "block"), approvalRequired: rules.filter((rule) => rule.enforcement === "require-approval"), protectedFiles: config.governance.protect, requiredValidations: rules.filter((rule) => rule.detector.type === "required-command").map((rule) => rule.detector.command).filter(Boolean), conflicts: compiled.conflicts };
  print(options.json ? context : `EFFECTIVE POLICY\n\nPolicy state: ${state}\n\nProject-specific enforcement:\n${rules.map((rule) => `${rule.id} ${rule.enforcement}  ${rule.title}${rule.locked ? " (locked)" : ""}`).join("\n") || "none"}\n\nBuilt-in safety:\nactive\n\nProtected by default:\n- destructive Git operations\n- Hallpass governance\n- approval integrity${state === "UNCONFIGURED" ? "\n\nRecommended:\nhallpass init" : ""}`, options.json);
});

program.command("doctor").description("Diagnose repository policy health").option("--agent <name>").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root(); const { config, path } = await loadConfig(rootPath); const current = await compile(rootPath);
  const compiled = await readFile(join(rootPath, ".hallpass", "compiled.json"), "utf8").then((text) => JSON.parse(text) as { sourceFingerprint?: string }).catch(() => undefined);
  const checks = { schemaVersion: 1, git: true, config: path, instructionSources: new Set(current.instructions.map((item) => item.source.file)).size, activeRules: config.rules.filter((item) => item.enforcement !== "allow").length, deterministicProposals: current.instructions.filter((item) => item.classification === "deterministic").length, ambiguous: current.instructions.filter((item) => item.classification === "ambiguous").length, duplicates: current.duplicates.length, conflicts: current.conflicts.length, compiledPolicyFresh: compiled?.sourceFingerprint === current.fingerprint, adapter: options.agent ? capabilities[options.agent] ?? null : undefined };
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

program.command("guard").description("Evaluate a sensitive action before execution").argument("<action>", "shell, write, delete, or dependency").option("--command <command>").option("--file <path>").option("--add <package>").option("--remove <package>").option("--json", "emit JSON").action(async (action, options) => {
  const rootPath = await root(); const { config } = await loadConfig(rootPath);
  const activeRules = config.rules.map((rule) => applyProfile(rule, config.profile));
  let findings: Violation[];
  if (action === "shell") {
    if (!options.command) throw new ConfigurationError("guard shell requires --command.");
    findings = evaluateShell(normalizeEvent("generic", { command: options.command }, rootPath) as ShellActionEvent, activeRules);
  } else if (action === "write" || action === "delete") {
    if (!options.file) throw new ConfigurationError(`guard ${action} requires --file.`);
    const rules = [
      { id: "GOV-001", title: "Governance files require human approval", classification: "deterministic", enforcement: "require-approval", locked: true, detector: { type: "governance-modification", paths: config.governance.protect } } as const,
      ...activeRules.filter((rule) => ["protected-file", "forbidden-path", "generated-file", "governance-modification"].includes(rule.detector.type)),
    ];
    findings = rules.filter((rule) => matchesAny(options.file, rule.detector.paths)).map((rule) => {
      const id = fingerprint(rule.id, action, options.file);
      return { id, ruleId: rule.id, decision: rule.enforcement === "allow" ? "audit" : rule.enforcement, classification: rule.classification, message: `${rule.title}: ${options.file}`, category: `${action}.denied`, location: { file: options.file }, evidence: { action, file: options.file }, fingerprint: id } satisfies Violation;
    });
  } else if (action === "dependency") {
    const packageName = options.add ?? options.remove;
    if (!packageName) throw new ConfigurationError("guard dependency requires --add or --remove.");
    const change = options.add ? "add" : "remove";
    findings = activeRules.filter((rule) => (rule.detector.type === "dependency-change" && (rule.detector.action ?? "add") === change || rule.detector.type === "forbidden-dependency" && change === "add" && rule.detector.packages?.includes(packageName)) && rule.enforcement !== "allow").map((rule) => {
      const id = fingerprint(rule.id, change, packageName);
      return { id, ruleId: rule.id, decision: rule.enforcement === "allow" ? "audit" : rule.enforcement, classification: rule.classification, message: `${rule.title}: ${packageName}`, category: "dependency.unapproved", evidence: { package: packageName, action: change }, fingerprint: id } satisfies Violation;
    });
  } else throw new ConfigurationError(`Unknown guard action: ${action}.`);
  const approvalList = await approvals(rootPath);
  findings = findings.filter((item) => !isApproved(approvalList, item.ruleId, item.location?.file));
  const blocked = findings.find((item) => item.decision === "block" || item.decision === "require-approval");
  const decision = blocked?.decision === "require-approval" ? "approval_required" : blocked ? "deny" : findings.length ? "warn" : "allow";
  const result = { schemaVersion: 1, status: blocked ? "fail" : findings.length ? "warn" : "pass", decision, violations: findings };
  print(options.json ? result : blocked ? `HALLPASS DENIED ✗\n\n${blocked.ruleId}\n${blocked.message}` : findings.length ? `WARNINGS\n\n${findings.map((item) => `${item.ruleId} ${item.message}`).join("\n")}` : "PASS GRANTED ✓", Boolean(options.json));
  if (decision === "approval_required") process.exitCode = EXIT.APPROVAL;
  else if (decision === "deny") process.exitCode = EXIT.VIOLATION;
});

const INSTALL_HOOKS: Record<string, { file: string[]; group: string; entry: Record<string, unknown>; match: string; base?: Record<string, unknown> }> = {
  claude: { file: [".claude", "settings.json"], group: "PreToolUse", entry: { matcher: "Bash", hooks: [{ type: "command", command: "hallpass hook claude" }] }, match: "hallpass hook claude" },
  cursor: { file: [".cursor", "hooks.json"], group: "beforeShellExecution", entry: { command: "hallpass hook cursor", failClosed: true }, match: "hallpass hook cursor", base: { version: 1 } },
};
async function mergeHook(filePath: string, base: Record<string, unknown>, group: string, entry: Record<string, unknown>, match: string): Promise<"created" | "updated" | "already-installed"> {
  let existing: Record<string, unknown> = { ...base };
  try { existing = { ...base, ...JSON.parse(await readFile(filePath, "utf8")) }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const hooks = existing.hooks as Record<string, unknown[]> | undefined;
  const list: unknown[] = Array.isArray(hooks?.[group]) ? hooks[group] : [];
  if (list.some((item) => JSON.stringify(item).includes(match))) return "already-installed";
  existing.hooks = { ...(existing.hooks ?? {}), [group]: [...list, entry] };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`);
  return list.length ? "updated" : "created";
}

program.command("install").description("Wire Hallpass into an agent's native pre-tool hook (claude, cursor, or all)").argument("<target>").option("--json", "emit JSON").action(async (target, options) => {
  const targets = target === "all" ? Object.keys(INSTALL_HOOKS) : [target];
  const invalid = targets.filter((name) => !INSTALL_HOOKS[name]);
  if (invalid.length) throw new ConfigurationError(`Unknown install target: ${invalid.join(", ")}. Use ${Object.keys(INSTALL_HOOKS).join(", ")}, or all.`);
  const rootPath = await root();
  const results: Record<string, { path: string; status: string }> = {};
  for (const name of targets) {
    const spec = INSTALL_HOOKS[name]!;
    const path = join(rootPath, ...spec.file);
    const status = await mergeHook(path, spec.base ?? {}, spec.group, spec.entry, spec.match);
    results[name] = { path: join(...spec.file), status };
  }
  print(options.json ? results : Object.entries(results).map(([name, info]) => `${name.padEnd(8)} ${info.status.padEnd(18)} ${info.path}`).join("\n"), options.json);
});

program.command("audit").description("Show local policy audit events").option("--rule <id>").option("--agent <name>").option("--file <path>").option("--decision <decision>").option("--since <date>").option("--last <count>").option("--json", "emit JSON").action(async (options) => {
  const lines = (await readAudit(await root())).trim().split("\n").filter(Boolean);
  let events = lines.map((line) => JSON.parse(line)).filter((event) => (!options.rule || event.ruleId === options.rule) && (!options.agent || event.agent === options.agent) && (!options.file || event.file === options.file) && (!options.decision || event.decision === options.decision) && (!options.since || Date.parse(event.timestamp) >= Date.parse(options.since)));
  if (options.last !== undefined) {
    const count = Number(options.last);
    if (!Number.isInteger(count) || count < 0) throw new ConfigurationError("--last must be a non-negative integer.");
    events = count ? events.slice(-count) : [];
  }
  print(options.json ? { schemaVersion: 1, events } : events.map((event) => `${event.timestamp} ${event.decision} ${event.ruleId ?? "-"}`).join("\n") || "No audit events.", options.json);
});

program.command("baseline").description("Manage accepted existing violations").argument("<action>", "create, status, update, or clear").option("--json", "emit JSON").action(async (action, options) => {
  const rootPath = await root();
  if (action === "clear") {
    await clearBaseline(rootPath);
    print(options.json ? { schemaVersion: 1, status: "cleared", violations: 0 } : "Baseline cleared.", Boolean(options.json));
    return;
  }
  if (action === "status") {
    const fingerprints = await baselineFingerprints(rootPath);
    print(options.json ? { schemaVersion: 1, status: fingerprints.length ? "active" : "empty", violations: fingerprints.length, fingerprints } : `${fingerprints.length} baselined violations.`, Boolean(options.json));
    return;
  }
  if (action !== "create" && action !== "update") throw new ConfigurationError(`Unknown baseline action: ${action}.`);
  const { config } = await loadConfig(rootPath);
  const report = await evaluate(rootPath, config, {}, false);
  const fingerprints = [...report.violations, ...report.warnings].filter((item) => item.ruleId !== "GOV-001" && !item.category.startsWith("completion.")).map((item) => item.fingerprint);
  await saveBaseline(rootPath, fingerprints);
  print(options.json ? { schemaVersion: 1, status: "active", violations: fingerprints.length, fingerprints } : `${fingerprints.length} violations added to the baseline.`, Boolean(options.json));
});

program.command("capabilities").description("Show adapter enforcement capabilities").option("--json", "emit JSON").action((options) => print(options.json ? { schemaVersion: 1, capabilities } : Object.entries(capabilities).map(([name, value]) => `${name.padEnd(9)} pre-action=${value.preActionGuard} shell=${value.shellGuard} diff=${value.diffVerification} completion=${value.completionGate}`).join("\n"), options.json));

program.command("hook").description("Evaluate a normalized agent hook payload").argument("<adapter>").option("--payload <json>").action(async (adapter, options) => {
  const rootPath = await root(); const { config } = await loadConfig(rootPath);
  if (!capabilities[adapter]) throw new ConfigurationError(`Unknown adapter: ${adapter}`);
  const input = options.payload ?? await readStdin();
  const payload = parse(input || "{}") as Record<string, unknown>;
  const event = normalizeEvent(adapter, payload, rootPath);
  const findings = event.type === "shell.action" ? evaluateShell(event as ShellActionEvent, config.rules.map((rule) => applyProfile(rule, config.profile))) : [];
  print(adapterResponse(adapter, findings), true);
});

program.command("test").description("Validate configuration and declarative policy cases").option("--file <path>", "policy test YAML", "hallpass.tests.yml").option("--json", "emit JSON").action(async (options) => {
  const rootPath = await root(); const loaded = await loadConfig(rootPath);
  validateConfig(parse(await readFile(join(rootPath, loaded.path), "utf8"))); await compile(rootPath);
  const input = await readFile(join(rootPath, options.file), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  if (!input) { print(options.json ? { schemaVersion: 1, status: "pass", tests: [] } : "Hallpass configuration and instruction compilation passed.", Boolean(options.json)); return; }
  const document = parse(input) as unknown;
  const cases = Array.isArray(document) ? document : (document as { tests?: unknown[] })?.tests;
  if (!Array.isArray(cases)) throw new ConfigurationError(`${options.file}: expected a tests list.`);
  const results: Array<{ name: string; status: "pass" | "fail"; expected: unknown; actual: unknown }> = [];
  for (const [index, value] of cases.entries()) {
    const item = value as { name?: string; given?: { file?: string; before?: string; content?: string }; expect?: { rule?: string; decision?: string } };
    if (!item.given?.file || item.given.content === undefined || !item.expect?.decision) throw new ConfigurationError(`${options.file}: tests[${index}] requires given.file, given.content, and expect.decision.`);
    if (isAbsolute(item.given.file) || item.given.file.split(/[\\/]/).includes("..")) throw new ConfigurationError(`${options.file}: tests[${index}].given.file must stay inside the test repository.`);
    const testRoot = await mkdtemp(join(tmpdir(), "hallpass-policy-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: testRoot });
      execFileSync("git", ["config", "user.email", "hallpass@example.invalid"], { cwd: testRoot });
      execFileSync("git", ["config", "user.name", "Hallpass"], { cwd: testRoot });
      await writeFile(join(testRoot, "package.json"), '{"private":true}\n');
      if (item.given.before !== undefined) { await mkdir(dirname(join(testRoot, item.given.file)), { recursive: true }); await writeFile(join(testRoot, item.given.file), item.given.before); }
      execFileSync("git", ["add", "."], { cwd: testRoot }); execFileSync("git", ["commit", "-qm", "baseline"], { cwd: testRoot });
      await mkdir(dirname(join(testRoot, item.given.file)), { recursive: true }); await writeFile(join(testRoot, item.given.file), item.given.content);
      const report = await evaluate(testRoot, loaded.config, {}, false);
      const finding = [...report.violations, ...report.warnings].find((candidate) => !item.expect?.rule || candidate.ruleId === item.expect.rule);
      const actual = finding?.decision === "block" ? "deny" : finding?.decision === "require-approval" ? "approval_required" : finding?.decision ?? "allow";
      results.push({ name: item.name ?? `test ${index + 1}`, status: actual === item.expect.decision ? "pass" : "fail", expected: item.expect, actual: finding ? { rule: finding.ruleId, decision: actual } : { decision: actual } });
    } finally { await rm(testRoot, { recursive: true, force: true }); }
  }
  const failed = results.some((item) => item.status === "fail");
  print(options.json ? { schemaVersion: 1, status: failed ? "fail" : "pass", tests: results } : results.map((item) => `${item.status === "pass" ? "PASS" : "FAIL"} ${item.name}`).join("\n"), Boolean(options.json));
  if (failed) process.exitCode = EXIT.VIOLATION;
});

program.parseAsync().catch((error: unknown) => {
  const known = error instanceof ConfigurationError || (error instanceof Error && error.message.startsWith("Git command failed"));
  console.error(`HALLPASS ${known ? "CONFIGURATION ERROR" : "ENGINE FAILURE"}\n\n${error instanceof Error ? error.message : String(error)}`);
  if (process.env.HALLPASS_DEBUG && error instanceof Error) console.error(error.stack);
  process.exitCode = known ? EXIT.CONFIG : EXIT.INTERNAL;
});
