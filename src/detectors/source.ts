import type { Detection, DetectorContext } from "./types.js";
import { fileAt } from "../git.js";

export function detectTypeScript({ rule, files }: DetectorContext): Detection[] {
  const pattern = rule.detector.type === "typescript-any" ? /(?::\s*any\b|\bas\s+any\b|<any>)/ : rule.detector.type === "ts-ignore" ? /@ts-ignore/ : /eslint-disable/;
  return files.flatMap((file) => file.additions.filter((line) => pattern.test(line.text)).map((line) => ({ category: rule.detector.type.replaceAll("-", "."), message: rule.title, file, line: line.line, evidence: line.text.trim(), remediation: "Remove the suppression or use a policy-compliant type." })));
}

export function detectImports({ rule, files }: DetectorContext): Detection[] {
  const detections: Detection[] = [];
  for (const file of files) for (const line of file.additions) for (const denied of rule.detector.imports ?? []) {
    if (line.text.includes(`from "${denied}`) || line.text.includes(`from '${denied}`) || line.text.includes(`require("${denied}`) || line.text.includes(`require('${denied}`)) detections.push({ category: "architecture.layer_violation", message: `${rule.title}: forbidden import ${denied}.`, file, line: line.line, evidence: line.text.trim(), remediation: "Route the dependency through an allowed layer." });
  }
  return detections;
}

export async function detectRequiredImports({ rule, files, changes, options }: DetectorContext): Promise<Detection[]> {
  const detections: Detection[] = [];
  for (const file of files) {
    const content = await fileAt(changes.root, file.path, "after", options) ?? "";
    for (const required of rule.detector.imports ?? []) if (!content.includes(required)) detections.push({ category: "architecture.required_import", message: `${rule.title}: missing import ${required}.`, file, evidence: { required }, remediation: `Import ${required}.` });
  }
  return detections;
}
