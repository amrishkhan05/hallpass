import type { DetectorType } from "../core/types.js";
import { detectRequiredCommand } from "./completion.js";
import { configModificationDetector } from "./config.js";
import { detectDependencies } from "./dependencies.js";
import { detectDeletedTests, detectMaxFiles, detectMaxLoc, detectPaths } from "./files.js";
import { gitOperationDetector } from "./git.js";
import { detectImports, detectRequiredImports, detectTypeScript } from "./source.js";
import { workflowModificationDetector } from "./workflow.js";
import type { Detector } from "./types.js";

export const detectors: Partial<Record<DetectorType, Detector>> = {
  "protected-file": detectPaths,
  "forbidden-path": detectPaths,
  "generated-file": detectPaths,
  "governance-modification": detectPaths,
  "test-deletion": detectDeletedTests,
  "max-changed-files": detectMaxFiles,
  "max-changed-loc": detectMaxLoc,
  "typescript-any": detectTypeScript,
  "ts-ignore": detectTypeScript,
  "eslint-disable": detectTypeScript,
  "forbidden-import": detectImports,
  "required-import": detectRequiredImports,
  "dependency-change": detectDependencies,
  "forbidden-dependency": detectDependencies,
  "required-command": detectRequiredCommand,
  "git-operation": gitOperationDetector,
  "config-modification": configModificationDetector,
  "workflow-modification": workflowModificationDetector,
};

export type { Detection, DetectorContext } from "./types.js";
