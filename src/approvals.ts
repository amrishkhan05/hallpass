import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Approval { rule: string; reason: string; timestamp: string; expires?: string; scope?: string }
const pathFor = (root: string): string => join(root, ".hallpass", "approvals.json");

export async function approvals(root: string): Promise<Approval[]> {
  try { return JSON.parse(await readFile(pathFor(root), "utf8")) as Approval[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export async function addApproval(root: string, approval: Approval): Promise<void> {
  const current = await approvals(root);
  await mkdir(join(root, ".hallpass"), { recursive: true });
  await writeFile(pathFor(root), `${JSON.stringify([...current, approval], null, 2)}\n`, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    await writeFile(pathFor(root), `${JSON.stringify([...current, approval], null, 2)}\n`);
  });
}

export const isApproved = (items: Approval[], rule: string, file?: string): boolean => items.some((item) => item.rule === rule && (!item.expires || new Date(item.expires) > new Date()) && (!item.scope || item.scope === file));
