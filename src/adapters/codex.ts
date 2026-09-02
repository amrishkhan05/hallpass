/**
 * Codex-specific event normalization
 * Handles GitHub's Codex model (backend for Copilot)
 * Limited direct integration - mainly provides semantic context
 */
import type { HallpassEvent } from "../core/types.js";
import { buildAction, extractPackageInfo, extractGitSubcommand, isGitCommand, isPackageManagerCommand, categorizeGitCommand } from "./helpers.js";

export interface CodexPayload {
    model?: string;
    completion_context?: Record<string, unknown>;
    search_context?: Record<string, unknown>;
    code_snippet?: string;
    explanation?: string;
    language?: string;
    file_path?: string;
    command?: string;
}

/**
 * Normalize Codex payload with semantic context
 * Note: Codex has limited direct action integration
 * Most events flow through Copilot client or other adapters
 */
export function normalizeCodexEvent(payload: CodexPayload, baseId: string, baseTime: number, cwd: string): HallpassEvent {
    const baseTimestamp = new Date(baseTime).toISOString();
    const command: string = String(payload.command ?? "");
    const completionContext = payload.completion_context || {};
    const searchContext = payload.search_context || {};
    const codeSnippet = payload.code_snippet || "";
    const explanation = payload.explanation || "";
    const language = payload.language || "unknown";

    // Handle explicit command if provided
    if (command) {
        if (isGitCommand(command)) {
            const { subcommand, ref } = extractGitSubcommand(command);
            const gitCategory = categorizeGitCommand(subcommand);
            return {
                id: baseId,
                type: "shell.execute",
                timestamp: baseTimestamp,
                adapter: "codex",
                workingDirectory: cwd,
                command,
                metadata: { command, isGit: true, subcommand },
                action: buildAction(gitCategory, { target: ref ?? command, intent: subcommand, impact: "remote" }),
            };
        }

        if (isPackageManagerCommand(command)) {
            const pkgInfo = extractPackageInfo(command);
            const pkg = pkgInfo.package || "";
            const isAdd = pkgInfo.action === "add";
            return {
                id: baseId,
                type: "shell.execute",
                timestamp: baseTimestamp,
                adapter: "codex",
                workingDirectory: cwd,
                command,
                metadata: { command, isPackageManager: true, package: pkg },
                action: buildAction(isAdd ? "dependency.add" : "dependency.remove", { target: pkg, intent: isAdd ? "install" : "uninstall", impact: "shared" }),
            };
        }

        // Generic shell command
        return {
            id: baseId,
            type: "shell.execute",
            timestamp: baseTimestamp,
            adapter: "codex",
            workingDirectory: cwd,
            command,
            metadata: { command },
            action: buildAction("shell.command", { target: command.split(/\s+/)[0] ?? "", intent: "execute", impact: "local" }),
        };
    }

    // Codex primarily provides semantic insights
    // Events detected from actual tool invocations are handled upstream

    return {
        id: baseId,
        type: "tool.action",
        timestamp: baseTimestamp,
        adapter: "codex",
        workingDirectory: cwd,
        metadata: {
            model: "codex",
            semanticContext: {
                completionContext,
                searchContext,
                language,
                snippetLength: codeSnippet.length,
            },
            explanation,
            note: "Codex provides semantic context. Direct actions handled by client adapters (Claude, Cursor, Copilot).",
        },
    };
}
