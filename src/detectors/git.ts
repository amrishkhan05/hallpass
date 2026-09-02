import type { DetectorContext, Detection } from "./types.js";

/**
 * Detect policy violations in git operations.
 * 
 * Enforces restrictions on:
 * - Destructive git operations (reset --hard, clean -f)
 * - Force pushes to protected branches
 * - Branch protection violations
 */
export async function gitOperationDetector(context: DetectorContext): Promise<Detection[]> {
    const { rule, changes } = context;

    if (rule.detector.type !== "git-operation") {
        return [];
    }

    const detections: Detection[] = [];
    const commands = rule.detector.commands ?? [];

    // Check if any files indicate git operations (git internals, reflog, etc.)
    const gitFiles = changes.files.filter(file => file.path.startsWith(".git/"));

    if (!gitFiles.length) {
        return [];
    }

    // Detect destructive operations based on patterns
    const destructivePatterns = [
        /git\s+reset\s+--hard/,
        /git\s+clean\s+-[^\s]*f/,
        /git\s+checkout\s+--/,
    ];

    // Check for force pushes (indicated by rewritten refs)
    const forcePushPatterns = [
        /git\s+push\s+(?:--force|-f)/,
    ];

    // Check for branch modifications on protected branches
    const protectedBranchPatterns = /(?:main|master|develop|staging|production)/;

    // Note: Git operations typically happen through shell commands,
    // so detection here is supplementary. The shell detector (evaluateShell)
    // provides the primary enforcement.

    for (const cmd of commands) {
        if (destructivePatterns.some(p => p.test(cmd))) {
            detections.push({
                category: "git.destructive",
                message: `Destructive git operation: ${cmd}`,
                evidence: { command: cmd, pattern: "destructive" },
                remediation: "Use a non-destructive git operation or request approval.",
            });
        }

        if (forcePushPatterns.some(p => p.test(cmd))) {
            // Check if pushing to a protected branch
            const branchMatch = cmd.match(/(?:push|origin)\s+([^\s:]+)/);
            const branch = branchMatch?.[1];
            if (branch && protectedBranchPatterns.test(branch)) {
                detections.push({
                    category: "git.force-push",
                    message: `Force push to protected branch: ${branch}`,
                    evidence: { command: cmd, branch, pattern: "force-push" },
                    remediation: "Create a new branch or request approval for force push.",
                });
            }
        }
    }

    return detections;
}
