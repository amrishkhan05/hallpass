import type { ChangedFile, GitChangeSet, HallpassRule } from "../core/types.js";
import type { DiffOptions } from "../git.js";

export interface Detection { category: string; message: string; file?: ChangedFile; line?: number; evidence?: unknown; remediation?: string }
export interface DetectorContext { root: string; rule: HallpassRule; changes: GitChangeSet; files: ChangedFile[]; options: DiffOptions }
export type Detector = (context: DetectorContext) => Detection[] | Promise<Detection[]>;
