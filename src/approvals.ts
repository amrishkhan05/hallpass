import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fingerprint } from "./utils.js";

export interface Approval {
  id: string;
  rule: string;
  reason: string;
  timestamp: string;
  expires?: string;
  scope?: string;
  mode: "permanent" | "single-use";
  consumedAt?: string;
}

const pathFor = (root: string): string => join(root, ".hallpass", "approvals.json");

export async function approvals(root: string): Promise<Approval[]> {
  try {
    const raw = JSON.parse(await readFile(pathFor(root), "utf8")) as Array<Record<string, unknown>>;
    return raw.map((item) => ({
      id: String(item.id ?? fingerprint(item.rule, item.reason, item.timestamp)),
      rule: String(item.rule),
      reason: String(item.reason),
      timestamp: String(item.timestamp),
      ...(item.expires ? { expires: String(item.expires) } : {}),
      ...(item.scope ? { scope: String(item.scope) } : {}),
      mode: item.mode === "single-use" ? "single-use" : "permanent",
      ...(item.consumedAt ? { consumedAt: String(item.consumedAt) } : {}),
    }));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export async function addApproval(root: string, approval: Omit<Approval, "id">): Promise<Approval> {
  const current = await approvals(root);
  const id = fingerprint(approval.rule, approval.reason, approval.timestamp, approval.scope ?? "");
  const record: Approval = { ...approval, id };
  await mkdir(join(root, ".hallpass"), { recursive: true });
  await writeFile(pathFor(root), `${JSON.stringify([...current, record], null, 2)}\n`);
  return record;
}

export async function consumeApproval(root: string, id: string): Promise<boolean> {
  const current = await approvals(root);
  const approval = current.find((item) => item.id === id);
  if (!approval || approval.mode !== "single-use") return false;
  if (approval.consumedAt) return false;
  approval.consumedAt = new Date().toISOString();
  await writeFile(pathFor(root), `${JSON.stringify(current, null, 2)}\n`);
  return true;
}

export const isApproved = (items: Approval[], rule: string, file?: string): boolean => items.some((item) => {
  if (item.rule !== rule) return false;
  if (item.expires && new Date(item.expires) <= new Date()) return false;
  if (item.scope && item.scope !== file) return false;
  if (item.mode === "single-use" && item.consumedAt) return false;
  return true;
});
