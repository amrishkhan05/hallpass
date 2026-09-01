import { matchesAny } from "../utils.js";
import type { Detection, DetectorContext } from "./types.js";

export function detectPaths({ rule, files }: DetectorContext): Detection[] {
  return files.filter((file) => matchesAny(file.path, rule.detector.paths)).map((file) => ({ category: rule.detector.type.replaceAll("-", "."), message: `${rule.title}: ${file.path}`, file, evidence: { status: file.status }, remediation: "Revert the change or obtain a human approval." }));
}

export function detectDeletedTests({ rule, files }: DetectorContext): Detection[] {
  return files.filter((file) => file.status === "deleted" && /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(file.path)).map((file) => ({ category: "test.deleted", message: `${rule.title}: ${file.path}`, file }));
}

export function detectMaxFiles({ rule, files }: DetectorContext): Detection[] {
  const limit = rule.detector.limit ?? Infinity;
  return files.length > limit ? [{ category: "scope.excessive", message: `${files.length} changed files exceeds the limit of ${limit}.`, evidence: { files: files.length, limit } }] : [];
}

export function detectMaxLoc({ rule, files }: DetectorContext): Detection[] {
  const limit = rule.detector.limit ?? Infinity;
  const changedLoc = files.reduce((sum, file) => sum + file.additions.length + file.deletions.length, 0);
  return changedLoc > limit ? [{ category: "scope.excessive", message: `${changedLoc} changed lines exceeds the limit of ${limit}.`, evidence: { changedLoc, limit } }] : [];
}
