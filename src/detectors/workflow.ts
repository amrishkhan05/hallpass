import type { DetectorContext, Detection } from "./types.js";

/**
 * Detect policy violations in workflow/CI modifications.
 * 
 * Monitors changes to:
 * - GitHub Actions (.github/workflows/*.yml, .github/workflows/*.yaml)
 * - GitLab CI (.gitlab-ci.yml)
 * - CircleCI (.circleci/config.yml)
 * - Jenkins (Jenkinsfile, Jenkinsfile.*)
 */
export async function workflowModificationDetector(context: DetectorContext): Promise<Detection[]> {
    const { rule, changes } = context;

    if (rule.detector.type !== "workflow-modification") {
        return [];
    }

    const detections: Detection[] = [];
    const monitoredPaths = rule.detector.paths ?? [
        ".github/workflows/**",
        ".gitlab-ci.yml",
        ".gitlab-ci.yaml",
        ".circleci/config.yml",
        ".circleci/config.yaml",
        "Jenkinsfile",
        "Jenkinsfile.*",
    ];

    for (const file of changes.files) {
        // Check if file matches any monitored path pattern
        const isMonitored = monitoredPaths.some(pattern => {
            const regexPattern = pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
            return new RegExp(`^${regexPattern}$`).test(file.path);
        });

        if (!isMonitored) continue;

        // Categorize by CI/CD platform
        let platform = "ci-cd";
        if (/\.github\/workflows/.test(file.path)) {
            platform = "github-actions";
        } else if (/\.gitlab-ci\.ya?ml/.test(file.path)) {
            platform = "gitlab-ci";
        } else if (/\.circleci/.test(file.path)) {
            platform = "circleci";
        } else if (/Jenkinsfile/.test(file.path)) {
            platform = "jenkins";
        }

        // Check for potentially problematic changes
        const additions = file.additions.map(d => d.text.toLowerCase()).join("\n");
        const hasNewStep = /^\s*-\s*(?:run|name|script):|^\s*steps:|^\s*jobs:/m.test(additions);
        const hasDisabledSecurityCheck = /skip|disable|ignore|bypass/i.test(additions);
        const hasRemovedGate = /approval|review|manual|gate/.test(file.deletions.map(d => d.text.toLowerCase()).join("\n"));

        if (file.status === "added" || file.status === "modified" || file.status === "deleted") {
            const category = file.status === "added" ? "workflow.added"
                : file.status === "deleted" ? "workflow.deleted"
                    : hasNewStep ? "workflow.step.added"
                        : hasDisabledSecurityCheck ? "workflow.security.modified"
                            : hasRemovedGate ? "workflow.gate.removed"
                                : "workflow.modified";

            detections.push({
                category: `${platform}.${category}`,
                message: `Workflow modification on ${platform}: ${file.path} (${file.status})`,
                file,
                evidence: {
                    filePath: file.path,
                    platform,
                    status: file.status,
                    linesAdded: file.additions.length,
                    linesRemoved: file.deletions.length,
                    hasNewStep,
                    hasDisabledSecurityCheck,
                    hasRemovedGate,
                },
                remediation: `Review and approve workflow changes to ${file.path} according to CI/CD policy.`,
            });
        }
    }

    return detections;
}
