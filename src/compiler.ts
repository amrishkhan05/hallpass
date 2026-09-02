import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, join } from "node:path";
import type { HallpassRule, Instruction, PolicyConflict } from "./core/types.js";
import { VERSION } from "./core/types.js";
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

/**
 * Classify an instruction by confidence level.
 * 
 * DETERMINISTIC: Can be safely translated into machine-enforceable policy
 * with high confidence (explicit paths, imports, commands, or strong polarity + clear target)
 * 
 * STRUCTURAL: Mentions policy-relevant concepts but lacks explicit targets
 * (requires heuristic interpretation)
 * 
 * HEURISTIC: Strong directive but without concrete implementation details
 * 
 * SEMANTIC: Vague guidance that requires semantic understanding
 * 
 * ADVISORY: Recommendations or preferences
 * 
 * AMBIGUOUS: Cannot confidently classify
 */
function classify(text: string): Instruction["classification"] {
  // Strong directive keywords
  const hasStrongPolarity = /\b(never|must not|forbidden|do not|cannot)\b/i.test(text);
  const hasStrongRequirement = /\b(must|always|required)\b/i.test(text);

  // Explicit targets that can be deterministically extracted
  const hasBacktickCommand = /`[^`]*(?:npm|pnpm|yarn|bun|node|git|make)[^`]*`/.test(text);
  const hasExplicitPath = /(?:under|in|inside|beneath|within|under)\s+(?:[\w./\-*]+(?:\/\*\*)?)/i.test(text);
  const hasExplicitImport = /(?:import|from)\s+["'](@?[\w/-]+)["']/.test(text);

  // Explicit phrases that identify commands
  const hasExplicitCommand = /\b(?:run|execute|invoke)\s+(?:the\s+)?(?:command\s+)?(?:`[^`]+`|npm|pnpm|yarn|bun|node|git)/i.test(text);

  // Policy-relevant concepts that make a directive deterministic
  // Use \b at start but not end to match "dependencies", "dependency", etc.
  const hasPolicyTarget = /\b(?:dependenc|import|file|path|command|test|typescript|any|generated)/i.test(text);

  // Imperative verbs that indicate a directive
  const hasImperative = /^(?:use|implement|ensure|adopt|apply|leverage|utilize|integrate|follow)\b/i.test(text);

  // Vague guidance that is hard to enforce
  const hasVagueGuidance = /\b(prefer|consider|recommend|should|ideally|typically|probably)\b/i.test(text);
  const hasVagueConcept = /\b(simple|thin|clean|readable|maintainable|efficient|elegant|pattern|architecture|design)\b/i.test(text);

  // Test for invented policy patterns (what NOT to classify as deterministic)
  const hasInventedScope =
    /\b(keep|maintain|ensure|implement)\b.*\b(thin|simple|clean|readable|architecture)\b/i.test(text) ||
    /\b(use|leverage|utilize)\b.*\b(properly|correctly|appropriately)\b/i.test(text);

  // DETERMINISTIC: Strong directive + explicit, extractable target
  if (hasStrongPolarity && (hasBacktickCommand || hasExplicitCommand)) {
    // "never run npm install without approval"
    return "deterministic";
  }

  if (hasStrongPolarity && hasExplicitImport) {
    // "must not import @prisma/client"
    return "deterministic";
  }

  if (hasStrongPolarity && hasExplicitPath) {
    // "do not modify src/generated/**"
    return "deterministic";
  }

  if (hasStrongRequirement && hasBacktickCommand) {
    // "must run npm run check before completing"
    return "deterministic";
  }

  // DETERMINISTIC: Strong polarity + clear policy target
  // "never add dependencies" → deterministic (means block)
  // "must use TypeScript" → deterministic (means require)
  if ((hasStrongPolarity || hasStrongRequirement) && hasPolicyTarget && !hasInventedScope) {
    return "deterministic";
  }

  // STRUCTURAL: Imperative verb + something that looks like guidance
  // "Use Zod for validation" → structural (directive to use a tool)
  if (hasImperative && !hasStrongPolarity && !hasVagueGuidance) {
    return "structural";
  }

  // SEMANTIC: Guidance requiring semantic interpretation
  if (hasVagueGuidance || (hasVagueConcept && !hasStrongPolarity)) {
    // "keep controllers thin" — requires interpretation
    // "prefer simple architecture" — guidance, not enforcement
    return "semantic";
  }

  if (hasInventedScope) {
    // "ensure proper error handling" — vague directive
    return "semantic";
  }

  // ADVISORY: Pure recommendations
  if (/\b(consider|should|ideally|recommend|perhaps)\b/i.test(text) && !hasStrongPolarity) {
    return "advisory";
  }

  // HEURISTIC: Strong polarity but unclear what to enforce
  if ((hasStrongPolarity || hasStrongRequirement) && !hasPolicyTarget) {
    return "heuristic";
  }

  // AMBIGUOUS: No clear intent
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

export interface NormalizedPolicyIntent {
  subject?: string;
  action?: string;
  target?: string;
  polarity?: "allow" | "deny" | "require";
  scope?: string[];
  condition?: string;
  confidence: number;
}

function extractScope(text: string): string[] | undefined {
  const scopePatterns = [
    /(?:files?\s+)?(?:under|in|inside|beneath)\s+([\w./]+(?:\/\*\*)?)/i,
    /([\w./]+\/\*\*)/,
    /\*\*[\w./]+\*\*/,
  ];
  for (const pattern of scopePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) return [match[1].replaceAll("\\", "/")];
    if (match?.[0]) return [match[0].replaceAll("\\", "/")];
  }
  return undefined;
}

function extractImports(text: string): string[] | undefined {
  const imports: string[] = [];
  const importPatterns = [
    /import\s+["'](@?[\w/-]+)["']/g,
    /from\s+["'](@?[\w/-]+)["']/g,
    /["'](@?[\w/-]+)["']/g,
  ];
  for (const pattern of importPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const pkg = match[1];
      if (pkg && !pkg.startsWith(".") && pkg.includes("/")) imports.push(pkg);
    }
  }
  return imports.length ? [...new Set(imports)] : undefined;
}

/**
 * Extract required command from text with high confidence.
 * Only matches:
 * 1. Commands in backticks: `npm run check`
 * 2. Explicit require phrases: "run npm run check", "execute npm test"
 * 3. Standard "must run X" patterns
 * 
 * Returns undefined if command cannot be extracted with confidence.
 * Does NOT invent commands from vague text like "run tests" without specifying how.
 */
function extractCommand(text: string): string | undefined {
  // Pattern 1: Commands in backticks (highest confidence)
  const backtickMatch = text.match(/`([^`]+(?:npm|pnpm|yarn|bun|node|git|make)[^`]*)`/);
  if (backtickMatch?.[1]) {
    const cmd = backtickMatch[1].trim();
    // Validate it looks like a real command
    if (/^(?:npm|pnpm|yarn|bun|node|git|make)\s/.test(cmd) || /^npm\s+run\s+\w+/.test(cmd)) {
      return cmd;
    }
  }

  // Pattern 2: Explicit "run" or "execute" with command in backticks
  const explicitBacktick = text.match(/\b(?:run|execute|invoke)\s+(?:the\s+)?(?:command\s+)?`([^`]+)`/i);
  if (explicitBacktick?.[1]) {
    return explicitBacktick[1].trim();
  }

  // Pattern 3: Explicit phrases like "run npm run check" or "run npm test"
  const explicitNpm = text.match(/\b(?:run|execute)\s+((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w-]+)/i);
  if (explicitNpm?.[1]) {
    return explicitNpm[1].trim();
  }

  // Pattern 4: "must run npm ...", "should run npm ...", "you must run npm ..."
  const mustRun = text.match(/\b(?:must|should|will)\s+run\s+((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w-]+)/i);
  if (mustRun?.[1]) {
    return mustRun[1].trim();
  }

  // DO NOT match vague patterns like:
  // - "run tests" (which command? npm test? npm run test? jest?)
  // - "run checks" (what checks?)
  // - "run the linter" (eslint? lint-staged?)

  return undefined;
}

function extractGeneratedPaths(text: string): string[] | undefined {
  const pathPatterns = [
    /([\w./]+\/\*\*[\w./]*\.\w+)/g,
    /([\w./]+\/generated\/[\w./]+)/g,
    /\*\*\/[\w*]+\.generated\.\w+/g,
    /\*\*\/generated\/\*\*/g,
  ];
  const paths: string[] = [];
  for (const pattern of pathPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) paths.push(match[1].replaceAll("\\", "/"));
      else if (match[0]) paths.push(match[0].replaceAll("\\", "/"));
    }
  }
  return paths.length ? [...new Set(paths)] : undefined;
}

export function normalizeIntent(instruction: Instruction): NormalizedPolicyIntent {
  const text = instruction.text;
  const lower = text.toLowerCase();
  const scope = extractScope(text);
  const imports = extractImports(text);
  const command = extractCommand(text);
  const generatedPaths = extractGeneratedPaths(text);

  let polarity: "allow" | "deny" | "require" | undefined;
  if (/\b(never|must not|forbidden|do not|cannot)\b/i.test(text)) polarity = "deny";
  else if (/\b(must|always|required|ensure)\b/i.test(text)) polarity = "require";
  else if (/\b(only|exclusively)\b/i.test(text)) polarity = "allow";

  let action: string | undefined;
  if (/\b(add|install|introduce)\b/i.test(lower) && /\bdependenc/.test(lower)) action = "dependency.add";
  else if (/\bimport\b/i.test(lower)) action = "import";
  else if (/\b(run|execute)\b/i.test(lower) && command) action = "command.execute";
  else if (/\b(modify|edit|change|touch|update)\b/i.test(lower)) action = "file.modify";
  else if (/\b(protect|preserve)\b/i.test(lower)) action = "file.protect";

  const target = imports?.[0] ?? command ?? generatedPaths?.[0];
  const confidence = instruction.classification === "deterministic" ? 1 : instruction.classification === "structural" ? 0.7 : instruction.classification === "heuristic" ? 0.5 : instruction.classification === "semantic" ? 0.4 : 0.2;

  return {
    subject: "agent",
    ...(action ? { action } : {}),
    ...(target ? { target } : {}),
    ...(polarity ? { polarity } : {}),
    ...(scope ? { scope } : {}),
    confidence,
  };
}

/**
 * Detect contradictions between instructions.
 * Only reports genuine contradictions with clear evidence.
 * Does NOT speculate about semantic conflicts.
 */
export function conflicts(instructions: Instruction[]): PolicyConflict[] {
  const result: PolicyConflict[] = [];

  for (let left = 0; left < instructions.length; left++) {
    for (let right = left + 1; right < instructions.length; right++) {
      const a = instructions[left];
      const b = instructions[right];
      if (!a || !b) continue;

      // Conflict 1: Explicit dependency ban vs. any instruction to use/require/install something
      const aBansDeps = /\b(?:never|do not|must not)\b.*\b(?:add|install|use)\b.*\bdependenc/i.test(a.text);
      const bUsesSomething = /\b(?:use|install|require|leverage)\b\s+(?:the\s+)?(?:package\s+)?(@?[\w-]+)/i.test(b.text);

      if (aBansDeps && bUsesSomething) {
        // Extract what is being used
        const usedThingMatch = b.text.match(/\b(?:use|install|require|leverage)\b\s+(?:the\s+)?(?:package\s+)?(@?[\w-]+)/i);
        const usedThing = usedThingMatch?.[usedThingMatch.length - 1] ?? "a package";
        result.push({
          ruleA: a,
          ruleB: b,
          reason: `Instruction A forbids adding dependencies, but instruction B requires using ${usedThing}.`,
          confidence: "exact",
        });
        continue;
      }

      const bBansDeps = /\b(?:never|do not|must not)\b.*\b(?:add|install|use)\b.*\bdependenc/i.test(b.text);
      const aUsesSomething = /\b(?:use|install|require|leverage)\b\s+(?:the\s+)?(?:package\s+)?(@?[\w-]+)/i.test(a.text);

      if (bBansDeps && aUsesSomething) {
        const usedThingMatch = a.text.match(/\b(?:use|install|require|leverage)\b\s+(?:the\s+)?(?:package\s+)?(@?[\w-]+)/i);
        const usedThing = usedThingMatch?.[usedThingMatch.length - 1] ?? "a package";
        result.push({
          ruleA: a,
          ruleB: b,
          reason: `Instruction A requires using ${usedThing}, but instruction B forbids adding dependencies.`,
          confidence: "exact",
        });
        continue;
      }

      // Conflict 2: File protection vs. required modification
      const aProtects = /\b(?:do not|must not|never)\b.*\b(?:modify|edit|change|touch)\b/i.test(a.text);
      const bModifies = /\b(?:modify|update|change|edit)\b.*file|must.*edit/i.test(b.text);
      const aPath = extractScope(a.text)?.[0];
      const bPath = extractScope(b.text)?.[0];
      if (aProtects && bModifies && aPath && bPath && aPath === bPath) {
        result.push({
          ruleA: a,
          ruleB: b,
          reason: "Instruction A protects a file from modification, but instruction B requires modifying the same file.",
          confidence: "exact",
        });
        continue;
      }

      // Conflict 3: Import restriction vs. import requirement
      const aForbidsImport = /\b(?:must not|cannot|never)\b.*\bimport\b/i.test(a.text);
      const bRequiresImport = /\b(?:must|should|require)\b.*\bimport\b/i.test(b.text);
      const aImports = extractImports(a.text);
      const bImports = extractImports(b.text);
      if (aForbidsImport && bRequiresImport && aImports?.length && bImports?.length) {
        const hasCommon = aImports.some((imp) => bImports.includes(imp));
        if (hasCommon) {
          result.push({
            ruleA: a,
            ruleB: b,
            reason: `Instruction A forbids importing ${aImports.join(", ")}, but instruction B requires importing ${bImports.join(", ")}.`,
            confidence: "exact",
          });
          continue;
        }
      }

      // Conflict 4: Explicit allow vs. explicit deny on same target
      const aAllows = /\b(?:always|must|required|ensure)\b/i.test(a.text) && !/\b(?:never|must not|forbidden)\b/i.test(a.text);
      const bDenies = /\b(?:never|must not|forbidden|do not)\b/i.test(b.text);
      const aNorm = normalizeIntent(a);
      const bNorm = normalizeIntent(b);
      if (aAllows && bDenies && aNorm.action && bNorm.action && aNorm.action === bNorm.action && aNorm.target === bNorm.target) {
        result.push({
          ruleA: a,
          ruleB: b,
          reason: `Instruction A requires ${aNorm.action} on ${aNorm.target}, but instruction B forbids it.`,
          confidence: "possible",
        });
        continue;
      }
    }
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

/**
 * Create a compiled rule from instruction with conservative policy.
 * 
 * Core principle: Never invent policy that the instruction doesn't explicitly state.
 * If classification is DETERMINISTIC, create an enforceable rule.
 * If classification is SEMANTIC/ADVISORY/AMBIGUOUS, create a non-blocking audit/advisory rule.
 */
function createCompiledRuleFromInstruction(instruction: Instruction, id: string, compiledAt: string): HallpassRule {
  const text = instruction.text;
  const lower = text.toLowerCase();
  const scopePath = instruction.source.file.replaceAll("\\", "/");
  const directory = scopePath.includes("/") ? scopePath.slice(0, scopePath.lastIndexOf("/")) : "";
  const baseScope = [directory ? `${directory}/**` : "**/*"];
  const classification = instruction.classification;

  const extractedScope = extractScope(text);
  const extractedImports = extractImports(text);
  const extractedCommand = extractCommand(text);
  const extractedGeneratedPaths = extractGeneratedPaths(text);

  // For DETERMINISTIC instructions, create enforcement rules
  if (classification === "deterministic") {
    // DETERMINISTIC dependency restriction
    // "never add dependencies" → block
    // "new dependencies require approval" → require-approval
    // "must use TypeScript" → require-approval (requires approval to NOT use it)
    if (/\bdependenc/.test(lower)) {
      const hasBanPattern = /\b(never|must not|forbidden|do not|cannot)\b/i.test(text);
      const hasApprovalPattern = /approval|approved|approv/i.test(lower);
      const hasRequirePattern = /\b(must|required|ensure|use)\b/i.test(text);

      let enforcement: "block" | "require-approval" = "block"; // default
      if (hasApprovalPattern) enforcement = "require-approval";
      if (hasRequirePattern && !hasBanPattern) enforcement = "require-approval"; // requiring a dep needs approval too

      const scope = extractedScope ?? baseScope;
      const action = hasBanPattern || hasApprovalPattern ? "add" : (hasRequirePattern ? "any" : "add");

      return {
        id,
        title: enforcement === "require-approval"
          ? "New dependencies require approval"
          : "New dependencies are forbidden",
        description: text,
        rationale: "Compiled from repository instruction.",
        source: {
          type: "generated",
          file: instruction.source.file,
          line: instruction.source.line,
          originalText: text,
          fingerprint: instruction.fingerprint,
          compilerVersion: VERSION,
          compiledAt,
        },
        classification: "deterministic",
        enforcement,
        scope: { include: scope, exclude: ["node_modules/**", "dist/**"] },
        detector: {
          type: "dependency-change",
          action: action as "add" | "remove" | "any",
          when: { changed: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"] },
        },
      };
    }

    // DETERMINISTIC import restriction
    if (/\b(?:must not|cannot|never|forbidden)\b.*\bimport\b/i.test(lower) && extractedImports?.length) {
      return {
        id,
        title: `Forbidden import: ${extractedImports.join(", ")}`,
        description: text,
        rationale: "Compiled from repository instruction.",
        source: {
          type: "generated",
          file: instruction.source.file,
          line: instruction.source.line,
          originalText: text,
          fingerprint: instruction.fingerprint,
          compilerVersion: VERSION,
          compiledAt,
        },
        classification: "deterministic",
        enforcement: "block",
        scope: { include: extractedScope ?? ["src/**/*.ts", "apps/**/*.ts", "libs/**/*.ts"] },
        detector: {
          type: "forbidden-import",
          imports: extractedImports,
        },
      };
    }

    // DETERMINISTIC file protection (e.g., "do not modify src/generated/**")
    if (extractedGeneratedPaths && /\b(?:do not|must not|cannot|never)\b.*\b(?:edit|modify|change|touch)\b/i.test(lower)) {
      return {
        id,
        title: `Protected file(s): ${extractedGeneratedPaths.join(", ")}`,
        description: text,
        rationale: "Compiled from repository instruction.",
        source: {
          type: "generated",
          file: instruction.source.file,
          line: instruction.source.line,
          originalText: text,
          fingerprint: instruction.fingerprint,
          compilerVersion: VERSION,
          compiledAt,
        },
        classification: "deterministic",
        enforcement: "block",
        scope: { include: extractedScope ?? baseScope },
        detector: {
          type: "protected-file",
          paths: extractedGeneratedPaths,
        },
      };
    }

    // DETERMINISTIC required command (completion gate)
    if (extractedCommand && /\b(?:must|before|after)\b.*\b(?:run|execute)\b/i.test(lower)) {
      return {
        id,
        title: `Required: ${extractedCommand}`,
        description: text,
        rationale: "Compiled from repository instruction.",
        source: {
          type: "generated",
          file: instruction.source.file,
          line: instruction.source.line,
          originalText: text,
          fingerprint: instruction.fingerprint,
          compilerVersion: VERSION,
          compiledAt,
        },
        classification: "deterministic",
        enforcement: "require-approval", // Completion gate: human must acknowledge
        scope: { include: extractedScope ?? ["src/**", "apps/**", "libs/**"] },
        detector: {
          type: "required-command",
          command: extractedCommand,
        },
      };
    }

    // DETERMINISTIC typescript/linting restrictions
    if (/\bexplicit.*any\b|\bany\b.*forbidden/i.test(lower)) {
      return {
        id,
        title: "Explicit `any` is forbidden",
        description: text,
        rationale: "Compiled from repository instruction.",
        source: {
          type: "generated",
          file: instruction.source.file,
          line: instruction.source.line,
          originalText: text,
          fingerprint: instruction.fingerprint,
          compilerVersion: VERSION,
          compiledAt,
        },
        classification: "deterministic",
        enforcement: "warn",
        scope: { include: extractedScope ?? ["**/*.ts"] },
        detector: {
          type: "typescript-any",
        },
      };
    }
  }

  // For STRUCTURAL instructions, create audit/warn rules
  // (e.g., "never add dependencies" without specifying approval)
  if (classification === "structural") {
    if (/\bdependenc/.test(lower) && /\b(?:add|never|forbidden)\b/i.test(lower)) {
      return {
        id,
        title: "Dependency modification detected (scope unclear)",
        description: text,
        rationale: "Compiled from repository instruction.",
        source: {
          type: "generated",
          file: instruction.source.file,
          line: instruction.source.line,
          originalText: text,
          fingerprint: instruction.fingerprint,
          compilerVersion: VERSION,
          compiledAt,
        },
        classification: "structural",
        enforcement: "warn", // Non-blocking, requires human review
        scope: { include: baseScope },
        detector: {
          type: "dependency-change",
          action: "any",
        },
      };
    }

    if (/\bimport\b/i.test(lower) && !extractedImports) {
      return {
        id,
        title: "Import guidance (specific imports unclear)",
        description: text,
        rationale: "Compiled from repository instruction.",
        source: {
          type: "generated",
          file: instruction.source.file,
          line: instruction.source.line,
          originalText: text,
          fingerprint: instruction.fingerprint,
          compilerVersion: VERSION,
          compiledAt,
        },
        classification: "structural",
        enforcement: "audit",
        scope: { include: baseScope },
        detector: {
          type: "forbidden-import",
          imports: [],
        },
      };
    }

    if (/generated/i.test(lower)) {
      return {
        id,
        title: "Generated file guidance",
        description: text,
        rationale: "Compiled from repository instruction.",
        source: {
          type: "generated",
          file: instruction.source.file,
          line: instruction.source.line,
          originalText: text,
          fingerprint: instruction.fingerprint,
          compilerVersion: VERSION,
          compiledAt,
        },
        classification: "structural",
        enforcement: "audit",
        scope: { include: baseScope },
        detector: {
          type: "protected-file",
          paths: [scopePath],
        },
      };
    }

    // Catch-all for STRUCTURAL: directive to use/implement something
    // e.g., "Use Zod for request validation"
    return {
      id,
      title: `Guidance: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`,
      description: text,
      rationale: "Compiled from repository instruction.",
      source: {
        type: "generated",
        file: instruction.source.file,
        line: instruction.source.line,
        originalText: text,
        fingerprint: instruction.fingerprint,
        compilerVersion: VERSION,
        compiledAt,
      },
      classification: "structural",
      enforcement: "audit",
      scope: { include: baseScope },
      detector: {
        type: "protected-file",
        paths: [scopePath],
      },
    };
  }

  // For SEMANTIC and ADVISORY instructions, create audit-only rules
  // These provide context without blocking
  if (classification === "semantic" || classification === "advisory") {
    return {
      id,
      title: "Guidance: review instruction source",
      description: text,
      rationale: "Compiled from repository instruction requiring semantic interpretation.",
      source: {
        type: "generated",
        file: instruction.source.file,
        line: instruction.source.line,
        originalText: text,
        fingerprint: instruction.fingerprint,
        compilerVersion: VERSION,
        compiledAt,
      },
      classification,
      enforcement: "audit",
      scope: { include: baseScope },
      detector: {
        type: "protected-file",
        paths: [scopePath],
      },
    };
  }

  // For AMBIGUOUS, don't create an enforcement rule at all
  // Let the instruction be discovered by `hallpass scan` but don't enforce it
  return {
    id,
    title: "Ambiguous instruction (requires clarification)",
    description: text,
    rationale: "Compiled from repository instruction but classification is ambiguous.",
    source: {
      type: "generated",
      file: instruction.source.file,
      line: instruction.source.line,
      originalText: text,
      fingerprint: instruction.fingerprint,
      compilerVersion: VERSION,
      compiledAt,
    },
    classification: "ambiguous",
    enforcement: "allow", // Non-enforcing, informational only
    scope: { include: baseScope },
    detector: {
      type: "protected-file",
      paths: [scopePath],
    },
  };
}

export async function compilePolicies(root: string): Promise<HallpassRule[]> {
  const instructions = await scanInstructions(root);
  const compiledAt = new Date().toISOString();
  const counts = new Map<string, number>();

  const prefix = (instruction: Instruction): string => {
    if (/\bdependenc/.test(instruction.text)) return "DEP";
    if (/\bimport\b/.test(instruction.text)) return "ARCH";
    if (/\bgenerated\b/.test(instruction.text)) return "GEN";
    if (/(?:npm|pnpm|yarn|bun|node).*(?:run|execute)/.test(instruction.text)) return "VAL";
    if (/typescript|\bany\b/.test(instruction.text)) return "TS";
    return "POL";
  };

  const rules = instructions.map((instruction) => {
    const key = prefix(instruction);
    const number = (counts.get(key) ?? 0) + 1;
    counts.set(key, number);
    return createCompiledRuleFromInstruction(instruction, `${key}-${String(number).padStart(3, "0")}`, compiledAt);
  });

  // Filter out allow/audit-only rules (non-enforcing) and sort by enforcement strength
  return rules
    .filter((rule) => rule.enforcement !== "allow")  // Keep audit, warn, require-approval, block
    .sort((left, right) => {
      // Locked rules first
      if (left.locked !== right.locked) return Number(Boolean(right.locked)) - Number(Boolean(left.locked));

      // More specific scope first
      const leftSpecificity = specificityFor(left.scope?.include ?? ["**/*"]);
      const rightSpecificity = specificityFor(right.scope?.include ?? ["**/*"]);
      if (leftSpecificity !== rightSpecificity) return rightSpecificity - leftSpecificity;

      // Stronger enforcement first
      const weight = { block: 4, "require-approval": 3, warn: 2, audit: 1, allow: 0 } as const;
      return weight[right.enforcement] - weight[left.enforcement];
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
