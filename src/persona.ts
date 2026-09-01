import type { HallpassConfig, HallpassReport, Violation } from "./core/types.js";

const comments: Record<string, string[]> = {
  "generated.file": ["You modified a generated file. The word \"generated\" was admittedly subtle."],
  "generated.file.modified": ["Generated file. Manually edited. Let's think about those two phrases for a moment."],
  "dependency.unapproved": ["Approval found: none. Confidence: remarkable.", "I'm going to need a hall pass for that."],
  "dependency.forbidden": ["We wrote this down. Still no."],
  "typescript.any": ["Ah, `any`. TypeScript stopped asking questions. Unfortunately, I haven't."],
  "ts.ignore": ["TypeScript raised an objection. You removed TypeScript from the conversation."],
  "eslint.disable": ["If the alarm is annoying, remove the batteries. Interesting."],
  "architecture.layer_violation": ["You appear to have misplaced the service layer. I found it. Please use it."],
  "scope.excessive": ["Ambitious."],
  "test.deleted": ["Software does become easier to verify when you stop checking it. Denied."],
  "completion.tests_missing": ["The agent does not decide when the work is done. The repository does."],
  "governance.modification": ["Active policy cannot authorize modification of itself."],
  "protected.file": ["And where exactly do you think you're going?"],
  "forbidden.path": ["That's quite literally what the rule says not to do."],
};

export function selectComment(category: string, fingerprint: string): string {
  const choices = comments[category] ?? ["The rule is fairly explicit about this."];
  const seed = [...fingerprint].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return choices[seed % choices.length] ?? choices[0] ?? "Policy violation.";
}

function renderViolation(item: Violation, intensity: number): string {
  const lines = [`${item.ruleId}  ${item.message}`];
  if (item.source?.file) lines.push(`Rule: ${item.source.file}${item.source.line ? `:${item.source.line}` : ""}`);
  if (item.location) lines.push(`File: ${item.location.file}${item.location.line ? `:${item.location.line}` : ""}`);
  if (item.evidence !== undefined) lines.push(`Evidence: ${typeof item.evidence === "string" ? item.evidence : JSON.stringify(item.evidence)}`);
  if (item.remediation) lines.push(`Remediation: ${item.remediation}`);
  if (intensity > 0) lines.push(selectComment(item.category, item.fingerprint));
  return lines.join("\n");
}

export function renderReport(report: HallpassReport, config: HallpassConfig, noPersona = false): string {
  const intensity = noPersona || !config.persona.enabled ? 0 : config.persona.intensity;
  const findings = [...report.violations, ...report.warnings];
  const severe = report.violations.some((item) => item.category === "governance.modification");
  const status = report.status === "pass" ? "PASS GRANTED ✓" : severe ? "PRINCIPAL'S OFFICE" : report.violations.length > 1 ? "DETENTION" : report.violations.length ? "HALLPASS DENIED ✗" : "WARNINGS";
  const body = findings.length ? findings.map((item) => renderViolation(item, intensity)).join("\n\n") : `${report.evaluatedRules} policies checked. No violations found.`;
  return `HALLPASS\n\n${body}\n\n${status}`;
}
