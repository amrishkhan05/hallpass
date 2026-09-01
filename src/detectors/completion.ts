import { exec } from "node:child_process";
import { promisify } from "node:util";
import { matchesAny } from "../utils.js";
import type { Detection, DetectorContext } from "./types.js";

const run = promisify(exec);
export async function detectRequiredCommand({ rule, files, changes }: DetectorContext): Promise<Detection[]> {
  if (rule.detector.when?.changed?.length && !files.some((file) => matchesAny(file.path, rule.detector.when?.changed))) return [];
  if (!rule.detector.command) return [];
  try { await run(rule.detector.command, { cwd: changes.root, maxBuffer: 20 * 1024 * 1024 }); return []; }
  catch (error) { return [{ category: "completion.tests_missing", message: `${rule.title}: command failed.`, evidence: { command: rule.detector.command, output: String((error as { stderr?: string }).stderr ?? "").slice(-2000) }, remediation: `Run: ${rule.detector.command}` }]; }
}
