export const VERSION = "0.1.4";
export const EXIT = { PASS: 0, VIOLATION: 1, CONFIG: 2, INTERNAL: 3, APPROVAL: 4, CONFLICT: 5 } as const;

export type Classification = "deterministic" | "structural" | "heuristic" | "semantic" | "advisory";
export type EnforcementProfile = "advisory" | "balanced" | "strict" | "lockdown";
export type Decision = "allow" | "audit" | "warn" | "require-approval" | "block";
export type DetectorType =
  | "protected-file" | "forbidden-path" | "generated-file" | "dependency-change"
  | "forbidden-dependency" | "forbidden-import" | "required-import" | "typescript-any" | "ts-ignore"
  | "eslint-disable" | "test-deletion" | "required-command" | "max-changed-files"
  | "max-changed-loc" | "governance-modification" | "shell-command";

export interface RuleSource { type: string; file?: string; line?: number; originalText?: string; fingerprint?: string; compilerVersion?: string; compiledAt?: string }
export interface RuleScope { include?: string[]; exclude?: string[] }
export interface DetectorConfig {
  type: DetectorType;
  paths?: string[];
  imports?: string[];
  packages?: string[];
  action?: "add" | "remove" | "any";
  command?: string;
  commands?: string[];
  limit?: number;
  when?: { changed?: string[] };
}
export interface HallpassRule {
  id: string;
  title: string;
  description?: string;
  rationale?: string;
  source?: RuleSource;
  classification: Classification;
  enforcement: Decision;
  scope?: RuleScope;
  detector: DetectorConfig;
  owner?: string;
  locked?: boolean;
  metadata?: Record<string, unknown>;
}
export interface HallpassConfig {
  version: 1;
  profile: EnforcementProfile;
  persona: { enabled: boolean; intensity: 0 | 1 | 2 | 3 };
  sources: string[];
  conflicts: { behavior: "warn" | "block" };
  overrides: { enabled: boolean; requireReason: boolean };
  governance: { protect: string[] };
  rules: HallpassRule[];
}
export interface DiffLine { line: number; text: string }
export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  additions: DiffLine[];
  deletions: DiffLine[];
}
export interface GitChangeSet { root: string; baseline: string; files: ChangedFile[] }
export interface Violation {
  id: string;
  ruleId: string;
  decision: Exclude<Decision, "allow">;
  classification: Classification;
  message: string;
  category: string;
  source?: { file?: string; line?: number; instruction?: string };
  location?: { file: string; line?: number; column?: number };
  evidence?: unknown;
  expected?: string;
  remediation?: string;
  fingerprint: string;
}
export interface HallpassReport {
  schemaVersion: 1;
  version: string;
  status: "pass" | "warn" | "fail" | "error";
  evaluatedRules: number;
  violations: Violation[];
  warnings: Violation[];
  metadata: { durationMs: number; adapter?: string; baseline?: string; policyHash?: string; configurationHash?: string };
}
export interface Instruction {
  text: string;
  source: { file: string; line: number };
  classification: Classification | "ambiguous";
  fingerprint: string;
}
export interface PolicyConflict { ruleA: Instruction; ruleB: Instruction; reason: string; confidence: "possible" | "exact" }
export interface BaseEvent { id: string; type: string; timestamp: string; adapter: string; sessionId?: string; workingDirectory: string; metadata?: Record<string, unknown> }
export interface ShellActionEvent extends BaseEvent { type: "shell.action"; command: string }
export type HallpassEvent = BaseEvent | ShellActionEvent;
export interface AdapterCapabilities { instructionScan: boolean; preActionGuard: boolean | "partial"; shellGuard: boolean | "partial"; diffVerification: boolean; completionGate: boolean | "partial"; approvalIntegration: boolean | "partial" }
