import { createHash } from "node:crypto";

export const fingerprint = (...values: unknown[]): string => createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16);

export function matchesGlob(path: string, glob: string): boolean {
  const value = glob.replaceAll("\\", "/");
  let source = "";
  for (let index = 0; index < value.length;) {
    if (value.slice(index, index + 3) === "**/") { source += "(?:.*/)?"; index += 3; }
    else if (value.slice(index, index + 2) === "**") { source += ".*"; index += 2; }
    else if (value[index] === "*") { source += "[^/]*"; index++; }
    else if (value[index] === "?") { source += "[^/]"; index++; }
    else { source += /[.+^${}()|[\]\\]/.test(value[index] ?? "") ? `\\${value[index]}` : value[index]; index++; }
  }
  return new RegExp(`^${source}$`).test(path.replaceAll("\\", "/"));
}

export const matchesAny = (path: string, patterns: string[] = []): boolean => patterns.some((pattern) => matchesGlob(path, pattern));
