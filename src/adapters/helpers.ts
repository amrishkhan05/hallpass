import type { NormalizedAction, ActionCategory } from "../core/types.js";

/** Build NormalizedAction with exactOptionalPropertyTypes safety */
export function buildAction(
    category: ActionCategory,
    options?: { target?: string; intent?: string; impact?: "local" | "remote" | "shared" | "governance"; subtype?: string }
): NormalizedAction {
    const action: NormalizedAction = { category };
    if (options?.target) action.target = options.target;
    if (options?.intent) action.intent = options.intent;
    if (options?.impact) action.impact = options.impact;
    if (options?.subtype) action.subtype = options.subtype;
    return action;
}

export function isGitCommand(command: string): boolean {
    return /^\s*git\s+/.test(command);
}

export function isPackageManagerCommand(command: string): boolean {
    return /^\s*(?:npm|yarn|pnpm|cargo|pip|poetry|bundle|brew|apt|yum|pacman)\s+/.test(command);
}

export function isConfigFile(path: string): boolean {
    return /(?:AGENTS\.md|CLAUDE\.md|package\.json|tsconfig\.json|jest\.config|webpack\.config|\.eslintrc|\.prettierrc|hallpass\.config|\.github\/workflows|\.gitlab-ci\.yml|\.circleci|\.cursor\/rules|Jenkinsfile)/.test(path);
}

export function isGovernanceFile(path: string): boolean {
    return /^(?:AGENTS\.md|CLAUDE\.md|hallpass\.config\.yml)/.test(path);
}

export function categorizeGitCommand(subcommand: string): "git.commit" | "git.push" | "git.branch" | "git.merge" {
    if (subcommand === "commit") return "git.commit";
    if (subcommand === "push") return "git.push";
    if (subcommand === "branch") return "git.branch";
    return "git.merge";
}

/** Build the write/create action for a file, classifying config vs governance targets */
export function buildFileWriteAction(filePath: string, intent: "create" | "modify", baseCategory: "file.create" | "file.modify"): NormalizedAction {
    const isConfig = isConfigFile(filePath);
    const isGovernance = isGovernanceFile(filePath);
    return buildAction(isConfig ? "config.modify" : baseCategory, {
        target: filePath,
        intent,
        impact: isGovernance ? "governance" : isConfig ? "shared" : "local",
        ...(isGovernance || isConfig ? { subtype: isGovernance ? "governance" : "build-config" } : {}),
    });
}

export function extractGitSubcommand(command: string): { subcommand: string; ref?: string; remote?: string } {
    const match = command.match(/git\s+(\w+)/);
    const subcommand = match?.[1] ?? "unknown";
    const refMatch = command.match(/(?:checkout|push|pull|merge|rebase)\s+(?:--force|-f)?\s*([^\s]+)?/);
    const ref = refMatch?.[1];
    const remoteMatch = command.match(/(?:push|pull)\s+(\w+)/);
    const remote = remoteMatch?.[1];
    return { subcommand, ...(ref && { ref }), ...(remote && { remote }) };
}

export function extractPackageInfo(command: string): { manager: string; action: string; package?: string } {
    const managerMatch = command.match(/^\s*(npm|yarn|pnpm|cargo|pip|poetry|bundle|brew)/);
    const manager = managerMatch?.[1] ?? "npm";
    const actionMatch = command.match(/(?:install|add|uninstall|remove|update|upgrade|i)\s+(.+)?/);
    const action = command.includes("install") || command.includes("add") ? "add" : "remove";
    const pkg = actionMatch?.[1]?.split(/\s+/)[0];
    return { manager, action, ...(pkg && { package: pkg }) };
}
