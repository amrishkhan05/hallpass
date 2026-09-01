import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HallpassReport } from "./core/types.js";
import { fingerprint } from "./utils.js";

export async function recordAudit(root: string, report: HallpassReport, adapter = "generic"): Promise<void> {
  const directory = join(root, ".hallpass", "audit");
  await mkdir(directory, { recursive: true });
  const entries = [...report.violations, ...report.warnings].map((item) => ({ timestamp: new Date().toISOString(), hallpassVersion: report.version, ruleId: item.ruleId, decision: item.decision, evidenceHash: fingerprint(item.evidence), baseline: report.metadata.baseline, adapter }));
  if (entries.length) await appendFile(join(directory, "events.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

export async function readAudit(root: string): Promise<string> {
  return readFile(join(root, ".hallpass", "audit", "events.jsonl"), "utf8").catch(() => "");
}
