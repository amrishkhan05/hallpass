import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanInstructions } from "./compiler.js";

export type PolicyState = "CONFIGURED" | "INFERRED" | "UNCONFIGURED";
export interface AgentSuggestion {
  text: string;
  origin: "repository-derived" | "hallpass-recommended" | "existing-policy";
  evidence: { file: string; path?: string; line?: number };
  confidence: "deterministic" | "structural" | "recommendation";
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
}

export async function agentsFileExists(root: string): Promise<boolean> {
  return exists(join(root, "AGENTS.md"));
}

export async function policyConfigPath(root: string): Promise<string | undefined> {
  for (const name of ["hallpass.config.yml", ".hallpass.yml"]) if (await exists(join(root, name))) return name;
}

export async function policyState(root: string): Promise<PolicyState> {
  if (await policyConfigPath(root)) return "CONFIGURED";
  return (await scanInstructions(root)).length ? "INFERRED" : "UNCONFIGURED";
}

export async function suggestAgents(root: string): Promise<AgentSuggestion[]> {
  const suggestions: AgentSuggestion[] = [];
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    if (typeof pkg.scripts?.check === "string") suggestions.push({
      text: "Run `npm run check` before completing a task.",
      origin: "repository-derived",
      evidence: { file: "package.json", path: "scripts.check" },
      confidence: "deterministic",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  suggestions.push({
    text: "Require approval before adding dependencies.",
    origin: "hallpass-recommended",
    evidence: { file: "Hallpass built-in recommendation" },
    confidence: "recommendation",
  });
  return suggestions;
}

export function renderStarter(suggestions: AgentSuggestion[]): string {
  return `# Agent Instructions\n\n## Repository rules\n\n${suggestions.map((item) => `- ${item.text}`).join("\n")}\n`;
}

export async function writeStarter(root: string, suggestions: AgentSuggestion[], force = false): Promise<{ created: boolean; path: string; overwritten: boolean; suggestionCount: number }> {
  const path = join(root, "AGENTS.md");
  const present = await agentsFileExists(root);
  if (present && !force) return { created: false, path: "AGENTS.md", overwritten: false, suggestionCount: suggestions.length };
  await writeFile(path, renderStarter(suggestions), { flag: force ? "w" : "wx" });
  return { created: true, path: "AGENTS.md", overwritten: present, suggestionCount: suggestions.length };
}
