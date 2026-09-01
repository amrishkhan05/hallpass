import { fileAt } from "../git.js";
import type { Detection, DetectorContext } from "./types.js";

function packages(text?: string): Set<string> {
  if (!text) return new Set();
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return new Set(Object.keys({ ...value.dependencies as object, ...value.devDependencies as object, ...value.peerDependencies as object, ...value.optionalDependencies as object }));
  } catch { return new Set(); }
}

export async function detectDependencies({ rule, files, changes, options }: DetectorContext): Promise<Detection[]> {
  const detections: Detection[] = [];
  for (const file of files.filter((item) => /(^|\/)package\.json$/.test(item.path))) {
    const before = packages(await fileAt(changes.root, file.path, "before", options));
    const after = packages(await fileAt(changes.root, file.path, "after", options));
    const added = [...after].filter((name) => !before.has(name));
    const removed = [...before].filter((name) => !after.has(name));
    const candidates = rule.detector.type === "forbidden-dependency" ? added.filter((name) => rule.detector.packages?.includes(name)) : rule.detector.action === "remove" ? removed : rule.detector.action === "any" ? [...added, ...removed] : added;
    for (const name of candidates) detections.push({ category: rule.detector.type === "forbidden-dependency" ? "dependency.forbidden" : "dependency.unapproved", message: `${rule.title}: ${name}.`, file, evidence: { package: name, action: removed.includes(name) ? "remove" : "add" }, remediation: "Remove the dependency or obtain approval." });
  }
  return detections;
}
