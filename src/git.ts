import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, GitChangeSet } from "./core/types.js";

const exec = promisify(execFile);
export interface DiffOptions { staged?: boolean; commit?: string; base?: string }

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  try { return (await exec("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 })).stdout; }
  catch (error) { if (allowFailure) return ""; throw new Error(`Git command failed: ${(error as Error).message}`, { cause: error }); }
}

export async function repositoryRoot(cwd = process.cwd()): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

function parsePatch(patch: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  let originalPath = "";
  let oldLine = 0;
  let newLine = 0;
  const finish = (): void => {
    if (!current) return;
    if (!current.path) current.path = originalPath;
    if (current.status !== "renamed") delete current.oldPath;
    if (current.path) files.push(current);
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      current = { path: "", status: "modified", additions: [], deletions: [] };
      originalPath = "";
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) { current.status = "renamed"; current.oldPath = line.slice(12); }
    else if (line.startsWith("rename to ")) current.path = line.slice(10);
    else if (line.startsWith("Binary files ")) {
      current.status = "binary";
      const match = /^Binary files a\/(.*) and b\/(.*) differ$/.exec(line);
      if (match?.[2]) current.path = match[2];
    }
    else if (line.startsWith("--- ")) originalPath = (line.slice(4).split("\t")[0] ?? "").replace(/^a\//, "");
    else if (line.startsWith("+++ ") && line !== "+++ /dev/null") current.path = (line.slice(4).split("\t")[0] ?? "").replace(/^b\//, "");
    else if (line.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) { oldLine = Number(match[1]); newLine = Number(match[2]); }
    } else if (line.startsWith("+") && !line.startsWith("+++")) current.additions.push({ line: newLine++, text: line.slice(1) });
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions.push({ line: oldLine++, text: line.slice(1) });
    else if (line.startsWith(" ")) { oldLine++; newLine++; }
  }
  finish();
  return files;
}

export async function gitChanges(cwd: string, options: DiffOptions = {}): Promise<GitChangeSet> {
  const root = await repositoryRoot(cwd);
  const args = ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=0"];
  let baseline = "HEAD";
  if (options.staged) args.push("--cached");
  else if (options.commit) { args.push(`${options.commit}^`, options.commit); baseline = `${options.commit}^`; }
  else if (options.base) { args.push(`${options.base}...HEAD`); baseline = options.base; }
  else args.push("HEAD");
  const files = parsePatch(await git(root, args));
  if (!options.staged && !options.commit && !options.base) {
    const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const path of untracked) {
      const text = await readFile(join(root, path), "utf8").catch(() => "");
      files.push({ path, status: "added", additions: text.split("\n").map((value, index) => ({ line: index + 1, text: value })), deletions: [] });
    }
  }
  return { root, baseline, files };
}

export async function fileAt(root: string, path: string, side: "before" | "after", options: DiffOptions = {}): Promise<string | undefined> {
  let spec: string;
  if (side === "before") spec = options.commit ? `${options.commit}^:${path}` : options.base ? `${options.base}:${path}` : `HEAD:${path}`;
  else if (options.staged) spec = `:${path}`;
  else if (options.commit) spec = `${options.commit}:${path}`;
  else if (options.base) spec = `HEAD:${path}`;
  else return readFile(join(root, path), "utf8").catch(() => undefined);
  const output = await git(root, ["show", spec], true);
  return output || undefined;
}
