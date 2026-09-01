import type { ChangedFile, HallpassConfig, HallpassReport, HallpassRule, Violation } from "./core/types.js";
import { VERSION } from "./core/types.js";
import { approvals, isApproved } from "./approvals.js";
import { defaultGovernance } from "./config.js";
import { detectors, type Detection } from "./detectors/index.js";
import type { DiffOptions } from "./git.js";
import { gitChanges } from "./git.js";
import { fingerprint, matchesAny } from "./utils.js";

function scoped(rule: HallpassRule, file: ChangedFile): boolean {
  return (!rule.scope?.include?.length || matchesAny(file.path, rule.scope.include)) && (!rule.scope?.exclude?.length || !matchesAny(file.path, rule.scope.exclude));
}

function violation(rule: HallpassRule, detection: Detection): Violation {
  const id = fingerprint(rule.id, detection.file?.path, detection.line, detection.category, detection.evidence);
  const source = rule.source ? { ...(rule.source.file ? { file: rule.source.file } : {}), ...(rule.source.line ? { line: rule.source.line } : {}), ...(rule.source.originalText ? { instruction: rule.source.originalText } : {}) } : undefined;
  return {
    id,
    ruleId: rule.id,
    decision: rule.enforcement === "allow" ? "audit" : rule.enforcement,
    classification: rule.classification,
    message: detection.message,
    category: detection.category,
    ...(source ? { source } : {}),
    ...(detection.file ? { location: { file: detection.file.path, ...(detection.line ? { line: detection.line } : {}) } } : {}),
    ...(detection.evidence !== undefined ? { evidence: detection.evidence } : {}),
    ...(detection.remediation ? { remediation: detection.remediation } : {}),
    fingerprint: id,
  };
}

export async function evaluate(root: string, config: HallpassConfig, options: DiffOptions = {}): Promise<HallpassReport> {
  const started = performance.now();
  const changes = await gitChanges(root, options);
  const approvalList = await approvals(root);
  const governance: HallpassRule = { id: "GOV-001", title: "Governance files require human approval", classification: "deterministic", enforcement: "require-approval", locked: true, detector: { type: "governance-modification", paths: config.governance.protect.length ? config.governance.protect : defaultGovernance } };
  const rules = [governance, ...config.rules.filter((rule) => rule.enforcement !== "allow")];
  const findings: Violation[] = [];
  for (const rule of rules) {
    const detector = detectors[rule.detector.type];
    if (!detector) continue;
    const files = changes.files.filter((file) => scoped(rule, file));
    for (const detection of await detector({ root, rule, changes, files, options })) {
      const finding = violation(rule, detection);
      if (!isApproved(approvalList, rule.id, finding.location?.file)) findings.push(finding);
    }
  }
  const violations = findings.filter((item) => item.decision === "block" || item.decision === "require-approval");
  const warnings = findings.filter((item) => item.decision === "warn" || item.decision === "audit");
  return { version: VERSION, status: violations.length ? "fail" : warnings.length ? "warn" : "pass", evaluatedRules: rules.length, violations, warnings, metadata: { durationMs: Math.round(performance.now() - started), baseline: changes.baseline } };
}
