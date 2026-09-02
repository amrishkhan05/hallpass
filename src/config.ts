import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { Classification, Decision, DetectorType, EnforcementProfile, HallpassConfig, HallpassRule } from "./core/types.js";

const classifications = new Set<Classification>(["deterministic", "structural", "heuristic", "semantic", "advisory"]);
const decisions = new Set<Decision>(["allow", "audit", "warn", "require-approval", "block"]);
const detectorTypes = new Set<DetectorType>(["protected-file", "forbidden-path", "generated-file", "dependency-change", "forbidden-dependency", "forbidden-import", "required-import", "typescript-any", "ts-ignore", "eslint-disable", "test-deletion", "required-command", "max-changed-files", "max-changed-loc", "governance-modification", "shell-command"]);
export const defaultGovernance = ["hallpass.config.yml", ".hallpass.yml", ".hallpass/**", "AGENTS.md", "CLAUDE.md", ".claude/hooks/**", ".claude/settings.json", ".cursor/hooks.json", ".github/workflows/**"];

export class ConfigurationError extends Error { override name = "ConfigurationError" }

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ConfigurationError(`${path}: expected a list of strings`);
  return value;
}

function parseRule(value: unknown, index: number): HallpassRule {
  const path = `rules[${index}]`;
  if (!value || typeof value !== "object") throw new ConfigurationError(`${path}: expected an object`);
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id) throw new ConfigurationError(`${path}.id: expected a non-empty string`);
  if (typeof item.title !== "string" || !item.title) throw new ConfigurationError(`${path}.title: expected a non-empty string`);
  if (!classifications.has(item.classification as Classification)) throw new ConfigurationError(`${path}.classification: expected deterministic | structural | heuristic | semantic | advisory`);
  if (!decisions.has(item.enforcement as Decision)) throw new ConfigurationError(`${path}.enforcement: expected allow | audit | warn | require-approval | block`);
  if (!item.detector || typeof item.detector !== "object" || !detectorTypes.has((item.detector as { type?: DetectorType }).type as DetectorType)) throw new ConfigurationError(`${path}.detector.type: unsupported detector`);
  const detector = item.detector as Record<string, unknown>;
  for (const field of ["paths", "imports", "packages", "commands"] as const) if (detector[field] !== undefined) stringArray(detector[field], `${path}.detector.${field}`);
  if (detector.command !== undefined && typeof detector.command !== "string") throw new ConfigurationError(`${path}.detector.command: expected a string`);
  if (detector.limit !== undefined && (typeof detector.limit !== "number" || detector.limit < 0 || !Number.isFinite(detector.limit))) throw new ConfigurationError(`${path}.detector.limit: expected a non-negative number`);
  if (detector.action !== undefined && !["add", "remove", "any"].includes(detector.action as string)) throw new ConfigurationError(`${path}.detector.action: expected add | remove | any`);
  if (detector.when !== undefined) {
    if (!detector.when || typeof detector.when !== "object") throw new ConfigurationError(`${path}.detector.when: expected an object`);
    const changed = (detector.when as Record<string, unknown>).changed;
    if (changed !== undefined) stringArray(changed, `${path}.detector.when.changed`);
  }
  if (item.scope !== undefined) {
    if (!item.scope || typeof item.scope !== "object") throw new ConfigurationError(`${path}.scope: expected an object`);
    const scope = item.scope as Record<string, unknown>;
    if (scope.include !== undefined) stringArray(scope.include, `${path}.scope.include`);
    if (scope.exclude !== undefined) stringArray(scope.exclude, `${path}.scope.exclude`);
  }
  return item as unknown as HallpassRule;
}

export function validateConfig(value: unknown): HallpassConfig {
  if (!value || typeof value !== "object") throw new ConfigurationError("configuration: expected an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new ConfigurationError("version: expected 1");
  const profile = raw.profile ?? "balanced";
  if (!["advisory", "balanced", "strict", "lockdown"].includes(profile as string)) throw new ConfigurationError("profile: expected advisory | balanced | strict | lockdown");
  const persona = (raw.persona ?? {}) as Record<string, unknown>;
  const intensity = persona.intensity ?? 2;
  if (![0, 1, 2, 3].includes(intensity as number)) throw new ConfigurationError("persona.intensity: expected 0 | 1 | 2 | 3");
  const rules = raw.rules === undefined ? [] : Array.isArray(raw.rules) ? raw.rules.map(parseRule) : (() => { throw new ConfigurationError("rules: expected a list"); })();
  const duplicate = rules.find((rule, index) => rules.findIndex((candidate) => candidate.id === rule.id) !== index);
  if (duplicate) throw new ConfigurationError(`rules: duplicate id ${duplicate.id}`);
  const governance = (raw.governance ?? {}) as Record<string, unknown>;
  const conflicts = (raw.conflicts ?? {}) as Record<string, unknown>;
  const overrides = (raw.overrides ?? {}) as Record<string, unknown>;
  const behavior = conflicts.behavior ?? "block";
  if (behavior !== "warn" && behavior !== "block") throw new ConfigurationError("conflicts.behavior: expected warn | block");
  return {
    version: 1,
    profile: profile as EnforcementProfile,
    persona: { enabled: persona.enabled !== false, intensity: intensity as 0 | 1 | 2 | 3 },
    sources: raw.sources === undefined ? ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", ".cursor/rules", ".github/copilot-instructions.md", ".github/instructions"] : stringArray(raw.sources, "sources"),
    conflicts: { behavior },
    overrides: { enabled: overrides.enabled !== false, requireReason: overrides.requireReason !== false },
    governance: { protect: governance.protect === undefined ? defaultGovernance : stringArray(governance.protect, "governance.protect") },
    rules,
  };
}

export async function loadConfig(root: string): Promise<{ config: HallpassConfig; path: string }> {
  for (const name of ["hallpass.config.yml", ".hallpass.yml"]) {
    try { return { config: validateConfig(parse(await readFile(join(root, name), "utf8"))), path: name }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new ConfigurationError("No hallpass.config.yml or .hallpass.yml found. Run `hallpass init`.");
}
