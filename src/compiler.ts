import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, join } from "node:path";
import type { HallpassRule, Instruction, PolicyConflict } from "./core/types.js";
import { fingerprint, matchesAny } from "./utils.js";

const ignored = new Set([".git", ".hallpass", "node_modules", "dist", "coverage"]);
const sourceName = (path: string): boolean => /(^|\/)(AGENTS(?:\.override)?\.md|CLAUDE\.md|\.cursor\/rules\/.*\.(?:md|mdc)|\.github\/copilot-instructions\.md|\.github\/instructions\/.*\.instructions\.md)$/.test(path);

async function walk(root: string, directory = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(root, absolute));
    else { const path = relative(root, absolute).replaceAll("\\", "/"); if (sourceName(path)) found.push(path); }
  }
  return found.sort();
}

export async function discoverSources(root: string): Promise<string[]> {
  return walk(root);
}

function classify(text: string): Instruction["classification"] {
  if (/\b(never|must not|forbidden|do not|cannot|maximum|max |required|must|only)\b/i.test(text) && /\b(file|path|dependenc|import|command|test|lint|build|generated|typescript|eslint|controller|service|lines?)\b/i.test(text)) return "deterministic";
  if (/\b(layer|architecture|controller|service|repository|import)\b/i.test(text)) return "structural";
  if (/\b(prefer|reuse|avoid unnecessary|simple|thin|pattern)\b/i.test(text)) return "semantic";
  if (/\b(should|recommend|consider)\b/i.test(text)) return "advisory";
  return "ambiguous";
}

export async function scanInstructions(root: string): Promise<Instruction[]> {
  const instructions: Instruction[] = [];
  for (const file of await discoverSources(root)) {
    const lines = (await readFile(join(root, file), "utf8")).split("\n");
    for (const [index, raw] of lines.entries()) {
      const text = raw.replace(/^\s*(?:[-*+] |\d+[.)] )/, "").trim();
      if (!text || text.startsWith("#") || text.startsWith("```") || text.length < 12) continue;
      instructions.push({ text, source: { file, line: index + 1 }, classification: classify(text), fingerprint: fingerprint(file, index + 1, text) });
    }
  }
  return instructions;
}

export function conflicts(instructions: Instruction[]): PolicyConflict[] {
  const result: PolicyConflict[] = [];
  for (let left = 0; left < instructions.length; left++) for (let right = left + 1; right < instructions.length; right++) {
    const a = instructions[left]; const b = instructions[right];
    if (!a || !b || a.source.file === b.source.file) continue;
    const dependencyConflict = /\b(?:never|do not|must not)\b.*\b(?:add|introduce|use)\b.*\bdependenc/i.test(a.text) && /\b(?:use|install|add)\b\s+(?:the\s+)?[\w@/-]+/i.test(b.text)
      || /\b(?:never|do not|must not)\b.*\b(?:add|introduce|use)\b.*\bdependenc/i.test(b.text) && /\b(?:use|install|add)\b\s+(?:the\s+)?[\w@/-]+/i.test(a.text);
    if (dependencyConflict) result.push({ ruleA: a, ruleB: b, reason: "One instruction forbids dependencies while another requires using one.", confidence: "possible" });
  }
  return result;
}

function specificityFor(patterns: string[] = ["**/*"]): number {
  return patterns.reduce((score, pattern) => {
    const normalized = pattern.replaceAll("\\", "/");
    const withoutWildcards = normalized.replace(/[.*+?()[\]{}]/g, "").replace(/\/+/g, "/");
    return score + withoutWildcards.length;
  }, 0);
}

function createCompiledRuleFromInstruction(instruction: Instruction, index: number): HallpassRule {
  const text = instruction.text;
  const lower = text.toLowerCase();
  const scopePath = instruction.source.file.replaceAll("\\", "/");
  const baseScope = ["**/*", scopePath, `**/${scopePath}`];
  const classification = instruction.classification === "ambiguous" ? "advisory" : instruction.classification;
  const detection: {
    type: HallpassRule["detector"]["type"];
    title: string;
    enforcement: HallpassRule["enforcement"];
    classification: HallpassRule["classification"];
    scope: { include: string[]; exclude?: string[] };
    paths?: string[];
    imports?: string[];
    command?: string;
    action?: "add" | "remove" | "any";
  } = (() => {
    if (/dependenc/.test(lower)) return { type: "dependency-change", action: "add", title: "Dependency changes require approval", enforcement: "require-approval", classification: "deterministic", scope: { include: baseScope, exclude: ["node_modules/**", "dist/**"] } };
    if (/generated|do not edit|do not modify/.test(lower)) return { type: "generated-file", paths: ["**/*.generated.*", "**/generated/**", "**/*.gen.*"], title: "Generated files are protected", enforcement: "block", classification: "deterministic", scope: { include: baseScope } };
    if (/controller|service|repository|architecture|layer/.test(lower)) return { type: "forbidden-import", imports: ["@prisma/client", "prisma", "typeorm", "sequelize"], title: "Architecture boundaries must be respected", enforcement: "block", classification: "structural", scope: { include: ["src/**/*.ts", "apps/**/*.ts", "libs/**/*.ts"] } };
    if (/typescript.*any|\bany\b/.test(lower)) return { type: "typescript-any", title: "Explicit any is forbidden", enforcement: "warn", classification: "deterministic", scope: { include: ["**/*.ts"] } };
    if (/test|lint|build/.test(lower)) return { type: "required-command", command: lower.includes("lint") ? "npm run lint" : lower.includes("build") ? "npm run build" : "npm test", title: "Required verification command", enforcement: "block", classification: "deterministic", scope: { include: ["src/**", "apps/**", "libs/**"] } };
    if (/file|path|protect|governance|claude|agents|cursor|copilot/.test(lower)) return { type: "protected-file", paths: [scopePath, `**/${scopePath}`], title: "Protected instruction file", enforcement: "block", classification: "deterministic", scope: { include: [scopePath, `**/${scopePath}`] } };
    if (/import|forbidden|must not|never/.test(lower)) return { type: "forbidden-path", paths: [scopePath], title: "Restricted file or path usage", enforcement: "block", classification: "deterministic", scope: { include: baseScope } };
    if (classification === "semantic" || classification === "heuristic" || classification === "advisory") return { type: "protected-file", paths: [scopePath], title: "Semantic guidance should be reviewed", enforcement: "warn", classification, scope: { include: baseScope } };
    return { type: "protected-file", paths: [scopePath], title: "Repository instruction must be honored", enforcement: "audit", classification, scope: { include: baseScope } };
  })();

  const source = {
    type: "generated",
    file: instruction.source.file,
    line: instruction.source.line,
    originalText: text,
    fingerprint: instruction.fingerprint,
  };

  return {
    id: `POL-${String(index + 1).padStart(3, "0")}`,
    title: detection.title,
    description: text,
    rationale: "Compiled from repository instruction source.",
    source,
    classification: detection.classification,
    enforcement: detection.enforcement,
    scope: detection.scope,
    detector: {
      type: detection.type,
      ...(detection.type === "dependency-change" ? { action: detection.action, when: { changed: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"] } } : {}),
      ...(detection.type === "generated-file" ? { paths: detection.paths } : {}),
      ...(detection.type === "forbidden-import" ? { imports: detection.imports } : {}),
      ...(detection.type === "typescript-any" ? {} : {}),
      ...(detection.type === "required-command" ? { command: detection.command } : {}),
      ...(detection.type === "protected-file" || detection.type === "forbidden-path" ? { paths: detection.paths } : {}),
    },
    metadata: { compiledFrom: instruction.source.file, sourceFingerprint: instruction.fingerprint },
  };
}

export async function compilePolicies(root: string): Promise<HallpassRule[]> {
  const instructions = await scanInstructions(root);
  return instructions.map((instruction, index) => createCompiledRuleFromInstruction(instruction, index)).sort((left, right) => {
    const leftSpecificity = specificityFor(left.scope?.include ?? ["**/*"]);
    const rightSpecificity = specificityFor(right.scope?.include ?? ["**/*"]);
    if (left.locked !== right.locked) return Number(Boolean(right.locked)) - Number(Boolean(left.locked));
    return rightSpecificity - leftSpecificity;
  });
}

export function resolveEffectiveRules(rules: HallpassRule[], targetPath: string): HallpassRule[] {
  const normalizedTarget = targetPath.replaceAll("\\", "/");
  return [...rules]
    .filter((rule) => {
      const patterns = rule.scope?.include ?? ["**/*"];
      const exclusions = rule.scope?.exclude ?? [];
      const matchesScope = matchesAny(normalizedTarget, patterns);
      const excluded = exclusions.some((pattern) => matchesAny(normalizedTarget, [pattern]));
      return matchesScope && !excluded;
    })
    .sort((left, right) => {
      if (left.locked !== right.locked) return Number(Boolean(right.locked)) - Number(Boolean(left.locked));
      const leftSpecificity = specificityFor(left.scope?.include ?? ["**/*"]);
      const rightSpecificity = specificityFor(right.scope?.include ?? ["**/*"]);
      if (leftSpecificity !== rightSpecificity) return rightSpecificity - leftSpecificity;
      const weight = { block: 4, "require-approval": 3, warn: 2, audit: 1, allow: 0 } as const;
      return weight[right.enforcement] - weight[left.enforcement];
    });
}

export function duplicates(instructions: Instruction[]): Instruction[][] {
  const groups = new Map<string, Instruction[]>();
  for (const instruction of instructions) {
    const key = instruction.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    groups.set(key, [...(groups.get(key) ?? []), instruction]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

export function sourcesFingerprint(instructions: Instruction[]): string {
  return createHash("sha256").update(instructions.map((item) => item.fingerprint).join(":"), "utf8").digest("hex");
}
