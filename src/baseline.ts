import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const pathFor = (root: string): string => join(root, ".hallpass", "baseline.json");

export async function baselineFingerprints(root: string): Promise<string[]> {
  return readFile(pathFor(root), "utf8").then((text) => JSON.parse(text) as string[]).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

export async function saveBaseline(root: string, fingerprints: string[]): Promise<void> {
  await mkdir(join(root, ".hallpass"), { recursive: true });
  await writeFile(pathFor(root), `${JSON.stringify([...new Set(fingerprints)].sort(), null, 2)}\n`);
}

export async function clearBaseline(root: string): Promise<void> {
  await unlink(pathFor(root)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}
