import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HallpassReport } from "./core/types.js";
import { fingerprint } from "./utils.js";

export async function recordAudit(root: string, report: HallpassReport, adapter = "generic"): Promise<void> {
  const directory = join(root, ".hallpass", "audit");
  await mkdir(directory, { recursive: true });
  const findings = [...report.violations, ...report.warnings];
  const entries = findings.length ? findings.map((item) => ({
    timestamp: new Date().toISOString(), agent: adapter, adapter, action: "diff.check", decision: item.decision,
    ruleId: item.ruleId, classification: item.classification, enforcement: item.decision,
    ...(item.location?.file ? { file: item.location.file } : {}), ...(item.location?.line ? { line: item.location.line } : {}),
    evidence: item.evidence, evidenceHash: fingerprint(item.evidence),
    ...(item.source?.instruction ? { sourceInstruction: item.source.instruction } : {}), ...(item.source?.file ? { sourceFile: item.source.file } : {}), ...(item.source?.line ? { sourceLine: item.source.line } : {}),
    policyHash: report.metadata.policyHash, configurationHash: report.metadata.configurationHash, baseline: report.metadata.baseline, hallpassVersion: report.version,
  })) : [{ timestamp: new Date().toISOString(), agent: adapter, adapter, action: "diff.check", decision: "allow", policyHash: report.metadata.policyHash, configurationHash: report.metadata.configurationHash, baseline: report.metadata.baseline, hallpassVersion: report.version }];
  await appendFile(join(directory, "events.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

export async function readAudit(root: string): Promise<string> {
  return readFile(join(root, ".hallpass", "audit", "events.jsonl"), "utf8").catch(() => "");
}
