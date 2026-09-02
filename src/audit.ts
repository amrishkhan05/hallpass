import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HallpassReport } from "./core/types.js";
import { fingerprint } from "./utils.js";

export type AuditAction =
  | "diff.check"
  | "completion.gate"
  | "shell.execute"
  | "file.write"
  | "file.delete"
  | "dependency.add"
  | "dependency.remove"
  | "approval.granted"
  | "approval.consumed"
  | "policy.sync"
  | "policy.conflict"
  | "governance.violation"
  | "watch.check";

export interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  agent: string;
  sessionId?: string;
  decision: string;
  ruleId?: string;
  classification?: string;
  file?: string;
  line?: number;
  evidence?: unknown;
  evidenceHash?: string;
  sourceInstruction?: string;
  sourceFile?: string;
  sourceLine?: number;
  policyHash?: string;
  configurationHash?: string;
  baseline?: string;
  hallpassVersion?: string;
  approvalId?: string;
}

export function adapterToAuditAction(adapter: string): AuditAction {
  switch (adapter) {
    case "ci": return "diff.check";
    case "completion-gate": return "completion.gate";
    case "watch": return "watch.check";
    default: return "diff.check";
  }
}

export async function recordAudit(root: string, report: HallpassReport, adapter = "generic"): Promise<void> {
  const directory = join(root, ".hallpass", "audit");
  await mkdir(directory, { recursive: true });
  const action = adapterToAuditAction(adapter);
  const findings = [...report.violations, ...report.warnings];
  const metadata = report.metadata;
  const buildEntry = (item: { ruleId: string; decision: string; classification: string; location?: { file?: string; line?: number }; source?: { file?: string; line?: number; instruction?: string }; evidence?: unknown }): AuditEntry => ({
    timestamp: new Date().toISOString(),
    action: item.ruleId === "GOV-001" ? "governance.violation" : action,
    agent: adapter,
    decision: item.decision,
    ruleId: item.ruleId,
    classification: item.classification,
    ...(item.location?.file ? { file: item.location.file } : {}),
    ...(item.location?.line ? { line: item.location.line } : {}),
    evidence: item.evidence,
    evidenceHash: fingerprint(item.evidence),
    ...(item.source?.instruction ? { sourceInstruction: item.source.instruction } : {}),
    ...(item.source?.file ? { sourceFile: item.source.file } : {}),
    ...(item.source?.line ? { sourceLine: item.source.line } : {}),
    ...(metadata.policyHash ? { policyHash: metadata.policyHash } : {}),
    ...(metadata.configurationHash ? { configurationHash: metadata.configurationHash } : {}),
    ...(metadata.baseline ? { baseline: metadata.baseline } : {}),
    hallpassVersion: report.version,
  });
  const entries: AuditEntry[] = findings.length ? findings.map(buildEntry) : [{
    timestamp: new Date().toISOString(),
    action,
    agent: adapter,
    decision: "allow",
    ...(metadata.policyHash ? { policyHash: metadata.policyHash } : {}),
    ...(metadata.configurationHash ? { configurationHash: metadata.configurationHash } : {}),
    ...(metadata.baseline ? { baseline: metadata.baseline } : {}),
    hallpassVersion: report.version,
  }];
  await appendFile(join(directory, "events.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

export async function readAudit(root: string): Promise<string> {
  return readFile(join(root, ".hallpass", "audit", "events.jsonl"), "utf8").catch(() => "");
}
