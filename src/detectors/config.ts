import type { DetectorContext, Detection } from "./types.js";

/**
 * Detect policy violations in configuration file modifications.
 * 
 * Monitors changes to:
 * - Governance files (AGENTS.md, CLAUDE.md, hallpass.config.yml)
 * - Build/package files (package.json, tsconfig.json, jest.config.js)
 * - CI/CD files (.github/workflows, .gitlab-ci.yml, .circleci/config.yml)
 */
export async function configModificationDetector(context: DetectorContext): Promise<Detection[]> {
    const { rule, changes } = context;

    if (rule.detector.type !== "config-modification") {
        return [];
    }

    const detections: Detection[] = [];
    const monitoredPaths = rule.detector.paths ?? [
        "AGENTS.md",
        "CLAUDE.md",
        ".cursor/**",
        "hallpass.config.yml",
        "hallpass.config.json",
        "package.json",
        "tsconfig.json",
        "jest.config.*",
        "webpack.config.*",
        ".eslintrc*",
        ".prettierrc*",
        ".github/workflows/**",
        ".gitlab-ci.yml",
        ".circleci/**",
    ];

    for (const file of changes.files) {
        // Check if file matches any monitored path pattern
        const isMonitored = monitoredPaths.some(pattern => {
            const regexPattern = pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
            return new RegExp(`^${regexPattern}$`).test(file.path);
        });

        if (!isMonitored) continue;

        // Categorize by config type
        let configType = "config";
        if (/AGENTS\.md|CLAUDE\.md|hallpass/.test(file.path)) {
            configType = "governance";
        } else if (/package\.json|tsconfig\.json|jest\.config|webpack\.config|\.eslintrc|\.prettierrc/.test(file.path)) {
            configType = "build";
        } else if (/workflows|gitlab-ci|circleci/.test(file.path)) {
            configType = "ci-cd";
        }

        // Create detection for any modification to monitored config files
        if (file.status === "added" || file.status === "modified" || file.status === "deleted") {
            detections.push({
                category: `config.${configType}.${file.status}`,
                message: `${configType.toUpperCase()} file ${file.status}: ${file.path}`,
                file,
                evidence: {
                    filePath: file.path,
                    configType,
                    status: file.status,
                    linesAdded: file.additions.length,
                    linesRemoved: file.deletions.length,
                },
                remediation: `Review and approve changes to ${file.path} according to policy.`,
            });
        }
    }

    return detections;
}
